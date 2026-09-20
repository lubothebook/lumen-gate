#![no_std]
//! Lumen Gate's Stello target: one `on_deposit`, nothing else.
//!
//! The payment path is Stello (Seyit Ali Değirmen's kit). This contract is
//! the app side of that kit: the router already moved the USDC here before
//! this function runs. It is **not deployed**. The live `/stello/` console
//! talks to Stello's published piggy-bank example (route 2) until a Lumen
//! Gate route is registered.
//!
//! `router.require_auth()` is mandatory. Without it anyone can credit
//! themselves for a transfer that never happened.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Router,
    Token,
    Balance(Address),
}

#[contract]
pub struct DepositTarget;

#[contractimpl]
impl DepositTarget {
    pub fn __constructor(env: Env, router: Address, token: Address) {
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    pub fn on_deposit(env: Env, user: Address, amount: i128, _arg: Bytes) -> bool {
        let router: Address = env.storage().instance().get(&DataKey::Router).unwrap();
        router.require_auth();
        let key = DataKey::Balance(user);
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0) + amount;
        env.storage().persistent().set(&key, &balance);
        true
    }

    pub fn balance(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(user))
            .unwrap_or(0)
    }
}
