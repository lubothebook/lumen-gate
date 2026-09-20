//! Gate 2.0 — gate_campaign_example: the consumer demo (DIRECTIVE 2.0 §5.3).
//!
//! A contract that holds no funds and emits no reward; its only job is to
//! prove that the Migration Proof badge is not decoration: any Soroban
//! contract can read `GateClaim.get_migration` and build behaviour on it.
//! Tiers: >= 10 USDC Bronze, >= 100 Silver, >= 1000 Gold (6 decimals).
//! Upgrades are free and one-way; there is nothing to steal here because
//! there is nothing here.
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol};

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
        let gate: Address = env.storage().instance().get(&DataKey::Gate).ok_or(CampError::NotInitialized)?;
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
        if current.map_or(true, |c| c < earned) {
            env.storage().persistent().set(&key, &earned);
        }
        env.events().publish((Symbol::new(&env, "tier"), owner), earned as u32);
        Ok(earned)
    }

    pub fn get_tier(env: Env, owner: Address) -> Option<Tier> {
        env.storage().persistent().get(&DataKey::Tier(owner))
    }
}

// ------------------------------------------------------------------ tests
#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Bytes, BytesN, Env};

    // The demo is tested against the real GateClaim, not a double: the point
    // of F5 is that two independent contracts interoperate through the fixed
    // query surface. The CCTP leg under GateClaim is doubled as in its own
    // suite; testnet receipts belong to F5's manifest entry, not here.
    use gate_claim::{GateClaim, GateClaimClient};

    #[contract]
    pub struct MockMt;

    #[contractimpl]
    impl MockMt {
        pub fn setup(env: Env, token: Address) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("token"), &token);
        }
        pub fn receive_message(env: Env, message: Bytes, attestation: Bytes) -> bool {
            assert!(attestation.get(0).unwrap() == 0xA7);
            let body = message.slice(116u32..);
            let mut raw = [0u8; 32];
            for i in 0..32 {
                raw[i] = body.get((36 + i) as u32).unwrap();
            }
            let recipient = soroban_sdk::address_payload::AddressPayload::ContractIdHash(BytesN::from_array(&env, &raw)).to_address(&env);
            let mut amount_6: u64 = 0;
            for i in 92u32..100 {
                amount_6 = (amount_6 << 8) | u64::from(body.get(i).unwrap());
            }
            let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
            soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&recipient, &(amount_6 as i128 * 10));
            true
        }
    }

    fn field32(env: &Env, a: &Address) -> BytesN<32> {
        use soroban_sdk::address_payload::AddressPayload;
        match AddressPayload::from_address(a).expect("no 32 byte form") {
            AddressPayload::ContractIdHash(id) => id,
            AddressPayload::AccountIdPublicKeyEd25519(id) => id,
        }
    }

    fn message(env: &Env, caller: &BytesN<32>, amount_6: u64, hook: &Address, nonce: u64) -> Bytes {
        let burn_token = BytesN::from_array(env, &[7u8; 32]);
        let mut m = Bytes::new(env);
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&0u32.to_be_bytes());
        m.extend_from_slice(&27u32.to_be_bytes());
        m.extend_from_slice(&nonce.to_be_bytes());
        m.extend_from_slice(&[9u8; 32]);
        m.extend_from_slice(&caller.to_array());
        m.extend_from_slice(&caller.to_array());
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&burn_token.to_array());
        m.extend_from_slice(&caller.to_array());
        m.extend_from_slice(&[0u8; 24]);
        m.extend_from_slice(&amount_6.to_be_bytes());
        m.extend_from_slice(&[8u8; 32]);
        m.extend_from_slice(&[0u8; 24]);
        m.extend_from_slice(&0u32.to_be_bytes());
        let sb = hook.to_string().to_bytes();
        m.extend_from_slice(&(sb.len() as u32).to_be_bytes());
        m.append(&sb);
        m
    }

    struct World {
        env: Env,
        gate: Address,
        camp: Address,
        owner: Address,
    }

    fn world() -> World {
        let env = Env::default();
        let mt = env.register(MockMt, ());
        let token = env.register_stellar_asset_contract_v2(mt.clone()).address();
        MockMtClient::new(&env, &mt).setup(&token);
        let gate = env.register(GateClaim, ());
        let burn_token = BytesN::from_array(&env, &[7u8; 32]);
        let mut allowed = soroban_sdk::Vec::new(&env);
        allowed.push_back(0u32);
        GateClaimClient::new(&env, &gate).initialize(&mt, &token, &burn_token, &allowed);
        let camp = env.register(Campaign, ());
        CampaignClient::new(&env, &camp).initialize(&gate);
        let owner = Address::generate(&env);
        World { env, gate, camp, owner }
    }

    fn migrate(w: &World, amount_6: u64, nonce: u64) {
        let me = field32(&w.env, &w.gate);
        let msg = message(&w.env, &me, amount_6, &w.owner, nonce);
        let att = Bytes::from_slice(&w.env, &[0xA7; 65]);
        GateClaimClient::new(&w.env, &w.gate).claim(&msg, &att);
    }

    #[test]
    fn a_badge_earns_its_tier_and_upgrades() {
        let w = world();
        let client = CampaignClient::new(&w.env, &w.camp);
        w.env.mock_all_auths();
        migrate(&w, 10_000_000, 1); // 10 USDC at 6 decimals
        assert_eq!(client.claim_tier(&w.owner), Tier::Bronze);
        migrate(&w, 95_000_000, 2); // total 105 USDC -> Silver
        assert_eq!(client.claim_tier(&w.owner), Tier::Silver);
        assert_eq!(client.get_tier(&w.owner), Some(Tier::Silver));
    }

    #[test]
    fn without_a_migration_there_is_no_tier() {
        let w = world();
        let client = CampaignClient::new(&w.env, &w.camp);
        w.env.mock_all_auths();
        let stranger = Address::generate(&w.env);
        assert_eq!(client.try_claim_tier(&stranger), Err(Ok(CampError::NoMigration)));
        // and a migration below Bronze earns nothing
        migrate(&w, 9_000_000, 3); // 9 USDC: below Bronze
        assert_eq!(client.try_claim_tier(&w.owner), Err(Ok(CampError::BelowBronze)));
    }
}
