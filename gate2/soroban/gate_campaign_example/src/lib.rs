//! Gate 2.0 — gate_campaign_example: the consumer demo (DIRECTIVE 2.0 §5.3).
//!
//! A contract that holds no funds and emits no reward; its only job is to
//! prove that the Migration Proof badge is not decoration: any Soroban
//! contract can read `GateClaim.get_migration` and build behaviour on it.
//! Tiers: >= 10 USDC Bronze, >= 100 Silver, >= 1000 Gold (6 decimals).
//! Upgrades are free and one-way; there is nothing to steal here because
//! there is nothing here.
#![no_std]
#![allow(
    deprecated,
    reason = "soroban-sdk 28 deprecates Events::publish in favour of the \
#[contractevent] macro. Moving to it changes the emitted event shape, and \
these contracts are already deployed on testnet with indexers reading the \
current topics - so the migration is a deliberate, separately verified \
change, not something to slip into a CI fix. The allow is narrow (this one \
lint) and stated here rather than left to -D warnings to erode."
)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol,
};

/// USDC amounts at 6 decimals.
const BRONZE: i128 = 10 * 1_000_000;
const SILVER: i128 = 100 * 1_000_000;
const GOLD: i128 = 1_000 * 1_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CampError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NoMigration = 3,
    BelowBronze = 4,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Tier {
    Bronze = 1,
    Silver = 2,
    Gold = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Gate,
    Tier(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct MigrationSummaryView {
    pub total_usdc: i128,
    pub claim_count: u32,
    pub first_ledger: u32,
    pub last_ledger: u32,
    pub sources: soroban_sdk::Vec<u32>,
}

#[contract]
pub struct Campaign;

#[contractimpl]
impl Campaign {
    pub fn initialize(env: Env, gate: Address) -> Result<(), CampError> {
        if env.storage().instance().has(&DataKey::Gate) {
            return Err(CampError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Gate, &gate);
        Ok(())
    }

    /// The owner asks for the tier their migration record earns. Upgrades
    /// only: a recorded tier never drops, because the record never shrinks.
    pub fn claim_tier(env: Env, owner: Address) -> Result<Tier, CampError> {
        owner.require_auth();
        let gate: Address = env
            .storage()
            .instance()
            .get(&DataKey::Gate)
            .ok_or(CampError::NotInitialized)?;
        let total: i128 = env
            .invoke_contract::<Option<MigrationSummaryView>>(
                &gate,
                &Symbol::new(&env, "get_migration"),
                vec![&env, owner.clone().into_val(&env)],
            )
            .ok_or(CampError::NoMigration)?
            .total_usdc;
        let earned = if total >= GOLD {
            Tier::Gold
        } else if total >= SILVER {
            Tier::Silver
        } else if total >= BRONZE {
            Tier::Bronze
        } else {
            return Err(CampError::BelowBronze);
        };
        let key = DataKey::Tier(owner.clone());
        let current: Option<Tier> = env.storage().persistent().get(&key);
        // the monotonically-increasing migration total makes a downgrade
        // unreachable today, but a return value that disagreed with storage
        // the moment it became reachable is the kind of latent drift the
        // annex review exists to stop: grant and announce ONE value — the
        // better of recorded and earned.
        let granted = match current {
            Some(c) if c >= earned => c,
            _ => {
                env.storage().persistent().set(&key, &earned);
                earned
            }
        };
        env.events()
            .publish((Symbol::new(&env, "tier"), owner), granted as u32);
        Ok(granted)
    }

    pub fn get_tier(env: Env, owner: Address) -> Option<Tier> {
        env.storage().persistent().get(&DataKey::Tier(owner))
    }
}

// ------------------------------------------------------------------ tests
