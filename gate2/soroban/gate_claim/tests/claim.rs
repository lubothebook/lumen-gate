// Unit tests for GateClaim v2 (DIRECTIVE 2.0, 5.2 + section 8 negatives).
//
// AUTH NOTE: the whole suite runs with REAL auth (no mock_all_auths). The
// claim flow authorizes itself as a contract (self-auth for its own token
// transfers and for the minter restriction of the ticket), and the one
// deeper call — the Battery's token transfer on the claim's behalf — is
// covered by the contract's authorize_as_current_contract entry, which the
// host enforces for real here.
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_battery::GateBatteryClient;
    use gate_claim::*;
    use gate_ticket::GateTicketClient;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{address_payload::AddressPayload, vec, Address, Bytes, BytesN, Env, String};
    use std::vec as stdvec;
    // Was `type StdVec = stdvec::Vec<u8>;` - `u8` there is a generic
    // parameter name that shadows the primitive, so the alias silently meant
    // "Vec of anything" and the u8 in the body referred to the parameter, not
    // the type. It happened to compile because every use passes u8 anyway.
    type StdVec = stdvec::Vec<u8>;
    use test_mt::TestMt;

    const D6: i128 = 1_000_000; // 1 USDC, 6 decimals (Ethereum side, hook units)
                                // Kept as documentation of the decimal boundary this suite exercises: the
                                // hook carries 6dp and the Stellar side stores 7dp. No assertion needs the
                                // constant today, so it is marked rather than deleted - removing it would
                                // lose the only place the x10 relationship is written down.
    #[allow(
        dead_code,
        reason = "documents the 6dp/7dp boundary these vectors cross"
    )]
    const D7C: i128 = 10_000_000; // 1 USDC, 7 decimals (Stellar side = D6 x 10)
    const BURN_TOKEN: [u8; 32] = [0xab; 32];
    const FAKE_ROUTER: [u8; 32] = [0x77; 32];
    const SRC_DOMAIN: u32 = 0; // Ethereum Sepolia

    struct World {
        env: Env,
        claim_id: Address,
        mt_id: Address,
        token: Address,
        battery_id: Address,
        ticket_id: Address,
        relayer: Address,
        a: Address,
        router32: BytesN<32>,
    }

    fn p32(a: &Address) -> BytesN<32> {
        let p = AddressPayload::from_address(a).unwrap();
        match p {
            AddressPayload::AccountIdPublicKeyEd25519(b) => b,
            AddressPayload::ContractIdHash(b) => b,
        }
    }

    fn world() -> World {
        let env = Env::default();
        // token admin = the MT (it mints with its own self-auth, real auth)
        let mt_id = env.register(TestMt, ());
        let token = env
            .register_stellar_asset_contract_v2(mt_id.clone())
            .address();
        test_mt::TestMtClient::new(&env, &mt_id).initialize(&token);
        let battery_id = env.register(gate_battery::GateBattery, ());
        GateBatteryClient::new(&env, &battery_id).initialize(&token);
        let ticket_id = env.register(gate_ticket::GateTicket, ());
        GateTicketClient::new(&env, &ticket_id).initialize(&token, &battery_id);
        let claim_id = env.register(GateClaim, ());
        GateClaimClient::new(&env, &claim_id).initialize(
            &mt_id,
            &token,
            &BytesN::from_array(&env, &BURN_TOKEN),
            &BytesN::from_array(&env, &FAKE_ROUTER),
            &battery_id,
            &ticket_id,
            &vec![&env, SRC_DOMAIN],
        );
        // GateClaim is the ticket's only minter
        GateTicketClient::new(&env, &ticket_id).init_minter(&claim_id);
        let relayer = Address::generate(&env);
        let a = Address::generate(&env);
        let router32 = BytesN::from_array(&env, &FAKE_ROUTER);
        World {
            env,
            claim_id,
            mt_id,
            token,
            battery_id,
            ticket_id,
            relayer,
            a,
            router32,
        }
    }

    /// Builds a hookData v1 (DIRECTIVE 5.1) for the given recipient.
    fn build_hook(
        _env: &Env,
        recipient: &Address,
        cap_6: i128,
        battery_6: i128,
        ticket_mode: bool,
        name: &str,
    ) -> StdVec {
        let skey = recipient.to_string().to_string();
        let mut out: StdVec = stdvec![];
        out.extend_from_slice(&[0u8; 24]); // the hook's fixed 24-byte pad
        out.extend_from_slice(&1u32.to_be_bytes()); // version
        let payload_len: usize =
            1 + 16 + 16 + 1 + skey.len() + if !name.is_empty() { 1 + name.len() } else { 0 };
        out.extend_from_slice(&(payload_len as u32).to_be_bytes());
        let mut flags: u8 = 0;
        if ticket_mode {
            flags |= 4;
        }
        if !name.is_empty() {
            flags |= 1;
        }
        out.push(flags);
        out.extend_from_slice(&(cap_6 as u128).to_be_bytes());
        out.extend_from_slice(&(battery_6 as u128).to_be_bytes());
        out.push(skey.len() as u8);
        out.extend_from_slice(skey.as_bytes());
        if !name.is_empty() {
            out.push(name.len() as u8);
            out.extend_from_slice(name.as_bytes());
        }
        out
    }

    /// Builds a full CCTP V2 message (Circle's documented format).
    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the CCTP V2 message field-for-field; fewer parameters would mean a test builder that no longer matches the format under test"
    )]
    fn build_message_raw(
        claim32: &BytesN<32>,
        router32: &BytesN<32>,
        nonce_seed: u64,
        amount_6: i128,
        recipient: &Address,
        cap_6: i128,
        battery_6: i128,
        ticket_mode: bool,
        name: &str,
        env: &Env,
    ) -> StdVec {
        let b: StdVec = build_message_inner(
            claim32,
            router32,
            nonce_seed,
            amount_6,
            recipient,
            cap_6,
            battery_6,
            ticket_mode,
            name,
        );
        let _ = env;
        b
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the CCTP V2 message field-for-field; fewer parameters would mean a test builder that no longer matches the format under test"
    )]
    fn build_message(
        claim32: &BytesN<32>,
        router32: &BytesN<32>,
        nonce_seed: u64,
        amount_6: i128,
        recipient: &Address,
        cap_6: i128,
        battery_6: i128,
        ticket_mode: bool,
        name: &str,
        env: &Env,
    ) -> Bytes {
        let b = build_message_inner(
            claim32,
            router32,
            nonce_seed,
            amount_6,
            recipient,
            cap_6,
            battery_6,
            ticket_mode,
            name,
        );
        Bytes::from_slice(env, &b)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the CCTP V2 message field-for-field; fewer parameters would mean a test builder that no longer matches the format under test"
    )]
    fn build_message_inner(
        claim32: &BytesN<32>,
        router32: &BytesN<32>,
        nonce_seed: u64,
        amount_6: i128,
        recipient: &Address,
        cap_6: i128,
        battery_6: i128,
        ticket_mode: bool,
        name: &str,
    ) -> StdVec {
        let mut nonce = [0u8; 32];
        nonce[..8].copy_from_slice(&nonce_seed.to_be_bytes());
        let mut sender = [0u8; 32];
        sender[0] = 0xee; // source-side sender (the router EOA on Sepolia)

        let mut b: StdVec = stdvec![];
        b.extend_from_slice(&1u32.to_be_bytes()); // header version
        b.extend_from_slice(&SRC_DOMAIN.to_be_bytes());
        b.extend_from_slice(&27u32.to_be_bytes());
        b.extend_from_slice(&nonce);
        b.extend_from_slice(&sender);
        b.extend_from_slice(&claim32.to_array()); // recipient
        b.extend_from_slice(&claim32.to_array()); // destinationCaller
        b.extend_from_slice(&0u32.to_be_bytes()); // minFinalityThreshold
        b.extend_from_slice(&0u32.to_be_bytes()); // finalityThresholdExecuted
        b.extend_from_slice(&1u32.to_be_bytes()); // body version
        b.extend_from_slice(&BURN_TOKEN);
        b.extend_from_slice(&claim32.to_array()); // mintRecipient
        let mut amt = [0u8; 32];
        amt[24..].copy_from_slice(&(amount_6 as u64).to_be_bytes());
        b.extend_from_slice(&amt);
        b.extend_from_slice(&router32.to_array()); // messageSender
        b.extend_from_slice(&[0u8; 32]); // maxFee
        b.extend_from_slice(&[0u8; 32]); // feeExecuted
        b.extend_from_slice(&[0u8; 32]); // expirationBlock
        b.extend_from_slice(
            &build_hook(
                &Env::default(),
                recipient,
                cap_6,
                battery_6,
                ticket_mode,
                name,
            )
            .into_boxed_slice(),
        );
        b
    }

    const ATT65: [u8; 65] = [0x11; 65];

    fn claim32_of(w: &World) -> BytesN<32> {
        p32(&w.claim_id)
    }

    fn att(w: &World) -> Bytes {
        Bytes::from_slice(&w.env, &ATT65)
    }

    fn ok_claim(w: &World, nonce_seed: u64, amount_6: i128, to: &Address, relay_6: i128) -> u64 {
        let msg = build_message(
            &claim32_of(w),
            &w.router32,
            nonce_seed,
            amount_6,
            to,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        GateClaimClient::new(&w.env, &w.claim_id).claim(&msg, &att(w), &w.relayer, &relay_6)
    }

    // ============================ positive paths ===========================

    #[test]
    fn mod0_straight_to_wallet_with_relay_fee() {
        let w = world();
        let amount_6 = 10 * D6; // 10 USDC burned
        let relay_6 = D6 / 5; // 0.2 USDC
        let id = ok_claim(&w, 1, amount_6, &w.a, relay_6);
        assert_eq!(id, 0);
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.a),
            amount_6 * 10 - relay_6 * 10
        );
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.relayer),
            relay_6 * 10
        );
        // the claim keeps nothing
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.claim_id),
            0
        );
        // passport: soulbound proof + summary for the first recipient
        let c = GateClaimClient::new(&w.env, &w.claim_id);
        let proof = c.get_proof(&id).unwrap();
        assert_eq!(proof.owner, w.a);
        assert_eq!(proof.amount_6, amount_6);
        assert_eq!(proof.relay_6, relay_6);
        assert_eq!(proof.mode, 0u32);
        let mig = c.get_migration(&w.a).unwrap();
        assert_eq!(mig.total_usdc, amount_6);
        assert_eq!(mig.claim_count, 1);
        assert!(c.has_migrated_at_least(&w.a, &D6));
    }

    #[test]
    fn battery_share_lands_in_the_battery_with_real_nested_auth() {
        let w = world();
        let amount_6 = 10 * D6;
        let battery_6 = 2 * D6;
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            2,
            amount_6,
            &w.a,
            10 * D6,
            battery_6,
            false,
            "",
            &w.env,
        );
        let id =
            GateClaimClient::new(&w.env, &w.claim_id).claim(&msg, &att(&w), &w.relayer, &0i128);
        assert_eq!(id, 0);
        // battery credited the recipient with the hook's battery share
        assert_eq!(
            GateBatteryClient::new(&w.env, &w.battery_id).balance_of(&w.a),
            battery_6 * 10
        );
        // the USDC physically moved into the battery vault
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.battery_id),
            battery_6 * 10
        );
        // recipient got the rest straight to wallet
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.a),
            amount_6 * 10 - battery_6 * 10
        );
    }

    #[test]
    fn ticket_mode_mints_into_the_ticket_vault() {
        let w = world();
        let amount_6 = 5 * D6;
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            3,
            amount_6,
            &w.a,
            10 * D6,
            0,
            true,
            "first star",
            &w.env,
        );
        let id =
            GateClaimClient::new(&w.env, &w.claim_id).claim(&msg, &att(&w), &w.relayer, &0i128);
        assert_eq!(id, 0);
        let tclient = GateTicketClient::new(&w.env, &w.ticket_id);
        let tickets = tclient.tickets_of(&w.a);
        assert_eq!(tickets.len(), 1);
        let t = tclient.get_ticket(&tickets.get(0).unwrap()).unwrap();
        assert_eq!(t.amount, amount_6 * 10);
        assert_eq!(
            tclient.owner_of(&tickets.get(0).unwrap()),
            Some(w.a.clone())
        );
        // vault = live total (the 1:1 invariant, right after a claim)
        assert_eq!(tclient.live_total(), amount_6 * 10);
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.ticket_id),
            amount_6 * 10
        );
        // the star name survived into the ticket origin
        assert_eq!(t.origin, String::from_str(&w.env, "first star"));
        // passport still credits the first recipient
        let mig = GateClaimClient::new(&w.env, &w.claim_id)
            .get_migration(&w.a)
            .unwrap();
        assert_eq!(mig.total_usdc, amount_6);
    }

    // ============================ section 8 negatives ======================

    #[test]
    fn second_claim_of_the_same_message_is_refused() {
        let w = world();
        ok_claim(&w, 4, D6, &w.a, 0i128);
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            4,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        let res =
            GateClaimClient::new(&w.env, &w.claim_id).try_claim(&msg, &att(&w), &w.relayer, &0i128);
        // the MT consumes the nonce first (replay protection #1); our hash
        // set (#2) would refuse the same message bytes even with a fresh nonce
        assert!(res.is_err());
    }

    #[test]
    fn corrupted_attestation_is_refused() {
        let w = world();
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            5,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        let bad = Bytes::from_slice(&w.env, &[0u8; 64]); // 64, not 65
        let res =
            GateClaimClient::new(&w.env, &w.claim_id).try_claim(&msg, &bad, &w.relayer, &0i128);
        assert!(res.is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.a),
            0
        );
    }

    #[test]
    fn message_with_a_foreign_destination_caller_cannot_be_processed() {
        let w = world();
        let mut arr = build_message_raw(
            &claim32_of(&w),
            &w.router32,
            6,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        arr[110] = 0xde; // destinationCaller is no longer this contract
        let res = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
            &Bytes::from_slice(&w.env, &arr),
            &att(&w),
            &w.relayer,
            &0i128,
        );
        assert!(res.is_err());
    }

    #[test]
    fn burn_not_made_by_the_bound_router_is_refused() {
        let w = world();
        let other_router = BytesN::from_array(&w.env, &[0x99; 32]);
        let msg = build_message(
            &claim32_of(&w),
            &other_router,
            7,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        let res =
            GateClaimClient::new(&w.env, &w.claim_id).try_claim(&msg, &att(&w), &w.relayer, &0i128);
        assert!(res.is_err());
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.a),
            0
        );
    }

    #[test]
    fn relay_fee_above_the_hook_cap_is_refused() {
        let w = world();
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            8,
            D6,
            &w.a,
            D6 / 10,
            0,
            false,
            "",
            &w.env,
        );
        // cap is 0.1 USDC; we demand 0.2
        let res = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
            &msg,
            &att(&w),
            &w.relayer,
            &(2 * D6 / 10),
        );
        assert!(res.is_err());
    }

    #[test]
    fn relay_fee_above_the_hard_max_is_refused() {
        let w = world();
        let big = MAX_RELAY_FEE_7 / 10 + D6; // above the 10 USDC ceiling
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            9,
            1_000 * D6,
            &w.a,
            big,
            0,
            false,
            "",
            &w.env,
        );
        let res =
            GateClaimClient::new(&w.env, &w.claim_id).try_claim(&msg, &att(&w), &w.relayer, &big);
        assert!(res.is_err());
    }

    #[test]
    fn fees_covering_the_whole_mint_are_refused() {
        let w = world();
        let amount_6 = D6;
        // relay fee == the whole amount: the recipient would get nothing
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            10,
            amount_6,
            &w.a,
            amount_6,
            0,
            false,
            "",
            &w.env,
        );
        let res = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
            &msg,
            &att(&w),
            &w.relayer,
            &amount_6,
        );
        assert!(res.is_err());
    }

    #[test]
    fn star_name_outside_the_character_set_is_refused() {
        let w = world();
        for bad in [
            "<script>",
            "a\"b",
            "a&b",
            "a b c d e f g h i j k l m n o p q r s",
        ] {
            let msg = build_message(
                &claim32_of(&w),
                &w.router32,
                11,
                D6,
                &w.a,
                10 * D6,
                0,
                true,
                bad,
                &w.env,
            );
            let res = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
                &msg,
                &att(&w),
                &w.relayer,
                &0i128,
            );
            assert!(res.is_err(), "name {} must be refused", bad);
        }
        // and a valid one goes through
        let msg = build_message(
            &claim32_of(&w),
            &w.router32,
            12,
            D6,
            &w.a,
            10 * D6,
            0,
            true,
            "nova star 7",
            &w.env,
        );
        let id =
            GateClaimClient::new(&w.env, &w.claim_id).claim(&msg, &att(&w), &w.relayer, &0i128);
        assert_eq!(
            GateClaimClient::new(&w.env, &w.claim_id)
                .get_meta(&id)
                .unwrap()
                .star_name,
            String::from_str(&w.env, "nova star 7")
        );
    }

    #[test]
    fn disallowed_source_domain_and_wrong_burn_token_are_refused() {
        let w = world();
        // source domain 1 (not in `allowed`)
        let mut arr = build_message_raw(
            &claim32_of(&w),
            &w.router32,
            13,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        arr[5] = 1;
        let res = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
            &Bytes::from_slice(&w.env, &arr),
            &att(&w),
            &w.relayer,
            &0i128,
        );
        assert!(res.is_err());
        // wrong burn token
        let mut arr2 = build_message_raw(
            &claim32_of(&w),
            &w.router32,
            14,
            D6,
            &w.a,
            10 * D6,
            0,
            false,
            "",
            &w.env,
        );
        arr2[152] = 0x55;
        let res2 = GateClaimClient::new(&w.env, &w.claim_id).try_claim(
            &Bytes::from_slice(&w.env, &arr2),
            &att(&w),
            &w.relayer,
            &0i128,
        );
        assert!(res2.is_err());
    }

    #[test]
    fn second_initialize_is_refused() {
        let w = world();
        let res = GateClaimClient::new(&w.env, &w.claim_id).try_initialize(
            &w.mt_id,
            &w.token,
            &BytesN::from_array(&w.env, &BURN_TOKEN),
            &w.router32,
            &w.battery_id,
            &w.ticket_id,
            &vec![&w.env, SRC_DOMAIN],
        );
        assert!(res.is_err());
        // the passport query API is stable and readable
        assert!(GateClaimClient::new(&w.env, &w.claim_id)
            .get_migration(&w.a)
            .is_none());
    }
}
