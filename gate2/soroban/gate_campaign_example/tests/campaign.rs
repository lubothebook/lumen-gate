// Tests for the campaign demo contract, living outside src/ so the production
// file is panic-form-free for the CI grep (HARDENING-2.0.md 5.1 pattern, same
// trade made for gate_claim; tests/ is the exempt zone).
//
// The demo is tested against the REAL GateClaim v2 (Design G, CCTP V2 wire
// format, 3-argument MessageTransmitter), not a double: the point is that an
// independent consumer contract interoperates through the fixed query
// surface. The CCTP leg is doubled by test_mt, which mirrors the deployed
// MessageTransmitter's observable behavior; live receipts belong to the
// manifest, not here.
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_campaign_example::*;
    use gate_claim::{GateClaim, GateClaimClient};
    use gate_ticket::GateTicketClient;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{address_payload::AddressPayload, vec, Address, Bytes, BytesN, Env};
    use test_mt::TestMt;

    const BURN_TOKEN: [u8; 32] = [0xab; 32];
    const FAKE_ROUTER: [u8; 32] = [0x77; 32];
    const ATT65: [u8; 65] = [0x11; 65];

    fn field32(a: &Address) -> BytesN<32> {
        match AddressPayload::from_address(a).expect("no 32 byte form") {
            AddressPayload::ContractIdHash(id) => id,
            AddressPayload::AccountIdPublicKeyEd25519(id) => id,
        }
    }

    /// CCTP V2 message (Circle's documented format) with a v1 hook whose
    /// recipient is `hook`.
    fn message(env: &Env, claim32: &BytesN<32>, amount_6: u64, hook: &Address, nonce: u64) -> Bytes {
        let mut out: std::vec::Vec<u8> = std::vec![];
        out.extend_from_slice(&1u32.to_be_bytes()); // header version
        out.extend_from_slice(&0u32.to_be_bytes()); // sourceDomain (Sepolia)
        out.extend_from_slice(&27u32.to_be_bytes());
        let mut n = [0u8; 32];
        n[..8].copy_from_slice(&nonce.to_be_bytes());
        out.extend_from_slice(&n);
        out.extend_from_slice(&[0xee; 32]); // sender
        out.extend_from_slice(&claim32.to_array()); // recipient
        out.extend_from_slice(&claim32.to_array()); // destinationCaller
        out.extend_from_slice(&0u32.to_be_bytes()); // minFinalityThreshold
        out.extend_from_slice(&0u32.to_be_bytes()); // finalityThresholdExecuted
        out.extend_from_slice(&1u32.to_be_bytes()); // body version
        out.extend_from_slice(&BURN_TOKEN);
        out.extend_from_slice(&claim32.to_array()); // mintRecipient
        let mut amt = [0u8; 32];
        amt[24..].copy_from_slice(&amount_6.to_be_bytes());
        out.extend_from_slice(&amt);
        out.extend_from_slice(&FAKE_ROUTER); // messageSender
        out.extend_from_slice(&[0u8; 32]); // maxFee
        out.extend_from_slice(&[0u8; 32]); // feeExecuted
        out.extend_from_slice(&[0u8; 32]); // expirationBlock
        // hook v1
        let skey = hook.to_string().to_string();
        for _ in 0..24 {
            out.push(0);
        }
        out.extend_from_slice(&1u32.to_be_bytes());
        let payload_len: u32 = 1 + 16 + 16 + 1 + skey.len() as u32;
        out.extend_from_slice(&payload_len.to_be_bytes());
        out.push(0u8); // flags
        out.extend_from_slice(&1_000u128.to_be_bytes()); // relay_fee_cap
        out.extend_from_slice(&0u128.to_be_bytes()); // battery_amount
        out.push(skey.len() as u8);
        out.extend_from_slice(skey.as_bytes());
        Bytes::from_slice(env, &out)
    }

    struct World {
        env: Env,
        gate: Address,
        camp: Address,
        owner: Address,
    }

    fn world() -> World {
        let env = Env::default();
        let mt = env.register(TestMt, ());
        let token = env.register_stellar_asset_contract_v2(mt.clone()).address();
        test_mt::TestMtClient::new(&env, &mt).initialize(&token);
        let battery = env.register(gate_battery::GateBattery, ());
        gate_battery::GateBatteryClient::new(&env, &battery).initialize(&token);
        let ticket = env.register(gate_ticket::GateTicket, ());
        GateTicketClient::new(&env, &ticket).initialize(&token, &battery);
        let gate = env.register(GateClaim, ());
        let burn_router = BytesN::from_array(&env, &FAKE_ROUTER);
        let allowed = vec![&env, 0u32];
        GateClaimClient::new(&env, &gate).initialize(
            &mt,
            &token,
            &BytesN::from_array(&env, &BURN_TOKEN),
            &burn_router,
            &battery,
            &ticket,
            &allowed,
        );
        GateTicketClient::new(&env, &ticket).init_minter(&gate);
        let camp = env.register(Campaign, ());
        CampaignClient::new(&env, &camp).initialize(&gate);
        let owner = Address::generate(&env);
        World { env, gate, camp, owner }
    }

    fn migrate(w: &World, amount_6: u64, nonce: u64) {
        let me = field32(&w.gate);
        let msg = message(&w.env, &me, amount_6, &w.owner, nonce);
        let att = Bytes::from_slice(&w.env, &ATT65);
        let relayer = Address::generate(&w.env);
        GateClaimClient::new(&w.env, &w.gate).claim(&msg, &att, &relayer, &0i128);
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
    // micro-USDC; each tier is tested at exact-minus-one and exact, fresh
    // world per probe so the gate's monotonically-increasing total cannot
    // mask a boundary by accumulation.
    #[test]
    fn tier_boundaries_are_inclusive_at_exact_and_exclusive_below() {
        for (amount, expect) in [
            (9_999_999u64, None),                    // one below Bronze: nothing earned
            (10_000_000, Some(Tier::Bronze)),        // exact boundary: included
            (99_999_999, Some(Tier::Bronze)),        // one below Silver: stays Bronze
            (100_000_000, Some(Tier::Silver)),       // exact: included
            (999_999_999, Some(Tier::Silver)),       // one below Gold: stays Silver
            (1_000_000_000, Some(Tier::Gold)),       // exact: included
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
