//! Test infrastructure ONLY - NOT a product contract.
//!
//! `test_mt` is the 2.0 counterpart of Gate 1.0's `source_simulator`:
//! a stand-in for Circle's MessageTransmitter used on the LIVE TESTNET
//! TEST LANE, where a real Sepolia burn (and therefore a real Iris
//! attestation) is not available because it needs Sepolia funds (F2,
//! DIRECTIVE 2.0 stop-condition "F2 fon bekliyor").
//!
//! It mirrors the REAL deployed MessageTransmitter (fetched from testnet,
//! spec-checked with stellar-cli) for the questions the product asks:
//!   - signature: receive_message(caller, message, attestation)
//!   - message format: CCTP V2 (148-byte header; Circle's documented
//!     "Message Format" table: nonce bytes32 @12, sender @44,
//!     recipient @76, destinationCaller @108, minFinalityThreshold @140)
//!   - caller must equal the message's destinationCaller (the auth the real
//!     transmitter enforces - this is the race the S1 analysis removed);
//!   - the nonce is consumed once (replay protection);
//!   - the mint goes to the message's mintRecipient;
//!   - an attestation of the wrong shape is refused.
//!
//! What it does NOT simulate: Circle's cryptographic attestation check
//! (the trust root - that is Circle's code, verified by Circle's own tests
//! and out of scope for this repository). The attestation here is checked
//! STRUCTURALLY only (65-byte signature shape).
//!
//! Anything this contract proves lives in the manifest under the
//! "test lane" receipts and is always labeled as such.
#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractimpl, contracttype, Address,
    Bytes, BytesN, Env,
};

/// CCTP V2 header: 4+4+4+32+32+32+32+4+4 = 148 bytes before the BurnMessage.
pub const HEADER: usize = 148;
/// BurnMessage V2 fixed part: 4+32+32+32+32+32+32+32 = 228 bytes before
/// hookData (absolute offset 376).
pub const BODY_FIXED: usize = 228;
const DEST_DOMAIN: u32 = 27;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MtError {
    NotInitialized = 1,
    MessageTooShort = 2,
    BadVersion = 3,
    WrongDestinationDomain = 4,
    CallerNotDestinationCaller = 5,
    BadAttestation = 6,
    NonceAlreadyUsed = 7,
    AmountOverflow = 8,
    BadRecipient = 9,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    Nonce(BytesN<32>),
}

#[contract]
pub struct TestMt;

#[contractimpl]
impl TestMt {
    /// One-shot: the token that receive_message will mint.
    pub fn initialize(env: Env, token: Address) -> Result<(), MtError> {
        if env.storage().instance().has(&DataKey::Token) {
            return Err(MtError::NotInitialized);
        }
        env.storage().instance().set(&DataKey::Token, &token);
        Ok(())
    }

    /// Mirrors the real MessageTransmitter.receive_message(caller, message,
    /// attestation): verify shape and caller binding, consume the nonce,
    /// mint `amount` (x10 for the 7-decimal local token) to the message's
    /// mintRecipient, return true.
    pub fn receive_message(env: Env, caller: Address, message: Bytes, attestation: Bytes) -> Result<bool, MtError> {
        let token: Address = env.storage().instance().get(&DataKey::Token).ok_or(MtError::NotInitialized)?;
        if message.len() < (HEADER + 36) as u32 {
            return Err(MtError::MessageTooShort);
        }
        // structural attestation check only (length of one 65-byte signature)
        if attestation.len() != 65 {
            return Err(MtError::BadAttestation);
        }
        if read_u32(&message, 0)? != 1 {
            return Err(MtError::BadVersion);
        }
        if read_u32(&message, 8)? != DEST_DOMAIN {
            return Err(MtError::WrongDestinationDomain);
        }
        // caller must be the destination caller named in the message
        let dc = read_bytes32(&env, &message, 108)?;
        let caller_bytes = payload32(&AddressPayload::from_address(&caller).ok_or(MtError::CallerNotDestinationCaller)?);
        if caller_bytes != dc {
            return Err(MtError::CallerNotDestinationCaller);
        }
        // nonce: bytes32 @12, consumed once
        let nonce = read_bytes32(&env, &message, 12)?;
        let nkey = DataKey::Nonce(nonce.clone());
        if env.storage().instance().has(&nkey) {
            return Err(MtError::NonceAlreadyUsed);
        }
        env.storage().instance().set(&nkey, &());
        // BurnMessage.mintRecipient at 184..216. On this lane the recipient
        // is always a contract (the GateClaim of design G).
        let mr = read_bytes32(&env, &message, 184)?;
        if mr == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(MtError::BadRecipient);
        }
        let recipient = AddressPayload::ContractIdHash(mr).to_address(&env);
        // BurnMessage.amount u256 at 216..248; the upper 64 bits must be 0
        for i in 216..240 {
            if message.get(i as u32).ok_or(MtError::MessageTooShort)? != 0 {
                return Err(MtError::AmountOverflow);
            }
        }
        let amount_6 = read_u64(&message, 240)? as i128;
        let minted_7 = amount_6 * 10; // 6 -> 7 decimals, exactly like the real MT
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&recipient, &minted_7);
        Ok(true)
    }
}

pub fn payload32(p: &AddressPayload) -> BytesN<32> {
    match p {
        AddressPayload::AccountIdPublicKeyEd25519(b) => b.clone(),
        AddressPayload::ContractIdHash(b) => b.clone(),
    }
}

fn read_u32(b: &Bytes, at: usize) -> Result<u32, MtError> {
    if at + 4 > b.len() as usize {
        return Err(MtError::MessageTooShort);
    }
    Ok(u32::from_be_bytes([
        b.get(at as u32).ok_or(MtError::MessageTooShort)?,
        b.get((at + 1) as u32).ok_or(MtError::MessageTooShort)?,
        b.get((at + 2) as u32).ok_or(MtError::MessageTooShort)?,
        b.get((at + 3) as u32).ok_or(MtError::MessageTooShort)?,
    ]))
}

fn read_u64(b: &Bytes, at: usize) -> Result<u64, MtError> {
    if at + 8 > b.len() as usize {
        return Err(MtError::MessageTooShort);
    }
    let mut v = 0u64;
    for i in 0..8 {
        v = (v << 8) | u64::from(b.get((at + i) as u32).ok_or(MtError::MessageTooShort)?);
    }
    Ok(v)
}

fn read_bytes32(env: &Env, b: &Bytes, at: usize) -> Result<BytesN<32>, MtError> {
    if at + 32 > b.len() as usize {
        return Err(MtError::MessageTooShort);
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = b.get((at + i) as u32).ok_or(MtError::MessageTooShort)?;
    }
    Ok(BytesN::from_array(env, &out))
}
