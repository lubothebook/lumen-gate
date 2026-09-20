//! S1 spike gate (DIRECTIVE 2.0 section 7, F1). Deliberately NOT the product
//! contract - it exists to answer one question with a live testnet call:
//! can a Soroban contract be the destinationCaller that MessageTransmitter
//! authorizes for receive_message, and can a CCTP USDC mint land on a CONTRACT
//! account balance? `claim` calls receive_message with caller = self and then
//! reports its own USDC balance back. No product logic, no NFT, no storage
//! beyond the last balance, nothing is wired to it in the product path.
//!
//! Error style follows HARDENING-2.0.md section 5.1: refusals return error
//! codes (no assert!, no unwrap, no bare panic) so a probe can tell WHICH
//! check failed instead of reading a meaningless host trap.
#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, vec, Address, Bytes, Env, Symbol, token};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(i32)]
pub enum Error {
    TransmitterRefused = 1,
}

#[contract]
pub struct SpikeGate;

#[contractimpl]
impl SpikeGate {
    pub fn claim(env: Env, transmitter: Address, usdc: Address, message: Bytes, attestation: Bytes) -> Result<i128, Error> {
        let self_addr = env.current_contract_address();
        let ok: bool = env.invoke_contract(
            &transmitter,
            &Symbol::new(&env, "receive_message"),
            vec![&env, self_addr.to_val(), message.to_val(), attestation.to_val()],
        );
        if !ok {
            return Err(Error::TransmitterRefused);
        }
        let bal = token::Client::new(&env, &usdc).balance(&self_addr);
        env.storage().persistent().set(&symbol_short!("last"), &bal);
        env.storage().persistent().extend_ttl(&symbol_short!("last"), 100, 1000);
        Ok(bal)
    }

    pub fn last_balance(env: Env) -> Option<i128> {
        env.storage().persistent().get(&symbol_short!("last"))
    }
}
