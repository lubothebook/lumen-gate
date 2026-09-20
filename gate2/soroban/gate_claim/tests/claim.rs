// Integration unit tests for gate_claim, moved out of src/lib.rs so the
// production file carries zero panic forms (HARDENING-2.0.md 5.1) while mock
// traps stay natural to test code. The CI grep exempts tests/ directories by
// convention; the exemption is visible in the workflow, the production rule
// is absolute.
#![cfg(test)]
#[cfg(test)]
mod test {
    use gate_claim::*;
    use soroban_sdk::address_payload::AddressPayload;
    use soroban_sdk::testutils::{storage::Persistent as _, Address as _, Ledger as _};
    use soroban_sdk::{contract, contractimpl, vec, Address, Bytes, BytesN, Env, IntoVal, Vec};

    const GOOD: u8 = 0xA7;

    #[contract]
    pub struct MockMt;

    #[contractimpl]
    impl MockMt {
        pub fn setup(env: Env, token: Address) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("token"), &token);
        }
        pub fn receive_message(env: Env, message: Bytes, attestation: Bytes) -> bool {
            if attestation.len() != 65 || attestation.get(0).unwrap() != GOOD {
                panic!("mockMt: attestation rejected");
            }
            let nonce = read_u64(&message, 12).unwrap_or(0);
            let used: bool = env.storage().instance().get(&nonce).unwrap_or(false);
            if used {
                panic!("mockMt: nonce already consumed");
            }
            env.storage().instance().set(&nonce, &true);
            let body = message.slice(HEADER as u32..);
            let mut raw = [0u8; 32];
            for i in 0..32 {
                raw[i] = body.get((36 + i) as u32).unwrap();
            }
            let recipient = AddressPayload::ContractIdHash(BytesN::from_array(&env, &raw)).to_address(&env);
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
        let _ = env;
        addr32(a).unwrap() // test-side unwrap: the tests/ directory is the grep-exempt zone by convention
    }

    fn build_message(
        env: &Env,
        src: u32,
        dst: u32,
        nonce: u64,
        caller: &BytesN<32>,
        recipient32: &BytesN<32>,
        burn_token: &BytesN<32>,
        amount_6: u64,
        hook_recipient: &Address,
    ) -> Bytes {
        let mut m = Bytes::new(env);
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&src.to_be_bytes());
        m.extend_from_slice(&dst.to_be_bytes());
        m.extend_from_slice(&nonce.to_be_bytes());
        m.extend_from_slice(&[9u8; 32]); // sender: the source TokenMessenger
        m.extend_from_slice(&recipient32.to_array());
        m.extend_from_slice(&caller.to_array());
        // BurnMessage
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&burn_token.to_array());
        m.extend_from_slice(&recipient32.to_array());
        m.extend_from_slice(&[0u8; 24]); // uint256 high words
        m.extend_from_slice(&amount_6.to_be_bytes());
        m.extend_from_slice(&[8u8; 32]); // messageSender
        // hookData: 24 zero bytes + u32 version + u32 strkey length + strkey
        m.extend_from_slice(&[0u8; 24]);
        m.extend_from_slice(&0u32.to_be_bytes());
        let sb = hook_recipient.to_string().to_bytes();
        m.extend_from_slice(&(sb.len() as u32).to_be_bytes());
        m.append(&sb);
        m
    }

    struct World {
        env: Env,
        claim_id: Address,
        token: Address,
        recipient: Address,
        burn_token: BytesN<32>,
    }

    fn world() -> World {
        let env = Env::default();
        // The mock MT is the SAC admin, exactly mirroring reality: on testnet
        // the minter authority sits with Circle's TokenMessengerMinter, so a
        // mint in the tests can only happen through a receive_message call.
        let mt = env.register(MockMt, ());
        let token = env.register_stellar_asset_contract_v2(mt.clone()).address();
        MockMtClient::new(&env, &mt).setup(&token);
        let claim_id = env.register(GateClaim, ());
        let burn_token = BytesN::from_array(&env, &[7u8; 32]);
        let mut allowed = Vec::new(&env);
        allowed.push_back(0u32); // Ethereum Sepolia, per the manifest
        GateClaimClient::new(&env, &claim_id).initialize(&mt, &token, &burn_token, &allowed);
        let recipient = Address::generate(&env);
        World { env, claim_id, token, recipient, burn_token }
    }

    fn attestation(env: &Env, good: bool) -> Bytes {
        let v = if good { GOOD } else { 0x01 };
        Bytes::from_slice(env, &[v; 65])
    }

    #[test]
    fn claim_forwards_mints_proof_and_summary() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 11, &me, &me, &w.burn_token, 25, &w.recipient);
        let usdc = soroban_sdk::token::Client::new(&w.env, &w.token);
        let id = client.claim(&msg, &attestation(&w.env, true));
        assert_eq!(id, 0);
        // 25 USDC at 6 decimals arrives as 250 in Stellar's 7, and all of it
        // leaves in the same transaction: the contract holds nothing after.
        assert_eq!(usdc.balance(&w.recipient), 250);
        assert_eq!(usdc.balance(&w.claim_id), 0);
        let meta = client.get_meta(&0).unwrap();
        assert_eq!((meta.amount_6, meta.fee_executed_6), (25, 0));
        assert_eq!(client.owner_of(&0), Some(w.recipient.clone()));
        let sum = client.get_migration(&w.recipient).unwrap();
        assert_eq!((sum.total_usdc, sum.claim_count), (25, 1));
        assert_eq!(sum.sources, vec![&w.env, 0u32]);
        assert!(client.has_migrated_at_least(&w.recipient, &25));
        assert!(!client.has_migrated_at_least(&w.recipient, &26));
        let proof = client.get_proof(&0).unwrap();
        assert_eq!((proof.owner.clone(), proof.nonce), (w.recipient.clone(), 11));
        assert_eq!(client.proofs_of(&w.recipient), vec![&w.env, 0u64]);
    }

    #[test]
    fn replay_of_the_same_message_is_refused() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 31, &me, &me, &w.burn_token, 5, &w.recipient);
        client.claim(&msg, &attestation(&w.env, true));
        let second = client.try_claim(&msg, &attestation(&w.env, true));
        assert_eq!(second, Err(Ok(GateError::MessageAlreadyClaimed)));
    }

    #[test]
    fn a_corrupted_attestation_traps_inside_receive_message() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 41, &me, &me, &w.burn_token, 5, &w.recipient);
        let res = client.try_claim(&msg, &attestation(&w.env, false));
        assert!(res.is_err(), "a bad attestation must never produce a claim");
        let usdc = soroban_sdk::token::Client::new(&w.env, &w.token);
        assert_eq!(usdc.balance(&w.recipient), 0, "nothing may move on a rejected attestation");
    }

    #[test]
    fn a_message_addressed_to_somebody_else_is_not_ours() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let other = field32(&w.env, &Address::generate(&w.env));
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 51, &other, &me, &w.burn_token, 5, &w.recipient);
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::NotDestinationCaller)));
        let msg = build_message(&w.env, 0, 27, 52, &me, &other, &w.burn_token, 5, &w.recipient);
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::NotMintRecipient)));
        let msg = build_message(&w.env, 5, 27, 53, &me, &me, &w.burn_token, 5, &w.recipient);
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::SourceDomainNotAllowed)));
        let msg = build_message(&w.env, 0, 26, 54, &me, &me, &w.burn_token, 5, &w.recipient);
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::WrongDestinationDomain)));
        let wrong_token = BytesN::from_array(&w.env, &[6u8; 32]);
        let msg = build_message(&w.env, 0, 27, 55, &me, &me, &wrong_token, 5, &w.recipient);
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::WrongBurnToken)));
    }

    #[test]
    fn a_broken_hook_is_refused_before_anything_moves() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let mut msg = build_message(&w.env, 0, 27, 61, &me, &me, &w.burn_token, 5, &w.recipient);
        msg.set((HEADER + BODY_FIXED) as u32, 1); // the 24 zero bytes are not zero
        assert_eq!(client.try_claim(&msg, &attestation(&w.env, true)), Err(Ok(GateError::BadHook)));
        let mut msg = build_message(&w.env, 0, 27, 62, &me, &me, &w.burn_token, 5, &w.recipient);
        let last = msg.len() - 1;
        msg.set(last, b'X'); // strkey checksum broken: nobody is addressable
        assert!(client.try_claim(&msg, &attestation(&w.env, true)).is_err());
        let usdc = soroban_sdk::token::Client::new(&w.env, &w.token);
        assert_eq!(usdc.balance(&w.claim_id), 0);
    }

    #[test]
    fn the_proof_is_soulbound_because_there_is_nothing_to_call() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 71, &me, &me, &w.burn_token, 5, &w.recipient);
        client.claim(&msg, &attestation(&w.env, true));
        // No transfer, no approve: the functions do not exist on this
        // contract, so a transfer attempt is an unknown-function error.
        let args = soroban_sdk::vec![&w.env, (0u64, w.recipient.clone()).into_val(&w.env)];
        let tried = w.env.try_invoke_contract::<u32, GateError>(
            &w.claim_id,
            &soroban_sdk::symbol_short!("transfer"),
            args,
        );
        assert!(tried.is_err(), "a soulbound proof must not be transferable, not even by its owner");
    }

    #[test]
    fn bump_keeps_the_record_alive_and_needs_nobody() {
        let w = world();
        let client = GateClaimClient::new(&w.env, &w.claim_id);
        let me = field32(&w.env, &w.claim_id);
        let msg = build_message(&w.env, 0, 27, 81, &me, &me, &w.burn_token, 5, &w.recipient);
        client.claim(&msg, &attestation(&w.env, true));
        let key = DataKey::Mig(w.recipient.clone());
        let ttl = |w: &World| {
            let k = DataKey::Mig(w.recipient.clone());
            w.env.as_contract(&w.claim_id, || w.env.storage().persistent().get_ttl(&k))
        };
        let fresh = ttl(&w);
        // age the record past the bump threshold: below it, bump must lift
        // the entry back to the high water mark
        w.env.ledger().with_mut(|l| l.sequence_number += 350_000);
        let aged = ttl(&w);
        assert!(aged < fresh, "the record must age with the ledger");
        // bump carries no auth at all: any account, any contract, forever.
        client.bump(&w.recipient);
        let after = ttl(&w);
        assert!(after > aged && after >= fresh, "bump must extend the persistent TTL");
        assert!(client.get_migration(&w.recipient).is_some());
    }
}
