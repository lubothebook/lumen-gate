//! TESTNET stamp: a soulbound id the caller mints to themselves.
//! This is NOT a CCTP Passport. No transfer, no approve, no admin.
#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StampError {
    AlreadyStamped = 1,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Seq,
    OwnerOf(u64),
    Of(Address),
}

#[contract]
pub struct GateStamp;

#[contractimpl]
impl GateStamp {
    /// Caller pays the fee and receives one soulbound stamp. Second call refuses.
    pub fn stamp(env: Env, owner: Address) -> Result<u64, StampError> {
        owner.require_auth();
        if env.storage().persistent().has(&DataKey::Of(owner.clone())) {
            return Err(StampError::AlreadyStamped);
        }
        let id: u64 = env.storage().instance().get(&DataKey::Seq).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::Seq, &(id + 1));
        env.storage().persistent().set(&DataKey::OwnerOf(id), &owner);
        env.storage().persistent().set(&DataKey::Of(owner.clone()), &id);
        env.storage().persistent().extend_ttl(&DataKey::Of(owner.clone()), 100_000, 400_000);
        env.storage().persistent().extend_ttl(&DataKey::OwnerOf(id), 100_000, 400_000);
        env.events().publish((soroban_sdk::symbol_short!("stamp"), owner, id), id);
        Ok(id)
    }

    pub fn owner_of(env: Env, id: u64) -> Option<Address> {
        env.storage().persistent().get(&DataKey::OwnerOf(id))
    }

    pub fn stamp_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::Of(owner))
    }

    pub fn token_uri(env: Env, id: u64) -> String {
        match env.storage().persistent().get::<_, Address>(&DataKey::OwnerOf(id)) {
            Some(_) => String::from_str(&env, "data:application/json,{\"name\":\"Lumen Gate TESTNET stamp\",\"description\":\"Soulbound testnet stamp. Not a CCTP Passport.\"}"),
            None => String::from_str(&env, ""),
        }
    }
}
