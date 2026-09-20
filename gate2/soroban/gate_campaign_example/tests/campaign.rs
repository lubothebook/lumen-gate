// Tests for the campaign demo contract, living outside src/ so the production
// file is panic-form-free for the CI grep (HARDENING-2.0.md 5.1 pattern, same
// trade made for gate_claim; tests/ is the exempt zone and the mock traps
// keep their natural panic form here).
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_campaign_example::*;
    use soroban_sdk::{
        address_payload::AddressPayload, contract, contractimpl,
        testutils::{Address as _, Ledger as _}, Address,
    };
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

    // F3 boundary suite (the test HARDENING-2.0.md section 5.1 makes F3 hinge
    // on): the operator named it because the implementation's >= vs > choice
    // is the whole semantics at these lines. BRONZE is 10 USDC = 10_000_000
    // stroops; each tier is tested at exact-minus-one and exact, fresh world
    // ---- Shared parity vectors (DIRECTIVE 2.0-ZKVM, Z3) -------------------
    //
    // The execution VM in gate2/zkvm runs the same ladder over the same file.
    // Reading the file here - rather than restating its numbers - is the whole
    // point: if either side's thresholds move, one of the two suites goes red.
    //
    // This is a parity check between two independent implementations. It is
    // not a proof, and nothing about the zkVM side is trusted by this contract.
    const TIER_VECTORS: &str = include_str!("../../../zkvm/vectors/tier_vectors.json");

    /// Minimal reader for the vector file: pulls out (total_usdc, expected_tier)
    /// for each entry. Deliberately dependency-free - a JSON crate in a Soroban
    /// contract's dev-dependencies is not worth the supply-chain surface for
    /// twelve integer pairs.
    fn parity_vectors() -> std::vec::Vec<(u64, u32)> {
        fn field_after(hay: &str, key: &str) -> Option<(u64, usize)> {
            let at = hay.find(key)?;
            let rest = &hay[at + key.len()..];
            let start = rest.find(|c: char| c.is_ascii_digit())?;
            let tail = &rest[start..];
            let end = tail
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(tail.len());
            let val: u64 = tail[..end].parse().ok()?;
            Some((val, at + key.len() + start + end))
        }

        let mut out = std::vec::Vec::new();
        // Restrict to the "vectors" array so the "thresholds" block above it
        // cannot be mistaken for an entry.
        let arr_at = TIER_VECTORS
            .find("\"vectors\"")
            .expect("vector file has a vectors array");
        let mut cursor = &TIER_VECTORS[arr_at..];
        while let Some((total, used)) = field_after(cursor, "\"total_usdc\"") {
            cursor = &cursor[used..];
            let (tier, used2) =
                field_after(cursor, "\"expected_tier\"").expect("every vector states a tier");
            cursor = &cursor[used2..];
            out.push((total, tier as u32));
        }
        out
    }

    #[test]
    fn shared_parity_vectors_are_present_and_well_formed() {
        let v = parity_vectors();
        assert_eq!(v.len(), 12, "vector file should carry 12 entries");
        // The boundary set the directive names must all be present.
        for expected in [
            0u64,
            9_999_999,
            10_000_000,
            99_999_999,
            100_000_000,
            999_999_999,
            1_000_000_000,
            1_000_000_000_000,
        ] {
            assert!(
                v.iter().any(|(t, _)| *t == expected),
                "vector file is missing the {expected} boundary case"
            );
        }
    }

    #[test]
    fn campaign_agrees_with_the_shared_parity_vectors() {
        // Tier 0 in the vector file means "below Bronze", which this contract
        // expresses as the BelowBronze error rather than a Tier value.
        for (amount, expected) in parity_vectors() {
            // Two vectors are VM-side only, and the reason is a real
            // difference between the two machines rather than a convenience:
            //
            //  - amount 0: GateClaim refuses a zero mint (NothingMinted, #13),
            //    so a zero-total migration record cannot exist on this side at
            //    all. The VM still evaluates the rung, and it is 0 there.
            //  - the 1_000_000 USDC vector: larger than this mocked CCTP
            //    message carries. The rung above Gold is already pinned here by
            //    the exact-Gold case.
            //
            // Both are recorded in evidence.json under `parity`.
            if amount == 0 || amount > u64::from(u32::MAX) * 1_000 {
                continue;
            }
            let w = world();
            w.env.mock_all_auths();
            migrate(&w, amount, 1);
            let client = CampaignClient::new(&w.env, &w.camp);
            match expected {
                0 => assert_eq!(
                    client.try_claim_tier(&w.owner),
                    Err(Ok(CampError::BelowBronze)),
                    "vector total={amount} expected below-Bronze"
                ),
                1 => assert_eq!(client.claim_tier(&w.owner), Tier::Bronze, "total={amount}"),
                2 => assert_eq!(client.claim_tier(&w.owner), Tier::Silver, "total={amount}"),
                3 => assert_eq!(client.claim_tier(&w.owner), Tier::Gold, "total={amount}"),
                other => panic!("vector file names an unknown tier {other}"),
            }
        }
    }

    // per probe so the gate's monotonically-increasing total cannot mask a
    // boundary by accumulation.
    #[test]
    fn tier_boundaries_are_inclusive_at_exact_and_exclusive_below() {
        for (amount, expect) in [
            (9_999_999u64, None),                    // one stroop below Bronze: nothing earned
            (10_000_000, Some(Tier::Bronze)),        // exact boundary: included
            (99_999_999, Some(Tier::Bronze)),        // one below Silver: stays Bronze
            (100_000_000, Some(Tier::Silver)),       // exact: included
            (999_999_999, Some(Tier::Silver)),       // one below Gold: stays Silver
            (1_000_000_000, Some(Tier::Gold)),        // exact: included
        ] {
            let w = world();
            w.env.mock_all_auths();
            migrate(&w, amount, 1);
            let client = CampaignClient::new(&w.env, &w.camp);
            match expect {
                None => assert_eq!(client.try_claim_tier(&w.owner), Err(Ok(CampError::BelowBronze)),
                                    "below-Bronze must earn nothing, got a tier at {}", amount),
                Some(t) => assert_eq!(client.claim_tier(&w.owner), t,
                                       "wrong tier at {}", amount),
            }
        }
    }
}
