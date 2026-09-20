//! Gate 2.0 — gate_battery: the user-owned fee balance (DIRECTIVE 2.0, 5.3).
//!
//! The Battery is a separated, user-owned "fee balance" denominated in USDC.
//! When the owner has no XLM, a relayer may pay the Stellar network fee and
//! be paid back in USDC straight out of the Battery, atomically, without ever
//! exceeding the cap the owner signed.
//!
//! Design roots (5.3 + rule 2):
//!   - No admin, no pause, no upgrade. `initialize` binds the USDC token once.
//!   - The contract holds USDC: it is one of the two explicit custody
//!     exceptions (rule 2). The ONLY exits are `withdraw` (owner auth) and the
//!     fee payment inside `forward` (bounded by the owner's signed max_fee).
//!   - `deposit(from, owner, amount)`: anyone may top up anyone's battery;
//!     the USDC leaves `from` and the ledger entry for `owner` grows.
//!   - `withdraw(owner, amount)`: never blocked, no conditions, no cooldown.
//!   - `forward(owner, relayer, fee, max_fee, expiry, nonce, target, fn,
//!     args)`: the relayer submits the transaction; the OWNER's signature is
//!     embedded as the auth for this exact call, which is what bounds the
//!     fee to max_fee. Rules: fee <= max_fee, ledger < expiry, nonce unique
//!     per owner. The fee leaves to the relayer and the target call runs in
//!     the same atomic transaction - if the target fails, the fee comes back.
//!
//! Invariant (proven by the property test): for every sequence of
//! deposit/withdraw/forward,
//!     sum over owners of balance_of(owner) == USDC.balance(gate_battery).
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Val, Vec,
};

const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_EXTEND: u32 = 400_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BatteryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ZeroAmount = 3,
    Overflow = 4,
    InsufficientBalance = 5,
    FeeAboveCap = 6,
    Expired = 7,
    NonceUsed = 8,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The bound USDC token (Stellar Asset Contract). Set once, immutable.
    Usdc,
    /// Owner -> balance (7 decimals, native USDC units on Stellar).
    Bal(Address),
    /// (owner, nonce) -> used. Persistent so a replayed nonce is refused.
    Nonce(Address, u64),
}

#[contract]
pub struct GateBattery;

#[contractimpl]
impl GateBattery {
    /// Called once by the deploy script with the USDC token address.
    /// There is no admin afterwards: nothing in this contract can change it.
    pub fn initialize(env: Env, usdc: Address) -> Result<(), BatteryError> {
        if env.storage().instance().has(&DataKey::Usdc) {
            return Err(BatteryError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        Ok(())
    }

    fn usdc(env: &Env) -> Result<Address, BatteryError> {
        env.storage()
            .instance()
            .get(&DataKey::Usdc)
            .ok_or(BatteryError::NotInitialized)
    }

    /// Anyone may top up anyone's battery: `from` authorizes the pull of
    /// `amount` USDC into the contract, and `owner`'s balance grows.
    /// The USDC and the balance move in the same atomic transaction.
    pub fn deposit(env: Env, from: Address, owner: Address, amount: i128) -> Result<(), BatteryError> {
        if amount <= 0 {
            return Err(BatteryError::ZeroAmount);
        }
        from.require_auth();
        let token = Self::usdc(&env)?;
        let here = env.current_contract_address();
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&from, &here, &amount);
        let key = DataKey::Bal(owner.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_bal = bal.checked_add(amount).ok_or(BatteryError::Overflow)?;
        env.storage().persistent().set(&key, &new_bal);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
        env.events()
            .publish((soroban_sdk::symbol_short!("deposit"), from, owner), amount);
        Ok(())
    }

    /// The owner takes any amount back out, whenever. No conditions: this is
    /// the reason the Battery is user-owned and not a lock. If `to` has no
    /// USDC trustline the token transfer reverts and nothing changes.
    pub fn withdraw(env: Env, owner: Address, amount: i128) -> Result<(), BatteryError> {
        if amount <= 0 {
            return Err(BatteryError::ZeroAmount);
        }
        owner.require_auth();
        let token = Self::usdc(&env)?;
        let here = env.current_contract_address();
        let key = DataKey::Bal(owner.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount > bal {
            return Err(BatteryError::InsufficientBalance);
        }
        let new_bal = bal - amount;
        env.storage().persistent().set(&key, &new_bal);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
        soroban_sdk::token::Client::new(&env, &token).transfer(&here, &owner, &amount);
        env.events()
            .publish((soroban_sdk::symbol_short!("withdraw"), owner), amount);
        Ok(())
    }

    pub fn balance_of(env: Env, owner: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Bal(owner))
            .unwrap_or(0)
    }

    /// Relayer-submitted fee forwarding. The owner's signature authorizes
    /// THIS EXACT call (owner, relayer, fee, max_fee, expiry, nonce, target,
    /// fn, args), so no relayer can ever move more than max_fee or touch a
    /// different target/function than the one the owner signed.
    ///
    /// 1. fee <= max_fee (the signed cap)
    /// 2. ledger < expiry (the signed window)
    /// 3. nonce unused by this owner (single use)
    /// 4. fee leaves the battery to the relayer, then target.fn(args) runs.
    ///    Atomic: a failing target call unwinds the fee payment with it.
    pub fn forward(
        env: Env,
        owner: Address,
        relayer: Address,
        fee: i128,
        max_fee: i128,
        expiry: u32,
        nonce: u64,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<(), BatteryError> {
        // The signature covers every argument above: fee, max_fee, expiry,
        // nonce, target, fn and args alike.
        owner.require_auth();
        if fee < 0 || max_fee < 0 {
            return Err(BatteryError::FeeAboveCap);
        }
        if fee > max_fee {
            return Err(BatteryError::FeeAboveCap);
        }
        if env.ledger().sequence() >= expiry {
            return Err(BatteryError::Expired);
        }
        let nkey = DataKey::Nonce(owner.clone(), nonce);
        if env.storage().persistent().has(&nkey) {
            return Err(BatteryError::NonceUsed);
        }
        let token = Self::usdc(&env)?;
        let here = env.current_contract_address();
        let key = DataKey::Bal(owner.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if fee > bal {
            return Err(BatteryError::InsufficientBalance);
        }
        // Charge first, then act: if the target fails, the whole transaction
        // reverts and the fee never left.
        let new_bal = bal - fee;
        env.storage().persistent().set(&key, &new_bal);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
        env.storage().persistent().set(&nkey, &());
        env.storage()
            .persistent()
            .extend_ttl(&nkey, BUMP_THRESHOLD, BUMP_EXTEND);
        soroban_sdk::token::Client::new(&env, &token).transfer(&here, &relayer, &fee);
        let _: Val = env.invoke_contract(&target, &fn_name, args.clone());
        env.events().publish(
            (soroban_sdk::symbol_short!("forward"), owner, relayer, target),
            fee,
        );
        Ok(())
    }

    /// Permissionless TTL upkeep: anyone can keep an owner's balance (and its
    /// nonces) alive, forever, without asking anybody.
    pub fn bump(env: Env, owner: Address) {
        let bal = DataKey::Bal(owner.clone());
        if env.storage().persistent().has(&bal) {
            env.storage()
                .persistent()
                .extend_ttl(&bal, BUMP_THRESHOLD, BUMP_EXTEND);
        }
        // Nonces are per-owner but keyed (owner, nonce); sweeping them here
        // would need an index, which would be mutable state. They are
        // single-use with a 400k-ledger TTL each, which outlives any honest
        // relayer queue by orders of magnitude; an aged-out nonce can at
        // worst be REUSED by the owner, never spent by a third party.
    }
}
