//! S1 spike gate (DIRECTIVE 2.0 section 7, F1). Deliberately NOT the product
//! contract - it exists to answer one question with a live testnet call:
//! can a Soroban contract be the destinationCaller that MessageTransmitter
//! authorizes for receive_message, and can a CCTP mint land on a CONTRACT
//! account balance? `claim` calls receive_message with caller = self, then
//! reports its own USDC balance back. No product logic, no NFT, no storage
//! beyond the last balance, nothing is wired to it in the product path.
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Address, Bytes, Env, Symbol, token};

#[contract]
pub struct SpikeGate;

#[contractimpl]
impl SpikeGate {
    pub fn claim(env: Env, transmitter: Address, usdc: Address, message: Bytes, attestation: Bytes) -> i128 {
        let self_addr = env.current_contract_address();
        let ok: bool = env.invoke_contract(
            &transmitter,
            &Symbol::new(&env, "receive_message"),
            vec![&env, self_addr.to_val(), message.to_val(), attestation.to_val()],
        );
        assert!(ok, "transmitter refused the message");
        let bal = token::Client::new(&env, &usdc).balance(&self_addr);
        env.storage().persistent().set(&symbol_short!("last"), &bal);
        env.storage().persistent().extend_ttl(&symbol_short!("last"), 100, 1000);
        bal
    }

    pub fn last_balance(env: Env) -> Option<i128> {
        env.storage().persistent().get(&symbol_short!("last"))
    }
}
