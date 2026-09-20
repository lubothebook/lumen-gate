// Unit + property tests for gate_battery (DIRECTIVE 2.0, 5.3 and section 8).
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_battery::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, vec, Address, Env, Symbol};

    const D7: i128 = 1_000_000; // 1 USDC at 7 decimals

    #[contract]
    pub struct Target;

    #[contractimpl]
    impl Target {
        pub fn work(env: Env) -> i128 {
            env.ledger().sequence() as i128
        }
        pub fn fail() {
            // Test-side trap: simulates a target call that cannot complete.
            panic!("target: forced failure");
        }
    }

    struct World {
        env: Env,
        battery_id: Address,
        token: Address,
        // Held, not read: the token contract needs an admin at construction
        // and the World owns that address so the fixture stays self-contained.
        // Dropping the field would mean re-deriving it wherever a test needs
        // to mint, so it is marked rather than removed.
        #[allow(
            dead_code,
            reason = "owned by the fixture for token setup, not asserted on"
        )]
        admin: Address,
        owner: Address,
        relayer: Address,
        target_id: Address,
    }

    fn world() -> World {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let battery_id = env.register(GateBattery, ());
        GateBatteryClient::new(&env, &battery_id).initialize(&token);
        let owner = Address::generate(&env);
        let relayer = Address::generate(&env);
        let target_id = env.register(Target, ());
        World {
            env,
            battery_id,
            token,
            admin,
            owner,
            relayer,
            target_id,
        }
    }

    fn mint(w: &World, to: &Address, amount: i128) {
        soroban_sdk::token::StellarAssetClient::new(&w.env, &w.token).mint(to, &amount);
    }

    fn vault_balance(w: &World) -> i128 {
        soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.battery_id)
    }

    // ---- basic accounting ----

    #[test]
    fn deposit_grows_owner_balance_and_vault() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        assert_eq!(client.balance_of(&w.owner), 0);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(5 * D7));
        assert_eq!(client.balance_of(&w.owner), 5 * D7);
        assert_eq!(vault_balance(&w), 5 * D7);
        // someone else may top up the same owner
        let friend = Address::generate(&w.env);
        mint(&w, &friend, 3 * D7);
        client.deposit(&friend, &w.owner, &(2 * D7));
        assert_eq!(client.balance_of(&w.owner), 7 * D7);
        assert_eq!(vault_balance(&w), 7 * D7);
    }

    #[test]
    fn second_initialize_reverts_and_zero_amounts_revert() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        let again = client.try_initialize(&w.token);
        assert_eq!(again, Err(Ok(BatteryError::AlreadyInitialized)));
        mint(&w, &w.owner, D7);
        assert_eq!(
            client.try_deposit(&w.owner, &w.owner, &0),
            Err(Ok(BatteryError::ZeroAmount))
        );
        client.deposit(&w.owner, &w.owner, &D7);
        assert_eq!(
            client.try_withdraw(&w.owner, &0),
            Err(Ok(BatteryError::ZeroAmount))
        );
        assert_eq!(
            client.try_withdraw(&w.owner, &(2 * D7)),
            Err(Ok(BatteryError::InsufficientBalance))
        );
    }

    #[test]
    fn withdraw_is_always_open_and_moves_usdc_out() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 4 * D7);
        client.deposit(&w.owner, &w.owner, &(4 * D7));
        client.withdraw(&w.owner, &(3 * D7));
        assert_eq!(client.balance_of(&w.owner), D7);
        assert_eq!(vault_balance(&w), D7);
        let owner_usdc = soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.owner);
        assert_eq!(owner_usdc, 3 * D7); // 1 left in battery, 3 back in wallet
                                        // drain it completely
        client.withdraw(&w.owner, &D7);
        assert_eq!(client.balance_of(&w.owner), 0);
        assert_eq!(vault_balance(&w), 0);
    }

    // ---- forward: the fee path ----

    #[test]
    fn forward_pays_relayer_from_battery_and_runs_target() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(10 * D7));
        let expiry = w.env.ledger().sequence() + 100;
        client.forward(
            &w.owner,
            &w.relayer,
            &(2 * D7),
            &(2 * D7),
            &expiry,
            &7,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        assert_eq!(client.balance_of(&w.owner), 8 * D7);
        let relayer_usdc = soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.relayer);
        assert_eq!(relayer_usdc, 2 * D7); // the fee arrived in USDC
        assert_eq!(vault_balance(&w), 8 * D7);
    }

    #[test]
    fn forward_rejects_fee_above_signed_cap() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(10 * D7));
        let expiry = w.env.ledger().sequence() + 100;
        let res = client.try_forward(
            &w.owner,
            &w.relayer,
            &(3 * D7),
            &(2 * D7),
            &expiry,
            &8,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        assert_eq!(res, Err(Ok(BatteryError::FeeAboveCap)));
        assert_eq!(client.balance_of(&w.owner), 10 * D7);
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.relayer),
            0
        );
    }

    #[test]
    fn forward_rejects_expired_and_replayed_nonce() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(10 * D7));
        let past = w.env.ledger().sequence();
        let res = client.try_forward(
            &w.owner,
            &w.relayer,
            &D7,
            &(2 * D7),
            &past,
            &9,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        assert_eq!(res, Err(Ok(BatteryError::Expired)));
        let expiry = w.env.ledger().sequence() + 100;
        client.forward(
            &w.owner,
            &w.relayer,
            &D7,
            &(2 * D7),
            &expiry,
            &9,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        let replay = client.try_forward(
            &w.owner,
            &w.relayer,
            &D7,
            &(2 * D7),
            &expiry,
            &9,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        assert_eq!(replay, Err(Ok(BatteryError::NonceUsed)));
    }

    #[test]
    fn a_failing_target_unwinds_the_fee() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(10 * D7));
        let before = client.balance_of(&w.owner);
        let expiry = w.env.ledger().sequence() + 100;
        let res = client.try_forward(
            &w.owner,
            &w.relayer,
            &D7,
            &(2 * D7),
            &expiry,
            &10,
            &w.target_id,
            &Symbol::new(&w.env, "fail"),
            &vec![&w.env],
        );
        assert!(res.is_err(), "the failing target must trap the whole call");
        assert_eq!(client.balance_of(&w.owner), before, "fee must come back");
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.relayer),
            0
        );
        assert_eq!(vault_balance(&w), before);
    }

    #[test]
    fn a_hostile_relayer_cannot_drain_more_than_the_cap() {
        // The relayer chooses `fee` at submission, but the owner signed
        // max_fee. Even if the relayer submits fee == max_fee exactly, that
        // is the most it can ever take - and it can never change target/fn.
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 100 * D7);
        client.deposit(&w.owner, &w.owner, &(100 * D7));
        let expiry = w.env.ledger().sequence() + 100;
        let max_fee = 3 * D7;
        for nonce in 1u64..=10 {
            client.forward(
                &w.owner,
                &w.relayer,
                &max_fee,
                &max_fee,
                &expiry,
                &nonce,
                &w.target_id,
                &Symbol::new(&w.env, "work"),
                &vec![&w.env],
            );
        }
        assert_eq!(client.balance_of(&w.owner), 70 * D7);
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.relayer),
            30 * D7
        );
    }

    #[test]
    fn forward_with_empty_battery_gives_a_clean_error() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        let expiry = w.env.ledger().sequence() + 100;
        let res = client.try_forward(
            &w.owner,
            &w.relayer,
            &D7,
            &(2 * D7),
            &expiry,
            &11,
            &w.target_id,
            &Symbol::new(&w.env, "work"),
            &vec![&w.env],
        );
        assert_eq!(res, Err(Ok(BatteryError::InsufficientBalance)));
    }

    // ---- the invariant: the battery can never claim more than it holds ----

    #[test]
    fn invariant_sum_of_balances_equals_vault_usdc() {
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        let owners = [
            Address::generate(&w.env),
            Address::generate(&w.env),
            Address::generate(&w.env),
            Address::generate(&w.env),
        ];
        mint(&w, &owners[0], 50 * D7);
        mint(&w, &owners[1], 50 * D7);
        mint(&w, &owners[2], 50 * D7);
        mint(&w, &owners[3], 50 * D7);
        // deterministic pseudo-random operations: deposits from any owner to
        // any owner, withdrawals, forwards - then check the invariant.
        let mut op = 7u32;
        for _ in 0..120 {
            op = op.wrapping_mul(48271).wrapping_add(11);
            let i = (op % 4) as usize;
            let j = ((op >> 3) % 4) as usize;
            match (op >> 6) % 3 {
                0 => {
                    let amt = ((op % 9) as i128 + 1) * D7;
                    if soroban_sdk::token::Client::new(&w.env, &w.token).balance(&owners[i]) >= amt
                    {
                        client.deposit(&owners[i], &owners[j], &amt);
                    }
                }
                1 => {
                    let bal = client.balance_of(&owners[j]);
                    let amt = (op % bal.max(1).max(1) as u32) as i128 + 1;
                    if amt >= 1 {
                        let take = if amt > bal { bal } else { amt };
                        if take > 0 {
                            client.withdraw(&owners[j], &take);
                        }
                    }
                }
                _ => {
                    let bal = client.balance_of(&owners[j]);
                    if bal >= D7 {
                        let fee = D7;
                        let max_fee = (bal / D7).min(3) * D7;
                        let expiry = w.env.ledger().sequence() + 100;
                        let nonce = (op % 10_000) as u64;
                        let res = client.try_forward(
                            &owners[j],
                            &w.relayer,
                            &fee,
                            &max_fee,
                            &expiry,
                            &nonce,
                            &w.target_id,
                            &Symbol::new(&w.env, "work"),
                            &vec![&w.env],
                        );
                        if res.is_err() {
                            // a nonce collision is fine: it just means the
                            // operation was a no-op, and the invariant holds
                        }
                    }
                }
            }
            // the invariant, checked after EVERY operation
            let sum: i128 = owners.iter().map(|o| client.balance_of(o)).sum();
            assert_eq!(sum, vault_balance(&w), "battery invariant broken at op");
        }
    }

    #[test]
    fn wallet_usdc_and_battery_are_separate_ledgers() {
        // Spending the wallet's USDC must not touch the battery at all.
        let w = world();
        let client = GateBatteryClient::new(&w.env, &w.battery_id);
        mint(&w, &w.owner, 10 * D7);
        client.deposit(&w.owner, &w.owner, &(4 * D7));
        let sink = Address::generate(&w.env);
        // the owner spends all remaining wallet USDC
        soroban_sdk::token::Client::new(&w.env, &w.token).transfer(&w.owner, &sink, &(6 * D7));
        assert_eq!(
            soroban_sdk::token::Client::new(&w.env, &w.token).balance(&w.owner),
            0
        );
        assert_eq!(
            client.balance_of(&w.owner),
            4 * D7,
            "battery must be untouched"
        );
    }
}
