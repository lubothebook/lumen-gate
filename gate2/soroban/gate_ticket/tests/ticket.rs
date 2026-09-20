// Unit + property tests for gate_ticket (DIRECTIVE 2.0, 5.4 and section 8).
//
// AUTH NOTE: most tests here run with REAL auth (no mock_all_auths): the
// minter restriction and the ownership checks are the security-relevant
// parts and they must be proven against the host's own authorization
// engine, not against a bypass.
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_ticket::*;
    use gate_battery::GateBatteryClient;
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal as _;
    use soroban_sdk::{
        contract, contractimpl, token, vec, Address, BytesN, Env, String, Vec,
    };

    const D7: i128 = 1_000_000; // 1 USDC at 7 decimals

    /// Token admin helper: mints with its own contract self-auth, so the
    /// rest of the suite can keep REAL auth (no mock_all_auths).
    #[contract]
    pub struct TestAdmin;

    #[contractimpl]
    impl TestAdmin {
        pub fn mint(env: Env, token: Address, to: Address, amount: i128) {
            token::StellarAssetClient::new(&env, &token).mint(&to, &amount);
        }
    }

    /// The only contract allowed to mint: stands in for GateClaim.
    ///
    /// Mirrors production exactly: GateClaim receives the USDC (CCTP mint),
    /// moves the ticketed slice into the vault with its own auth, then calls
    /// `mint_ticket` — one atomic call, no account auth involved.
    #[contract]
    pub struct MockMinter;

    #[contractimpl]
    impl MockMinter {
        pub fn mint(
            env: Env,
            ticket: Address,
            usdc: Address,
            to: Address,
            amount: i128,
            source_domain: u32,
            seed: u64,
            star_name: String,
        ) -> u64 {
            token::Client::new(&env, &usdc)
                .transfer(&env.current_contract_address(), &ticket, &amount);
            let mut arr = [0u8; 32];
            arr[0] = (seed & 0xff) as u8;
            arr[1] = ((seed >> 8) & 0xff) as u8;
            let hash = BytesN::from_array(&env, &arr);
            GateTicketClient::new(&env, &ticket)
                .mint_ticket(&to, &amount, &source_domain, &hash, &star_name)
        }
    }

    struct World {
        env: Env,
        ticket_id: Address,
        token: Address,
        admin_id: Address,
        minter_id: Address,
        battery_id: Address,
        a: Address,
        b: Address,
    }

    fn make_world(mock_auths: bool) -> World {
        let env = Env::default();
        if mock_auths {
            env.mock_all_auths();
        }
        let admin_id = env.register(TestAdmin, ());
        let token = env
            .register_stellar_asset_contract_v2(admin_id.clone())
            .address();
        let battery_id = env.register(gate_battery::GateBattery, ());
        GateBatteryClient::new(&env, &battery_id).initialize(&token);
        let ticket_id = env.register(GateTicket, ());
        GateTicketClient::new(&env, &ticket_id).initialize(&token, &battery_id);
        let minter_id = env.register(MockMinter, ());
        GateTicketClient::new(&env, &ticket_id).init_minter(&minter_id);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        World {
            env,
            ticket_id,
            token,
            admin_id,
            minter_id,
            battery_id,
            a,
            b,
        }
    }

    fn world() -> World {
        make_world(true)
    }

    fn hash(env: &Env, seed: u64) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = (seed & 0xff) as u8;
        arr[1] = ((seed >> 8) & 0xff) as u8;
        BytesN::from_array(env, &arr)
    }

    /// Funds the future minter (GateClaim's role) — in production the CCTP
    /// mint lands on GateClaim, here the admin mints to the MockMinter.
    fn fund_minter(w: &World, amount: i128) {
        TestAdminClient::new(&w.env, &w.admin_id).mint(&w.token, &w.minter_id, &amount);
    }

    fn mint_ticket(
        w: &World,
        to: &Address,
        amount: i128,
        domain: u32,
        seed: u64,
        name: &str,
    ) -> u64 {
        MockMinterClient::new(&w.env, &w.minter_id).mint(
            &w.ticket_id,
            &w.token,
            to,
            &amount,
            &domain,
            &seed,
            &String::from_str(&w.env, name),
        )
    }

    fn vault(w: &World) -> i128 {
        token::Client::new(&w.env, &w.token).balance(&w.ticket_id)
    }

    // ---- init / minter ----

    #[test]
    fn init_minter_is_one_shot() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        let other = Address::generate(&w.env);
        assert_eq!(
            client.try_init_minter(&other),
            Err(Ok(TicketError::MinterAlreadySet))
        );
    }

    #[test]
    fn only_the_minter_contract_can_mint() {
        let w = make_world(false); // real auth: no bypass
        fund_minter(&w, 10 * D7);
        // 1) direct call by an account: cannot satisfy the minter's self-auth
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        let res = client.try_mint_ticket(
            &w.a,
            &D7,
            &0u32,
            &hash(&w.env, 1),
            &String::from_str(&w.env, ""),
        );
        assert!(
            res.is_err(),
            "an account must never be able to mint a ticket"
        );
        assert_eq!(client.live_total(), 0);
        assert_eq!(vault(&w), 0);
        // 2) the minter contract itself: allowed (self-auth)
        let id = mint_ticket(&w, &w.a, D7, 0, 1, "");
        assert_eq!(id, 0);
        assert_eq!(client.live_total(), D7);
        assert_eq!(vault(&w), D7);
    }

    // ---- mint / vault ----

    #[test]
    fn mint_moves_usdc_into_the_vault_and_records_the_right() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 25 * D7);
        let id = mint_ticket(&w, &w.a, 25 * D7, 0, 2, "first star");
        assert_eq!(client.owner_of(&id), Some(w.a.clone()));
        assert_eq!(vault(&w), 25 * D7);
        assert_eq!(client.live_total(), 25 * D7);
        // the minter's wallet lost exactly the ticketed amount
        assert_eq!(
            token::Client::new(&w.env, &w.token).balance(&w.minter_id),
            0
        );
        let t = client.get_ticket(&id).unwrap();
        assert_eq!((t.amount, t.source_domain), (25 * D7, 0));
        assert_eq!(t.origin, String::from_str(&w.env, "first star"));
        {
            let uri = client.token_uri(&id).unwrap();
            let b = uri.to_bytes();
            let prefix = "data:application/json,";
            let ok = b.len() as usize >= prefix.len()
                && (0..prefix.len()).all(|i| b.get(i as u32) == Some(prefix.as_bytes()[i]));
            assert!(ok, "token_uri must be a json data uri: {}", uri);
        }
    }

    #[test]
    fn mint_rejects_zero_amount_and_bad_names() {
        let w = world();
        fund_minter(&w, D7);
        let mc = MockMinterClient::new(&w.env, &w.minter_id);
        assert!(mc
            .try_mint(
                &w.ticket_id,
                &w.token,
                &w.a,
                &0,
                &0u32,
                &3,
                &String::from_str(&w.env, "")
            )
            .is_err());
        assert!(mc
            .try_mint(
                &w.ticket_id,
                &w.token,
                &w.a,
                &D7,
                &0u32,
                &3,
                &String::from_str(&w.env, "<script>")
            )
            .is_err());
        let long = "aaaaaaaaaaaaaaaaaaaaaaaaa"; // 25 chars
        assert!(mc
            .try_mint(
                &w.ticket_id,
                &w.token,
                &w.a,
                &D7,
                &0u32,
                &3,
                &String::from_str(&w.env, long)
            )
            .is_err());
        // vault untouched by the failed attempts
        assert_eq!(vault(&w), 0);
        assert_eq!(
            GateTicketClient::new(&w.env, &w.ticket_id).live_total(),
            0
        );
    }

    // ---- transfer ----

    #[test]
    fn transfer_changes_only_ownership_never_the_vault() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 10 * D7);
        let id = mint_ticket(&w, &w.a, 10 * D7, 0, 4, "");
        assert_eq!(client.value_of(&w.a), 10 * D7);
        client.transfer(&w.a, &w.b, &id);
        assert_eq!(vault(&w), 10 * D7, "transfer must not move USDC");
        assert_eq!(client.live_total(), 10 * D7);
        assert_eq!(client.owner_of(&id), Some(w.b.clone()));
        assert_eq!(client.value_of(&w.a), 0);
        assert_eq!(client.value_of(&w.b), 10 * D7);
        assert_eq!(client.tickets_of(&w.b), vec![&w.env, id]);
        assert_eq!(client.tickets_of(&w.a), Vec::<u64>::new(&w.env));
    }

    #[test]
    fn an_ex_owner_without_a_signature_cannot_touch_the_ticket() {
        // REAL auth: the ticket's key is the current owner's signature.
        // After a transfer, the ex-owner holds no signature, so neither
        // redeem nor transfer by them can go through.
        let w = make_world(false);
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 10 * D7);
        let id = mint_ticket(&w, &w.a, 10 * D7, 0, 9, "");
        // a signs the transfer (mocked once, as a real signature would be)
        w.env.mock_auths(&[MockAuth {
            address: &w.a,
            invoke: &MockAuthInvoke {
                contract: &w.ticket_id,
                fn_name: "transfer",
                args: (w.a.clone(), w.b.clone(), id).into_val(&w.env),
                sub_invokes: &[],
            },
        }]);
        client.transfer(&w.a, &w.b, &id);
        // a (ex-owner, no signature) must not be able to redeem or transfer
        assert!(client.try_redeem(&id, &w.a).is_err());
        assert!(client.try_transfer(&w.a, &w.a, &id).is_err());
        // the ticket is intact and still worth 10
        assert_eq!(client.owner_of(&id), Some(w.b.clone()));
        assert_eq!(client.value_of(&w.b), 10 * D7);
    }

    // ---- redeem ----

    #[test]
    fn redeem_pays_the_full_amount_and_burns_the_ticket() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 10 * D7);
        let id = mint_ticket(&w, &w.a, 10 * D7, 0, 5, "");
        client.redeem(&id, &w.a);
        assert_eq!(
            token::Client::new(&w.env, &w.token).balance(&w.a),
            10 * D7
        );
        assert_eq!(client.get_ticket(&id), None);
        assert_eq!(client.live_total(), 0);
        assert_eq!(vault(&w), 0);
        // double spend is impossible
        assert_eq!(
            client.try_redeem(&id, &w.a),
            Err(Ok(TicketError::UnknownTicket))
        );
    }

    /// A token that refuses to pay one specific recipient — stands in for
    /// the live network's trustline enforcement (the test host's classic
    /// ledger does not enforce trustlines, but the REAL network does: you
    /// cannot hold USDC without a trustline, so a payout to a
    /// trustline-less account traps).
    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn poison(env: Env) {
            env.storage().instance().set(&"poisoned", &true);
        }

        pub fn transfer(env: Env, from: Address, _to: Address, _amount: i128) {
            if env.storage().instance().get::<_, bool>(&"poisoned").unwrap_or(false) {
                panic!("no trustline");
            }
            from.require_auth();
        }
    }

    #[test]
    fn redeem_reverts_atomically_when_the_payout_fails() {
        // The security property behind "trustline-less receiver": if the USDC
        // payout cannot be delivered, the whole tx reverts and the ticket
        // stays live, owned and valued — never a half-redemption.
        let env = Env::default();
        env.mock_all_auths();
        let token = env.register(MockToken, ());
        let battery_id = env.register(gate_battery::GateBattery, ());
        GateBatteryClient::new(&env, &battery_id).initialize(&token);
        let ticket_id = env.register(GateTicket, ());
        GateTicketClient::new(&env, &ticket_id).initialize(&token, &battery_id);
        let minter_id = env.register(MockMinter, ());
        GateTicketClient::new(&env, &ticket_id).init_minter(&minter_id);
        let a = Address::generate(&env);
        // fund + mint through the mock token (unpoisoned yet)
        // (MockMinter pulls with its own self-auth; balance bookkeeping is
        // internal to the mock — only the trap behavior matters here)
        let id: u64 = MockMinterClient::new(&env, &minter_id).mint(
            &ticket_id,
            &token,
            &a,
            &(10 * D7),
            &0u32,
            &6,
            &String::from_str(&env, ""),
        );
        let client = GateTicketClient::new(&env, &ticket_id);
        assert_eq!(client.owner_of(&id), Some(a.clone()));
        // now make the payout trap (like a missing trustline)
        MockTokenClient::new(&env, &token).poison();
        let res = client.try_redeem(&id, &a);
        assert!(res.is_err(), "a failed payout must revert the redemption");
        // the ticket must survive the failed tx, still owned, still valued
        assert_eq!(client.get_ticket(&id).unwrap().amount, 10 * D7);
        assert_eq!(client.owner_of(&id), Some(a.clone()));
        assert_eq!(client.live_total(), 10 * D7);
    }

    // ---- redeem_to_battery ----

    #[test]
    fn redeem_to_battery_needs_no_xlm_or_trustline() {
        // REAL auth for everything except the owner's signature (mocked as
        // one top-level entry): this exercises the nested
        // authorize_as_current_contract entry the contract passes for the
        // Battery's deeper token call.
        let w = make_world(false);
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        let bclient = GateBatteryClient::new(&w.env, &w.battery_id);
        fund_minter(&w, 7 * D7);
        let id = mint_ticket(&w, &w.a, 7 * D7, 0, 7, "");
        assert_eq!(bclient.balance_of(&w.a), 0);
        w.env.mock_auths(&[MockAuth {
            address: &w.a,
            invoke: &MockAuthInvoke {
                contract: &w.ticket_id,
                fn_name: "redeem_to_battery",
                args: (id,).into_val(&w.env),
                sub_invokes: &[],
            },
        }]);
        client.redeem_to_battery(&id);
        assert_eq!(
            bclient.balance_of(&w.a),
            7 * D7,
            "battery must credit the owner"
        );
        assert_eq!(client.get_ticket(&id), None);
        assert_eq!(vault(&w), 0);
        assert_eq!(
            token::Client::new(&w.env, &w.token).balance(&w.battery_id),
            7 * D7
        );
    }

    // ---- split ----

    #[test]
    fn split_preserves_the_total_and_rejects_mismatches() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 10 * D7);
        let id = mint_ticket(&w, &w.a, 10 * D7, 0, 8, "");
        // wrong sum is refused
        assert_eq!(
            client.try_split(&id, &vec![&w.env, 6 * D7, 6 * D7]),
            Err(Ok(TicketError::SplitMismatch))
        );
        assert_eq!(
            client.try_split(&id, &vec![&w.env, 0, 10 * D7]),
            Err(Ok(TicketError::ZeroAmount))
        );
        assert_eq!(
            client.try_split(&id, &Vec::<i128>::new(&w.env)),
            Err(Ok(TicketError::SplitMismatch))
        );
        let ids = client.split(&id, &vec![&w.env, 4 * D7, 6 * D7]);
        assert_eq!(ids.len(), 2);
        assert_eq!(client.get_ticket(&id), None, "parent must be burned");
        assert_eq!(client.live_total(), 10 * D7);
        assert_eq!(vault(&w), 10 * D7);
        assert_eq!(client.value_of(&w.a), 10 * D7);
        for cid in ids.iter() {
            assert_eq!(client.owner_of(&cid), Some(w.a.clone()));
        }
    }

    // ---- D8: approvals trap ----

    #[test]
    fn approvals_are_disabled() {
        let w = world();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        assert_eq!(
            client.try_approve(&w.a, &w.b, &0),
            Err(Ok(TicketError::ApprovalDisabled))
        );
        assert_eq!(
            client.try_approve_for_all(&w.a, &w.b),
            Err(Ok(TicketError::ApprovalDisabled))
        );
    }

    // ---- the 1:1 invariant (rule 7), proven over random sequences ----

    #[test]
    fn invariant_live_total_equals_vault_balance() {
        let mut w = world();
        // the property under test is ACCOUNTING (1:1 support), not auth;
        // the owner signatures here are incidental, so allow non-root auth.
        w.env.mock_all_auths_allowing_non_root_auth();
        let client = GateTicketClient::new(&w.env, &w.ticket_id);
        fund_minter(&w, 10_000 * D7);
        let mut op = 41u32;
        for round in 0..60u32 {
            op = op.wrapping_mul(48271).wrapping_add(17);
            match (op >> 4) % 5 {
                0 => {
                    // mint
                    let who = if op % 2 == 0 { &w.a } else { &w.b };
                    mint_ticket(&w, who, ((op % 20) as i128 + 1) * D7, (op % 2) as u32, round as u64, "");
                }
                1 => {
                    // transfer
                    let from = if op % 2 == 0 { &w.a } else { &w.b };
                    let to = if op % 2 == 0 { &w.b } else { &w.a };
                    let ids = client.tickets_of(from);
                    if !ids.is_empty() {
                        let id = ids.get((op % ids.len()) as u32).unwrap();
                        client.transfer(from, to, &id);
                    }
                }
                2 => {
                    // redeem (to a trusted account so it succeeds)
                    let from = if op % 2 == 0 { &w.a } else { &w.b };
                    w.env.mock_all_auths();
                    token::StellarAssetClient::new(&w.env, &w.token).trust(from);
                    let ids = client.tickets_of(from);
                    if !ids.is_empty() {
                        let id = ids.get((op % ids.len()) as u32).unwrap();
                        client.redeem(&id, from);
                    }
                }
                3 => {
                    // redeem_to_battery
                    let from = if op % 2 == 0 { &w.a } else { &w.b };
                    let ids = client.tickets_of(from);
                    if !ids.is_empty() {
                        let id = ids.get((op % ids.len()) as u32).unwrap();
                        client.redeem_to_battery(&id);
                    }
                }
                _ => {
                    // split
                    let from = if op % 2 == 0 { &w.a } else { &w.b };
                    let ids = client.tickets_of(from);
                    if !ids.is_empty() {
                        let id = ids.get((op % ids.len()) as u32).unwrap();
                        let t = client.get_ticket(&id).unwrap();
                        if t.amount >= 2 * D7 {
                            client.split(
                                &id,
                                &vec![&w.env, t.amount / 2, t.amount - t.amount / 2],
                            );
                        }
                    }
                }
            }
            // the invariant, checked after EVERY operation
            assert_eq!(
                client.live_total(),
                vault(&w),
                "1:1 invariant broken at round {} (live_total={}, vault={})",
                round,
                client.live_total(),
                vault(&w)
            );
        }
        // and the per-owner view agrees with the vault
        let va = client.value_of(&w.a);
        let vb = client.value_of(&w.b);
        assert_eq!(va + vb, vault(&w));
    }


}
