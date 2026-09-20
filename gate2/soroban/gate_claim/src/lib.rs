//! Gate 2.0 — GateClaim: the CCTP claim contract (DIRECTIVE 2.0, 5.2).
//!
//! Design G (D1, confirmed S1 + on-chain spec): `mintRecipient =
//! destinationCaller = this contract`, so only this contract can consume a
//! message. `claim` calls the real MessageTransmitter with the 3-argument
//! signature the deployed contract requires:
//!     receive_message(caller, message, attestation)
//! with `caller = self` (the destinationCaller binding Circle enforces).
//!
//! Flow, one atomic transaction:
//!   1. parse + verify the CCTP V2 message (Circle's documented format:
//!      148-byte header, packed BurnMessage V2 body):
//!      source domain allowed, destination 27,
//!      `mintRecipient == destinationCaller == self`, expected burn token,
//!      `messageSender == burn_router` (rule 9: only OUR router's burns);
//!   2. `MessageTransmitter.receive_message` — Circle verifies the Iris
//!      attestation and consumes the nonce (replay protection #1);
//!   3. replay protection #2: sha256(message) stored in a persistent set;
//!   4. parse the v1 hook (24 zero bytes | u32 version | u32 payload_len |
//!      payload: flags, relay_fee_cap, battery_amount, recipient, [name]);
//!   5. measure what actually arrived (the balance delta of this contract
//!      around receive_message — 6 -> 7 decimals is measured, not assumed);
//!   6. verify and distribute (all 6dp hook amounts x10 to 7dp):
//!        relay_fee  -> relayer  (0 when the user sends their own claim)
//!        battery    -> gate_battery.deposit(self, recipient, x)
//!        remainder  -> recipient (mod 0) | gate_ticket (mod 1)
//!   7. mint the soulbound Migration Proof NFT + MigrationSummary to the
//!      hook's recipient (the first recipient, whatever the mod).
//!
//! `relay_fee` is a CEILING (the hook's relay_fee_cap and MAX_RELAY_FEE are
//! both enforced); competition between relayers drives it down.
//!
//! No admin, no upgrade, no custody: the contract holds USDC only inside
//! the claim transaction and forwards exactly what it just received.
#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload,
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, vec, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, Vec,
};

/// CCTP V2 header, per Circle's documented "Message Format" (this is the
/// format the deployed testnet MessageTransmitter was spec-checked against):
///   0   version              u32  = 1
///   4   sourceDomain         u32
///   8   destinationDomain    u32
///  12   nonce                bytes32
///  44   sender               bytes32
///  76   recipient            bytes32  (= mintRecipient)
/// 108   destinationCaller    bytes32  (= this contract, design G)
/// 140  minFinalityThreshold  u32
/// 144  finalityThresholdExec u32
/// 148  -- packed BurnMessage V2 body --
/// 148  version               u32  = 1
/// 152  burnToken             bytes32
/// 184  mintRecipient         bytes32
/// 216  amount                u256 (6 decimals)
/// 248  messageSender         bytes32 (the BurnRouter, rule 9)
/// 280  maxFee                u256
/// 312  feeExecuted           u256
/// 344  expirationBlock       u256
/// 376  hookData              bytes
pub const OFF_VERSION: u32 = 0;
pub const OFF_SOURCE: u32 = 4;
pub const OFF_DEST: u32 = 8;
pub const OFF_NONCE: u32 = 12;
pub const OFF_SENDER: u32 = 44;
pub const OFF_RECIPIENT: u32 = 76;
pub const OFF_DEST_CALLER: u32 = 108;
pub const OFF_BODY_VERSION: u32 = 148;
pub const OFF_BURN_TOKEN: u32 = 152;
pub const OFF_MINT_RECIPIENT: u32 = 184;
pub const OFF_AMOUNT: u32 = 216;
pub const OFF_AMOUNT_LOW: u32 = 240;
pub const OFF_MSG_SENDER: u32 = 248;
pub const OFF_FEE_EXECUTED_LOW: u32 = 336;
pub const OFF_HOOK: u32 = 376;

/// hookData v1 (DIRECTIVE 5.1): 24 zero bytes | u32 version=1 |
/// u32 payload_len | payload { u8 flags | u128 relay_fee_cap (6dp) |
/// u128 battery_amount (6dp) | u8 len + recipient strkey | [u8 len + name] }.
const HOOK_PAD: u32 = 24;
/// v1 hook total size cap (Circle's hookData limit is 256 on most chains).
const HOOK_MAX: u32 = 256;
const STRKEY_MAX: u32 = 64;
const NAME_MAX: u32 = 24;

/// Hard ceiling for the relayer fee, 7 decimals (provisional, S8):
/// 10 USDC. The hook's relay_fee_cap is usually far lower.
pub const MAX_RELAY_FEE_7: i128 = 100_000_000;

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
    /// Rule 9: messageSender must be the bound BurnRouter.
    WrongMessageSender = 10,
    AmountOverflow = 11,
    BadHook = 12,
    HookTooLarge = 13,
    BadStarName = 14,
    NameTooLong = 15,
    SeqOverflow = 16,
    MessageAlreadyClaimed = 17,
    NothingMinted = 18,
    DecimalsNotExact = 19,
    RelayFeeAboveCap = 20,
    RelayFeeAboveMax = 21,
    FeesExceedMint = 22,
    /// An environment address has no 32-byte wire form.
    AddrForm = 23,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationSummary {
    /// Net USDC credited to this recipient across all claims (6 decimals).
    pub total_usdc: i128,
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
    pub nonce: BytesN<32>,
    /// Net minted for the recipient (6 decimals).
    pub amount_6: i128,
    /// Circle's destination fee from the message (6 decimals).
    pub fee_executed_6: i128,
    /// Relay fee actually paid (6 decimals).
    pub relay_6: i128,
    /// Battery deposit actually made (6 decimals).
    pub battery_6: i128,
    /// 0 = straight to wallet, 1 = ticket.
    pub mode: u32,
    pub ledger: u32,
    pub message_hash: BytesN<32>,
}

/// Passport metadata (5.6 query surface; the star art is the Passport's).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftMeta {
    pub source_domain: u32,
    pub nonce: BytesN<32>,
    pub amount_6: i128,
    pub relay_6: i128,
    pub battery_6: i128,
    pub mode: u32,
    pub star_name: soroban_sdk::String,
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
    pub burn_router: BytesN<32>,
    pub battery: Address,
    pub ticket: Address,
    pub allowed: Vec<u32>,
}

pub fn read_u32(b: &Bytes, at: u32) -> Result<u32, GateError> {
    if at + 4 > b.len() {
        return Err(GateError::MessageTooShort);
    }
    let mut v: u32 = 0;
    for i in 0..4 {
        v = (v << 8) | u32::from(b.get(at + i).ok_or(GateError::MessageTooShort)?);
    }
    Ok(v)
}

pub fn read_u64(b: &Bytes, at: u32) -> Result<u64, GateError> {
    if at + 8 > b.len() {
        return Err(GateError::MessageTooShort);
    }
    let mut v: u64 = 0;
    for i in 0..8 {
        v = (v << 8) | u64::from(b.get(at + i).ok_or(GateError::MessageTooShort)?);
    }
    Ok(v)
}

pub fn read_bytes32(env: &Env, b: &Bytes, at: u32) -> Result<BytesN<32>, GateError> {
    if at + 32 > b.len() {
        return Err(GateError::MessageTooShort);
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = b.get(at + i as u32).ok_or(GateError::MessageTooShort)?;
    }
    Ok(BytesN::from_array(env, &out))
}

fn zero_range(b: &Bytes, from: u32, to: u32) -> Result<(), GateError> {
    if to > b.len() {
        return Err(GateError::MessageTooShort);
    }
    for i in from..to {
        if b.get(i).ok_or(GateError::MessageTooShort)? != 0 {
            return Err(GateError::AmountOverflow);
        }
    }
    Ok(())
}

pub fn payload32(p: &AddressPayload) -> BytesN<32> {
    match p {
        AddressPayload::AccountIdPublicKeyEd25519(b) => b.clone(),
        AddressPayload::ContractIdHash(b) => b.clone(),
    }
}

/// The 32-byte wire form of an address (contract hash for C..., ed25519 for
/// G...) — the form CCTP messages carry.
pub fn addr32(a: &Address) -> Result<BytesN<32>, GateError> {
    AddressPayload::from_address(a).map(|p| payload32(&p)).ok_or(GateError::AddrForm)
}

pub fn self32(env: &Env) -> Result<BytesN<32>, GateError> {
    addr32(&env.current_contract_address())
}

#[contract]
pub struct GateClaim;

#[contractimpl]
impl GateClaim {
    /// One-shot: bind every dependency. Nothing can change these again.
    pub fn initialize(
        env: Env,
        mt: Address,
        usdc: Address,
        burn_token: BytesN<32>,
        burn_router: BytesN<32>,
        battery: Address,
        ticket: Address,
        allowed: Vec<u32>,
    ) -> Result<(), GateError> {
        if env.storage().instance().has(&DataKey::Init) {
            return Err(GateError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Init,
            &Init {
                mt,
                usdc,
                burn_token,
                burn_router,
                battery,
                ticket,
                allowed,
            },
        );
        env.storage().instance().set(&DataKey::Seq, &0u64);
        Ok(())
    }

    /// Consume one CCTP message: verify, receive, distribute, passport.
    /// `relay_fee` (6dp) is what THIS call actually pays the relayer; it is
    /// a ceiling-bound number (hook cap + MAX_RELAY_FEE), not a demand.
    pub fn claim(
        env: Env,
        message: Bytes,
        attestation: Bytes,
        relayer: Address,
        relay_fee: i128,
    ) -> Result<u64, GateError> {
        let init: Init = env
            .storage()
            .instance()
            .get(&DataKey::Init)
            .ok_or(GateError::NotInitialized)?;

        // ---- 1. parse + verify the CCTP V2 message ----
        if message.len() < OFF_HOOK {
            return Err(GateError::MessageTooShort);
        }
        if read_u32(&message, OFF_VERSION)? != 1 {
            return Err(GateError::BadMessageVersion);
        }
        let source_domain = read_u32(&message, OFF_SOURCE)?;
        if !init.allowed.contains(source_domain) {
            return Err(GateError::SourceDomainNotAllowed);
        }
        if read_u32(&message, OFF_DEST)? != 27 {
            return Err(GateError::WrongDestinationDomain);
        }
        let me = self32(&env)?;
        // design G: only this contract can consume the message, twice over
        if read_bytes32(&env, &message, OFF_DEST_CALLER)? != me {
            return Err(GateError::NotDestinationCaller);
        }
        if read_bytes32(&env, &message, OFF_RECIPIENT)? != me {
            return Err(GateError::NotMintRecipient);
        }
        if read_u32(&message, OFF_BODY_VERSION)? != 1 {
            return Err(GateError::BadMessageVersion);
        }
        if read_bytes32(&env, &message, OFF_BURN_TOKEN)? != init.burn_token {
            return Err(GateError::WrongBurnToken);
        }
        if read_bytes32(&env, &message, OFF_MINT_RECIPIENT)? != me {
            return Err(GateError::NotMintRecipient);
        }
        // rule 9: only burns made by OUR router (messageSender)
        if read_bytes32(&env, &message, OFF_MSG_SENDER)? != init.burn_router {
            return Err(GateError::WrongMessageSender);
        }
        // amount u256: high 64 bits must be zero
        zero_range(&message, OFF_AMOUNT, OFF_AMOUNT_LOW)?;
        let nonce = read_bytes32(&env, &message, OFF_NONCE)?;
        let fee_executed_6 = read_u64(&message, OFF_FEE_EXECUTED_LOW)? as i128;

        // ---- 2. parse the v1 hook (the source-side instruction) ----
        let hook = message.slice(OFF_HOOK..);
        if hook.len() > HOOK_MAX {
            return Err(GateError::HookTooLarge);
        }
        let h = parse_hook(&env, &hook)?;

        // ---- 3. fee ceilings, before any state or external call ----
        if relay_fee < 0 {
            return Err(GateError::RelayFeeAboveCap);
        }
        if relay_fee > h.relay_fee_cap {
            return Err(GateError::RelayFeeAboveCap);
        }
        if relay_fee * 10 > MAX_RELAY_FEE_7 {
            return Err(GateError::RelayFeeAboveMax);
        }

        // ---- 4. replay protection #2 (the MT consumes the nonce; we keep
        //         an extra persistent record of every claimed message) ----
        let hash: BytesN<32> = env.crypto().sha256(&message).to_bytes();
        let hash_key = DataKey::MsgHash(hash.clone());
        if env.storage().persistent().has(&hash_key) {
            return Err(GateError::MessageAlreadyClaimed);
        }

        // ---- 5. receive: Circle verifies the attestation and mints ----
        let usdc = soroban_sdk::token::Client::new(&env, &init.usdc);
        let here = env.current_contract_address();
        let before = usdc.balance(&here);
        // 3-argument call, caller = self (the destinationCaller). A bad
        // attestation or a replayed nonce traps inside this call and takes
        // the whole transaction with it — nothing below can half-happen.
        let accepted: bool = env.invoke_contract(
            &init.mt,
            &Symbol::new(&env, "receive_message"),
            vec![
                &env,
                here.clone().into_val(&env),
                message.clone().into_val(&env),
                attestation.into_val(&env),
            ],
        );
        if !accepted {
            return Err(GateError::NothingMinted);
        }

        // ---- 6. measure what actually arrived ----
        let minted_7 = usdc.balance(&here) - before;
        if minted_7 <= 0 {
            return Err(GateError::NothingMinted);
        }
        if minted_7 % 10 != 0 {
            return Err(GateError::DecimalsNotExact);
        }
        let amount_6 = minted_7 / 10;

        // ---- 7. distribute (6dp hook values x10 -> 7dp) ----
        let relay_7 = relay_fee * 10;
        let battery_7 = h.battery_amount * 10;
        if relay_7 + battery_7 >= minted_7 {
            return Err(GateError::FeesExceedMint);
        }
        let rest_7 = minted_7 - relay_7 - battery_7;
        let ticket_mode = (h.flags & 4) != 0;

        if relay_7 > 0 {
            usdc.transfer(&here, &relayer, &relay_7);
        }
        if battery_7 > 0 {
            // battery.deposit(self, recipient, x) -> the Battery calls the
            // token on OUR behalf, so we pass a nested self-auth entry for
            // that deeper call (the node = the call where the token checks
            // our auth; the Battery frame itself is skipped).
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: init.usdc.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: vec![
                            &env,
                            here.clone().into_val(&env),
                            init.battery.clone().into_val(&env),
                            battery_7.into_val(&env),
                        ],
                    },
                    sub_invocations: vec![&env],
                }),
            ]);
            let _: () = env.invoke_contract(
                &init.battery,
                &soroban_sdk::symbol_short!("deposit"),
                vec![
                    &env,
                    here.clone().into_val(&env),
                    h.recipient.clone().into_val(&env),
                    battery_7.into_val(&env),
                ],
            );
        }
        if ticket_mode {
            // money first (into the ticket vault), right second — both in
            // this one transaction, so the vault can never drift.
            usdc.transfer(&here, &init.ticket, &rest_7);
            let _: u64 = env.invoke_contract(
                &init.ticket,
                &Symbol::new(&env, "mint_ticket"),
                vec![
                    &env,
                    h.recipient.clone().into_val(&env),
                    rest_7.into_val(&env),
                    source_domain.into_val(&env),
                    hash.clone().into_val(&env),
                    h.star_name.clone().into_val(&env),
                ],
            );
        } else {
            usdc.transfer(&here, &h.recipient, &rest_7);
        }

        // ---- 8. replay record + passport ----
        env.storage().persistent().set(&hash_key, &());

        let ledger = env.ledger().sequence();
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Seq)
            .ok_or(GateError::NotInitialized)?;
        let next = id.checked_add(1).ok_or(GateError::SeqOverflow)?;
        env.storage().instance().set(&DataKey::Seq, &next);

        let proof = MigrationProof {
            id,
            owner: h.recipient.clone(),
            source_domain,
            nonce,
            amount_6,
            fee_executed_6,
            relay_6: relay_fee,
            battery_6: h.battery_amount,
            mode: if ticket_mode { 1 } else { 0 },
            ledger,
            message_hash: hash,
        };
        let meta = NftMeta {
            source_domain,
            nonce: proof.nonce.clone(),
            amount_6,
            relay_6: relay_fee,
            battery_6: h.battery_amount,
            mode: proof.mode,
            star_name: h.star_name.clone(),
            ledger,
        };
        env.storage().persistent().set(&DataKey::Proof(id), &proof);
        env.storage().persistent().set(&DataKey::Meta(id), &meta);
        env.storage().persistent().set(&DataKey::NftOwner(id), &h.recipient.clone());
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::Owner(h.recipient.clone()))
            .unwrap_or(Vec::new(&env));
        ids.push_back(id);
        let owner_key = DataKey::Owner(h.recipient.clone());
        env.storage().persistent().set(&owner_key, &ids);

        // the passport credits the FIRST recipient, whatever the mod
        let mut sum: MigrationSummary = env
            .storage()
            .persistent()
            .get(&DataKey::Mig(h.recipient.clone()))
            .unwrap_or(MigrationSummary {
                total_usdc: 0,
                claim_count: 0,
                first_ledger: ledger,
                last_ledger: ledger,
                sources: Vec::new(&env),
            });
        sum.total_usdc = sum
            .total_usdc
            .checked_add(amount_6)
            .ok_or(GateError::AmountOverflow)?;
        sum.claim_count = sum
            .claim_count
            .checked_add(1)
            .ok_or(GateError::SeqOverflow)?;
        sum.last_ledger = ledger;
        if !sum.sources.contains(source_domain) {
            sum.sources.push_back(source_domain);
        }
        let mig_key = DataKey::Mig(h.recipient.clone());
        env.storage().persistent().set(&mig_key, &sum);
        env.storage().persistent().extend_ttl(&mig_key, BUMP_THRESHOLD, BUMP_EXTEND);
        env.storage().persistent().extend_ttl(&owner_key, BUMP_THRESHOLD, BUMP_EXTEND);

        env.events().publish(
            (soroban_sdk::symbol_short!("claim"), h.recipient.clone(), id),
            (amount_6, relay_fee, h.battery_amount),
        );
        Ok(id)
    }

    // ---- query surface (5.6: the Passport's API; any contract may build
    //      on it - e.g. gate_campaign_example) ----

    pub fn get_migration(env: Env, owner: Address) -> Option<MigrationSummary> {
        env.storage().persistent().get(&DataKey::Mig(owner))
    }

    pub fn has_migrated_at_least(env: Env, owner: Address, min_usdc: i128) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, MigrationSummary>(&DataKey::Mig(owner))
        {
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

    /// The Passport is soulbound BY CONSTRUCTION: there is no transfer and
    /// no approve function in this contract at all.
    pub fn owner_of(env: Env, id: u64) -> Option<Address> {
        env.storage().persistent().get(&DataKey::NftOwner(id))
    }

    pub fn proofs_of(env: Env, owner: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::Owner(owner))
            .unwrap_or(Vec::new(&env))
    }

    /// Permissionless TTL upkeep: anyone can keep a migration record alive,
    /// forever, without asking anybody.
    pub fn bump(env: Env, owner: Address) {
        let mig = DataKey::Mig(owner.clone());
        if env.storage().persistent().has(&mig) {
            env.storage().persistent().extend_ttl(&mig, BUMP_THRESHOLD, BUMP_EXTEND);
        }
        let own = DataKey::Owner(owner.clone());
        if let Some(ids) = env.storage().persistent().get::<_, Vec<u64>>(&own) {
            env.storage().persistent().extend_ttl(&own, BUMP_THRESHOLD, BUMP_EXTEND);
            for id in ids.iter() {
                for k in [DataKey::Proof(id), DataKey::Meta(id), DataKey::NftOwner(id)] {
                    if env.storage().persistent().has(&k) {
                        env.storage().persistent().extend_ttl(&k, BUMP_THRESHOLD, BUMP_EXTEND);
                    }
                }
            }
        }
    }
}

struct Hook {
    flags: u8,
    relay_fee_cap: i128,
    battery_amount: i128,
    recipient: Address,
    star_name: soroban_sdk::String,
}

/// hookData v1 (DIRECTIVE 5.1):
///   24 zero bytes | u32 version(=1) | u32 payload_len
///   payload: u8 flags (bit0 name, bit1 composition, bit2 ticket)
///            | u128 relay_fee_cap (6dp) | u128 battery_amount (6dp)
///            | u8 len + recipient strkey
///            | [bit0] u8 len + name ([A-Za-z0-9 ], <= 24)
pub fn parse_hook(env: &Env, hook: &Bytes) -> Result<Hook, GateError> {
    if hook.len() < HOOK_PAD + 8 {
        return Err(GateError::BadHook);
    }
    if hook.len() > HOOK_MAX {
        return Err(GateError::HookTooLarge);
    }
    for i in 0..HOOK_PAD {
        if hook.get(i).ok_or(GateError::BadHook)? != 0 {
            return Err(GateError::BadHook);
        }
    }
    if read_u32(hook, HOOK_PAD)? != 1 {
        return Err(GateError::BadHook);
    }
    let payload_len = read_u32(hook, HOOK_PAD + 4)?;
    let total = (HOOK_PAD + 8)
        .checked_add(payload_len)
        .ok_or(GateError::BadHook)?;
    if hook.len() < total {
        return Err(GateError::BadHook);
    }
    let mut p = HOOK_PAD + 8;
    let flags = hook.get(p).ok_or(GateError::BadHook)?;
    p += 1;
    let relay_fee_cap = read_u128(hook, p)?;
    p += 16;
    let battery_amount = read_u128(hook, p)?;
    p += 16;
    let rlen = u32::from(hook.get(p).ok_or(GateError::BadHook)?);
    p += 1;
    if rlen == 0 || rlen > STRKEY_MAX {
        return Err(GateError::BadHook);
    }
    let rend = p.checked_add(rlen).ok_or(GateError::BadHook)?;
    if rend > total {
        return Err(GateError::BadHook);
    }
    let rbytes = hook.slice(p..rend);
    let first = rbytes.get(0).ok_or(GateError::BadHook)?;
    if first != b'G' && first != b'C' {
        return Err(GateError::BadHook);
    }
    let recipient = Address::from_string_bytes(&rbytes);
    p = rend;
    let mut star_name = soroban_sdk::String::from_str(env, "");
    if flags & 1 != 0 {
        let nlen = u32::from(hook.get(p).ok_or(GateError::BadHook)?);
        p += 1;
        if nlen > NAME_MAX {
            return Err(GateError::NameTooLong);
        }
        let nend = p.checked_add(nlen).ok_or(GateError::BadHook)?;
        if nend > total {
            return Err(GateError::NameTooLong);
        }
        let nb = hook.slice(p..nend);
        for i in 0..nlen {
            let c = nb.get(i).ok_or(GateError::BadHook)?;
            let ok = (c >= b'a' && c <= b'z')
                || (c >= b'A' && c <= b'Z')
                || (c >= b'0' && c <= b'9')
                || c == b' ';
            if !ok {
                return Err(GateError::BadStarName);
            }
        }
        let mut nbuf = [0u8; NAME_MAX as usize];
        for i in 0..nlen {
            nbuf[i as usize] = nb.get(i).ok_or(GateError::BadHook)?;
        }
        star_name = soroban_sdk::String::from_bytes(env, &nbuf[..nlen as usize]);
        p = nend;
    }
    if p != total {
        return Err(GateError::BadHook);
    }
    Ok(Hook {
        flags,
        relay_fee_cap,
        battery_amount,
        recipient,
        star_name,
    })
}

fn read_u128(b: &Bytes, at: u32) -> Result<i128, GateError> {
    if at + 16 > b.len() {
        return Err(GateError::BadHook);
    }
    let mut v: i128 = 0;
    for i in 0..16 {
        v = (v << 8) | i128::from(b.get(at + i as u32).ok_or(GateError::BadHook)?);
    }
    Ok(v)
}
