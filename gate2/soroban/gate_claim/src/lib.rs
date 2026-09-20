//! Gate 2.0 — GateClaim: the CCTP claim contract ("Proof of Migration").
//!
//! DIRECTIVE 2.0 section 5.2, implemented line by line:
//!   1. parse the CCTP v1 message and verify source domain, destination
//!      domain 27, `mintRecipient == destinationCaller == self`, expected
//!      burn token;
//!   2. hand the message to Circle's MessageTransmitter (`receive_message`);
//!      replay is impossible twice over: CCTP consumes the nonce there and
//!      this contract additionally stores the message hash;
//!   3. read the recipient out of the hook, move the minted USDC to them
//!      (6 -> 7 decimals is measured, not assumed: the balance delta of this
//!      contract around `receive_message` is what Stellar actually minted);
//!   4. mint the soulbound Migration Proof NFT to the same recipient - the
//!      contract has no transfer and no approve, by construction;
//!   5. update the recipient's MigrationSummary, all in one atomic call.
//!
//! No admin, no upgrade path, no custody: the contract holds tokens only
//! inside the claim transaction, and the balance it forwards is the balance
//! it just received. The trust root is Circle's Iris attestation, verified
//! inside MessageTransmitter; this contract never pretends otherwise.
#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractimpl, contracttype, Address,
    Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

/// CCTP message header: 4+4+4+8+32+32+32 = 116 bytes before the body.
pub const HEADER: usize = 116;
/// BurnMessage fixed part: version 4 + burnToken 32 + mintRecipient 32 +
/// amount 32 + messageSender 32 = 132 bytes before hookData.
pub const BODY_FIXED: usize = 132;
/// hookData: 24 zero bytes + u32 version + u32 recipient length + strkey.
pub const HOOK_PAD: usize = 24;
pub const STRKEY_LEN: u32 = 56;
/// Stellar testnet is CCTP domain 27.
const DOMAIN_STELLAR_TESTNET: u32 = 27;

const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_EXTEND: u32 = 400_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GateError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    MessageTooShort = 3,
    BadMessageVersion = 4,
    SourceDomainNotAllowed = 5,
    WrongDestinationDomain = 6,
    NotDestinationCaller = 7,
    NotMintRecipient = 8,
    WrongBurnToken = 9,
    AmountOverflow = 10,
    SeqOverflow = 16,
    BadHook = 11,
    MessageAlreadyClaimed = 12,
    NothingMinted = 13,
    DecimalsNotExact = 14,
    /// An environment address has no 32-byte wire form (muxed M... addresses).
    AddrForm = 15,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationSummary {
    pub total_usdc: i128, // 6 decimals
    pub claim_count: u32,
    pub first_ledger: u32,
    pub last_ledger: u32,
    pub sources: Vec<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationProof {
    pub id: u64,
    pub owner: Address,
    pub source_domain: u32,
    pub nonce: u64,
    pub amount_6: i128,
    pub fee_executed_6: i128,
    pub ledger: u32,
    pub message_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftMeta {
    pub source_domain: u32,
    pub nonce: u64,
    pub amount_6: i128,
    pub fee_executed_6: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Init,
    Mig(Address),
    NftOwner(u64),
    Proof(u64),
    Meta(u64),
    Owner(Address),
    MsgHash(BytesN<32>),
    Seq,
}

#[contracttype]
#[derive(Clone)]
pub struct Init {
    pub mt: Address,
    pub usdc: Address,
    pub burn_token: BytesN<32>,
    pub allowed: Vec<u32>,
}

pub fn read_u32(b: &Bytes, at: usize) -> Result<u32, GateError> {
    if at + 4 > b.len() as usize {
        return Err(GateError::MessageTooShort);
    }
    let mut v: u32 = 0;
    for i in 0..4 {
        v = (v << 8) | u32::from(b.get((at + i) as u32).ok_or(GateError::MessageTooShort)?);
    }
    Ok(v)
}

pub fn read_u64(b: &Bytes, at: usize) -> Result<u64, GateError> {
    if at + 8 > b.len() as usize {
        return Err(GateError::MessageTooShort);
    }
    let mut v: u64 = 0;
    for i in 0..8 {
        v = (v << 8) | u64::from(b.get((at + i) as u32).ok_or(GateError::MessageTooShort)?);
    }
    Ok(v)
}

pub fn read_bytes32(env: &Env, b: &Bytes, at: usize) -> Result<BytesN<32>, GateError> {
    if at + 32 > b.len() as usize {
        return Err(GateError::MessageTooShort);
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = b.get((at + i) as u32).ok_or(GateError::MessageTooShort)?;
    }
    Ok(BytesN::from_array(env, &out))
}

pub fn payload32(p: AddressPayload) -> BytesN<32> {
    match p {
        AddressPayload::AccountIdPublicKeyEd25519(b) => b,
        AddressPayload::ContractIdHash(b) => b,
    }
}

/// The 32 byte wire form of an address, which is what CCTP messages carry:
/// the contract hash for C... addresses, the ed25519 key for G... ones.
pub fn addr32(a: &Address) -> Result<BytesN<32>, GateError> {
    AddressPayload::from_address(a).map(payload32).ok_or(GateError::AddrForm)
}

pub fn self32(env: &Env) -> Result<BytesN<32>, GateError> {
    addr32(&env.current_contract_address())
}

#[contract]
pub struct GateClaim;

#[contractimpl]
impl GateClaim {
    /// Called once, by the deployer, with the addresses read out of
    /// deployments/testnet-2.0.json. There is no admin afterwards: nothing
    /// in this contract can change these values again.
    pub fn initialize(env: Env, mt: Address, usdc: Address, burn_token: BytesN<32>, allowed: Vec<u32>) -> Result<(), GateError> {
        if env.storage().instance().has(&DataKey::Init) {
            return Err(GateError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Init, &Init { mt, usdc, burn_token, allowed });
        env.storage().instance().set(&DataKey::Seq, &0u64);
        Ok(())
    }

    /// Consume one CCTP message: verify, receive, forward, mint the proof,
    /// update the summary. One atomic transaction, no custody left behind.
    pub fn claim(env: Env, message: Bytes, attestation: Bytes) -> Result<u64, GateError> {
        let init: Init = env.storage().instance().get(&DataKey::Init).ok_or(GateError::NotInitialized)?;
        if message.len() < (HEADER + BODY_FIXED) as u32 {
            return Err(GateError::MessageTooShort);
        }
        if read_u32(&message, 0)? != 1 {
            return Err(GateError::BadMessageVersion);
        }
        let source_domain = read_u32(&message, 4)?;
        if !init.allowed.contains(source_domain) {
            return Err(GateError::SourceDomainNotAllowed);
        }
        if read_u32(&message, 8)? != DOMAIN_STELLAR_TESTNET {
            return Err(GateError::WrongDestinationDomain);
        }
        let me = self32(&env)?;
        if read_bytes32(&env, &message, 84)? != me {
            return Err(GateError::NotDestinationCaller);
        }
        // BurnMessage: version, burnToken, mintRecipient, amount(u256),
        // messageSender, hookData.
        let body = message.slice(HEADER as u32..);
        if read_u32(&body, 0)? != 1 {
            return Err(GateError::BadMessageVersion);
        }
        if read_bytes32(&env, &body, 4)? != init.burn_token {
            return Err(GateError::WrongBurnToken);
        }
        if read_bytes32(&env, &body, 36)? != me {
            return Err(GateError::NotMintRecipient);
        }
        for i in 68u32..92 {
            if body.get(i).ok_or(GateError::MessageTooShort)? != 0 {
                return Err(GateError::AmountOverflow);
            }
        }
        let burned_6 = read_u64(&body, 92)? as i128;
        let hook = body.slice(BODY_FIXED as u32..);
        let recipient = parse_hook(&hook)?;

        let hash: BytesN<32> = env.crypto().sha256(&message).to_bytes();
        let hash_key = DataKey::MsgHash(hash.clone());
        if env.storage().persistent().has(&hash_key) {
            return Err(GateError::MessageAlreadyClaimed);
        }

        let usdc = soroban_sdk::token::Client::new(&env, &init.usdc);
        let here = env.current_contract_address();
        let before = usdc.balance(&here);
        // Circle verifies the Iris attestation and consumes the nonce here;
        // a bad attestation traps inside this call and takes the whole
        // transaction with it, so nothing below can half-happen.
        let accepted: bool = env.invoke_contract(
            &init.mt,
            &Symbol::new(&env, "receive_message"),
            soroban_sdk::vec![&env, message.clone().into_val(&env), attestation.into_val(&env)],
        );
        if !accepted {
            return Err(GateError::NothingMinted);
        }
        let minted_7 = usdc.balance(&here) - before;
        if minted_7 <= 0 {
            return Err(GateError::NothingMinted);
        }
        if minted_7 % 10 != 0 {
            return Err(GateError::DecimalsNotExact);
        }
        let amount_6 = minted_7 / 10;
        let fee_executed_6 = burned_6 - amount_6;

        // The contract keeps nothing: what arrived leaves in the same call.
        usdc.transfer(&here, &recipient, &minted_7);

        env.storage().persistent().set(&hash_key, &());

        let ledger = env.ledger().sequence();
        let nonce = read_u64(&message, 12)?;
        let id: u64 = env.storage().instance().get(&DataKey::Seq).ok_or(GateError::NotInitialized)?;
        let next = id.checked_add(1).ok_or(GateError::SeqOverflow)?;
        env.storage().instance().set(&DataKey::Seq, &next);

        let meta = NftMeta { source_domain, nonce, amount_6, fee_executed_6, ledger };
        env.storage().persistent().set(&DataKey::Meta(id), &meta);
        env.storage().persistent().set(&DataKey::NftOwner(id), &recipient);
        let mut ids: Vec<u64> = env.storage().persistent().get(&DataKey::Owner(recipient.clone())).unwrap_or(Vec::new(&env));
        ids.push_back(id);
        env.storage().persistent().set(&DataKey::Owner(recipient.clone()), &ids);
        env.storage().persistent().set(
            &DataKey::Proof(id),
            &MigrationProof { id, owner: recipient.clone(), source_domain, nonce, amount_6, fee_executed_6, ledger, message_hash: hash },
        );

        let mut sum: MigrationSummary = env.storage().persistent().get(&DataKey::Mig(recipient.clone())).unwrap_or(MigrationSummary {
            total_usdc: 0,
            claim_count: 0,
            first_ledger: ledger,
            last_ledger: ledger,
            sources: Vec::new(&env),
        });
        sum.total_usdc = sum.total_usdc.checked_add(amount_6).ok_or(GateError::AmountOverflow)?;
        sum.claim_count = sum.claim_count.checked_add(1).ok_or(GateError::AmountOverflow)?;
        sum.last_ledger = ledger;
        if !sum.sources.contains(source_domain) {
            sum.sources.push_back(source_domain);
        }
        let mig_key = DataKey::Mig(recipient.clone());
        env.storage().persistent().set(&mig_key, &sum);
        env.storage().persistent().extend_ttl(&mig_key, BUMP_THRESHOLD, BUMP_EXTEND);
        let owner_key = DataKey::Owner(recipient.clone());
        env.storage().persistent().extend_ttl(&owner_key, BUMP_THRESHOLD, BUMP_EXTEND);

        env.events().publish((soroban_sdk::symbol_short!("claim"), recipient.clone(), id), amount_6);
        Ok(id)
    }

    // ---- the query surface any Soroban contract may build on (fixed) ----

    pub fn get_migration(env: Env, owner: Address) -> Option<MigrationSummary> {
        env.storage().persistent().get(&DataKey::Mig(owner))
    }

    pub fn has_migrated_at_least(env: Env, owner: Address, min_usdc: i128) -> bool {
        match env.storage().persistent().get::<_, MigrationSummary>(&DataKey::Mig(owner)) {
            Some(s) => s.total_usdc >= min_usdc,
            None => false,
        }
    }

    pub fn get_proof(env: Env, id: u64) -> Option<MigrationProof> {
        env.storage().persistent().get(&DataKey::Proof(id))
    }

    pub fn get_meta(env: Env, id: u64) -> Option<NftMeta> {
        env.storage().persistent().get(&DataKey::Meta(id))
    }

    pub fn owner_of(env: Env, id: u64) -> Option<Address> {
        env.storage().persistent().get(&DataKey::NftOwner(id))
    }

    pub fn proofs_of(env: Env, owner: Address) -> Vec<u64> {
        env.storage().persistent().get(&DataKey::Owner(owner)).unwrap_or(Vec::new(&env))
    }

    /// Permissionless TTL upkeep: anyone can keep a migration record alive,
    /// forever, without asking anybody. Proven by the ttl test.
    pub fn bump(env: Env, owner: Address) {
        let mig = DataKey::Mig(owner.clone());
        if env.storage().persistent().has(&mig) {
            env.storage().persistent().extend_ttl(&mig, BUMP_THRESHOLD, BUMP_EXTEND);
        }
        let own = DataKey::Owner(owner.clone());
        if let Some(ids) = env.storage().persistent().get::<_, Vec<u64>>(&own) {
            env.storage().persistent().extend_ttl(&own, BUMP_THRESHOLD, BUMP_EXTEND);
            for id in ids.iter() {
                let pk = DataKey::Proof(id);
                if env.storage().persistent().has(&pk) {
                    env.storage().persistent().extend_ttl(&pk, BUMP_THRESHOLD, BUMP_EXTEND);
                }
                let mk = DataKey::Meta(id);
                if env.storage().persistent().has(&mk) {
                    env.storage().persistent().extend_ttl(&mk, BUMP_THRESHOLD, BUMP_EXTEND);
                }
                let nk = DataKey::NftOwner(id);
                if env.storage().persistent().has(&nk) {
                    env.storage().persistent().extend_ttl(&nk, BUMP_THRESHOLD, BUMP_EXTEND);
                }
            }
        }
    }
}

/// hookData = 24 zero bytes + u32 version(0) + u32 strkey length + strkey.
/// A wrong hook is unrecoverable loss on the source side, so the shape is
/// checked here as well, and a claim whose hook names nobody is refused.
pub fn parse_hook(hook: &Bytes) -> Result<Address, GateError> {
    let len = hook.len() as usize;
    if len < HOOK_PAD + 8 {
        return Err(GateError::BadHook);
    }
    for i in 0..HOOK_PAD {
        if hook.get(i as u32).ok_or(GateError::BadHook)? != 0 {
            return Err(GateError::BadHook);
        }
    }
    if read_u32(hook, HOOK_PAD)? != 0 {
        return Err(GateError::BadHook);
    }
    let strkey_len = read_u32(hook, HOOK_PAD + 4)?;
    if strkey_len != STRKEY_LEN || len != HOOK_PAD + 8 + STRKEY_LEN as usize {
        return Err(GateError::BadHook);
    }
    let first = hook.get((HOOK_PAD + 8) as u32).ok_or(GateError::BadHook)?;
    if first != b'G' && first != b'C' {
        return Err(GateError::BadHook);
    }
    let s = hook.slice((HOOK_PAD + 8) as u32..len as u32);
    Ok(Address::from_string_bytes(&s))
}

// ------------------------------------------------------------------ tests
// Unit level: the MessageTransmitter is doubled by a mock that behaves like
// the real one for the questions these tests ask (attestation checked, nonce
// consumed once, mint to the message's mintRecipient). The testnet receipts
// for the same paths belong to F2/F3 and live in deployments/testnet-2.0.json,
// not here - a green unit suite is not a testnet receipt and is not written
// up as one.
