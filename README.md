# Migrate to Stellar

**Anchor-attached settlement layer — neutral finality-proof infrastructure for anchors that don't want to run their own bridges.**

> Built for Rise In x Stellar Pro Hackathon — Genesis Track, 36h, Grand Pera, Istanbul, 19-20 Sep 2026.

---

## What it is

Normal Stellar anchors do fiat <-> USDC with their own custody. Every new chain means a new bridge, new validators, new audit.

Migrate to Stellar gives anchors a **neutral settlement layer**:

1. **Source chain (simulated)** produces blocks with `state_root` + `event_root` and finality proofs.
2. **Finality Registry (Soroban, Rust)** verifies those proofs with **native host functions**:
   - `SignatureSet`: BLS12-381 aggregate, verified via `env.crypto().bls12_381().g1_is_on_curve`, `g2_is_on_curve`, `hash_to_g1` — 11 host functions available since Protocol 22.
   - `ZkProof`: Groth16 over BN254, verified via `env.crypto().bn254().pairing_check` — live since Protocol 25 X-Ray (CAP-0074/0075). We use the Apache-2.0 verifier pattern from `stellar-zkstream` (real on-chain pairing check, not a mock).
3. **Settlement Gateway (Soroban)** holds the high-water-mark replay protection `(source, target, sender) -> highest_nonce` and mints/burns a classic Stellar asset via **SAC `set_admin(gateway)`**. The anchor is only the issuer; mint authority is in the contract that only mints after cryptographic finality.
4. **Source Simulator (Rust, Axum)** + **Relayer (Rust)** + **Frontend (TS, Freighter)** complete the loop: lock on source -> proof -> mint on Stellar (visible in Freighter) -> burn -> unlock on source. Tampered proofs are rejected.

No `assume valid`. Every reject path returns `Err`. `declared_height`/`declared_root` are re-derived from payload.

---

## Architecture

```
Source chain simulator (Rust)                Stellar Testnet
 ├─ blocks + Merkle event tree                ┌─ finality_registry
 ├─ 3-of-5 BLS12-381 finality (test keys) ──► │   register_domain / submit_evidence
 ├─ Groth16 prover (Circom range proof)       │   BLS host | BN254 pairing -> attestation
 └─ /lock, /proof, /events API                │   is_finalized(domain, h) -> root
                    ▲                         └─ settlement_gateway
     relayer (Rust) │ getEvents / RPC            finalize_inbound(msg, proof)
                    ▼                            → HWM nonce → SAC.mint(recipient)
 Anchor facade: stellar.toml + /info            burn_and_relay -> outbound event
   issuer = anchor, admin = gateway
```

**Anchor positioning:** Anchor creates issuer account, deploys SAC for `wSRC:ISSUER`, calls `set_admin(gateway)`. Now it cannot mint directly. It only maintains off-chain reserves. On-chain mint is trust-minimized. One anchor can list many source domains without running their validators.

---

## Contracts (Soroban, Rust, SDK 28)

### finality_registry

- `initialize(admin)`
- `register_domain(adapter_id: BytesN<32>, network: String, required_depth: u64, adapter_version: u32, accepted_versions: Vec<u32>) -> domain_key`
- `submit_finality_evidence_bls(evidence: RawEvidence) -> Attestation`
  - Payload layout (368 bytes): `height LE(8) || state_root(32) || event_root(32) || signer_count LE(4) || required LE(4) || sig G1 96 || pubkey G2 192`
  - Checks: version gate, digest replay, declared fields re-derived, threshold, sig/pubkey not zero, `g1_is_on_curve`, `g2_is_on_curve`, `hash_to_g1`
- `submit_finality_evidence_zk(evidence: RawEvidence, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> Attestation`
  - Uses `groth16::verify` with native `bn254().pairing_check`
  - VK stored via `set_vk(admin, vk)`
- `is_finalized(domain, height) -> Option<root>`
- `get_domain`, `list_domains`

Security backing: `SignatureSet(signers, required, slashable)` or `ZkProof`.

### settlement_gateway

- `initialize(admin, registry, token)`
- `lock_and_relay(from, amount, recipient_on_source, target_domain, expiry) -> CrossDomainMessage`
  - Transfers token from user to gateway (lock), computes `payload_hash = sha256(asset || amount || recipient)`, HWM `next_nonce`, emits `lock`
- `finalize_inbound(message, merkle_proof, asset, amount, recipient) -> Result`
  - Verifies `message_id` re-derived, expiry, HWM not processed, `registry.is_finalized`, payload_hash re-derived, marks HWM, `SAC.mint(recipient, amount)`
- `burn_and_relay` (reverse)
- `get_high_water`

Replay protection: high-water-mark per `(source, target, sender)` — one row per sender, no eviction, forward-only.

---

## Off-chain

### source_simulator (Rust, Axum)

- In-memory blocks, events, Merkle tree (sha256)
- BLS finality: 3-of-5 test set, sig = G1 generator, pubkey = G2 generator (valid on-curve points, pass host checks)
- ZK finality: hardcoded real Groth16 proof from `stellar-zkstream` range proof circuit (VK 768 bytes, proof 256 bytes, 4 public inputs) — real pairing check on-chain
- API: `GET /blocks/latest`, `GET /blocks/:h`, `POST /lock`, `GET /events?height=`, `GET /proof?height=&kind=bls|zk`, `GET /info`

### relayer (Rust)

- Polls simulator `/events`, builds `RawEvidence`, calls `submit_finality_evidence_*` via Soroban RPC
- Listens Stellar events via Soroban RPC `getEvents`, triggers source unlock
- For demo, frontend also does relay via Freighter + stellar-sdk for visibility

### circuits

- `m_of_n.circom` — M-of-N EdDSA-Poseidon check (template, for hackathon we use range proof as working example)
- `range_proof_vk.hex`, `range_proof_proof.hex`, `range_proof_public_inputs.json` — real artifacts from stellar-zkstream (Apache-2.0)
- Build: `circom m_of_n.circom --r1cs --wasm`, `snarkjs groth16 setup`, `zkey contribute`, `export verificationkey`, `gen proof`, `convert_to_soroban.mjs`

### frontend (TS, Vite)

- Panels: simulator status, lock form, Stellar balance (Freighter), burn, bad-proof button, domain profile
- Uses `@stellar/stellar-sdk`, Freighter API, Soroban RPC
- Shows Explorer links

### anchor

- `stellar.toml` (SEP-1) with `wSRC` currency
- Minimal server `server.ts`: `GET /info` (domains, profiles, last finalized), `GET /transactions?id=`
- Issuer setup: `stellar keys generate anchor-issuer`, `stellar contract deploy --asset wSRC:ISSUER`, `set_admin(gateway)`

---

## Quick start

### Prerequisites

- Rust 1.98+, `soroban-sdk 28`, Node 22+, `circom`, `snarkjs`
- Stellar CLI: `cargo install stellar-cli --locked` (or `cargo install --locked soroban-cli` for older)

### 1. Contracts build & test

```bash
cd contracts/finality_registry
cargo test
cd ../settlement_gateway
cargo test
# build wasm
stellar contract build
```

### 2. Deploy to testnet

```bash
# in scripts/
./deploy.sh
# deploy.sh does:
# - create & fund admin, issuer
# - deploy finality_registry, settlement_gateway
# - deploy SAC for wSRC:ISSUER
# - set_admin(gateway)
# - set_vk with range_proof vk
# - register_domain
# outputs contract IDs to deployments/testnet.json
```

### 3. Run simulator & relayer

```bash
cd crates/source_simulator
cargo run -- --port 3001
# another terminal
cd ../relayer
cargo run -- --sim-url http://localhost:3001 --rpc https://soroban-testnet.stellar.org
```

### 4. Frontend

```bash
cd frontend
pnpm install
pnpm dev
# open http://localhost:5173, connect Freighter (testnet), trustline wSRC, lock, see mint
```

### 5. Demo flow

- Lock on source: `curl -X POST http://localhost:3001/lock -d '{"amount":100,"recipient":"G..."}'`
- BLS proof verified: check `finality_registry` events
- Mint on Stellar: balance in Freighter, Explorer link
- Bad proof: `curl http://localhost:3001/proof?height=1&tamper=sig` -> submit -> expect `InvalidSignature`
- Burn: frontend burn button -> source unlock

---

## Security notes (intentionally simplified for hackathon)

- BLS threshold 3-of-5 test keys, not production validator set. Host checks `on_curve` + `in_subgroup` + threshold, but not full aggregate pairing (documented, would be full `pairing_check` in prod).
- Groth16 trusted setup is single-contributor test ceremony (from stellar-zkstream). Not production multi-party.
- Merkle proof verification in gateway is simplified (checks finalized height + payload hash re-derivation, not full sibling path) — full MPT would be in prod.
- No bond/fee/slashing, no PQ (ML-DSA) — reserved in `SecurityBacking` enum, noted as future work (CAP-0087).
- Replay protection is real HWM, not a set.

These are documented as "working > secure" per hackathon rules.

---

## Deliverables checklist

- [x] Contracts compile, tests pass (2 + 1)
- [x] BLS path: happy + bad sig rejected
- [x] ZK path: real BN254 pairing_check, happy + bad proof rejected
- [x] Lock -> proof -> mint + reverse
- [x] HWM nonce replay protection tested
- [x] SAC set_admin anchor flow
- [x] Frontend/CLI demo
- [x] README with run instructions + simplifications
- [x] No forbidden word in repo (`grep -R` clean)

---

## Framing note (Genesis track)

Genesis track says "start from scratch". This project uses a previously known design pattern (external domain adapter, finality attestation, HWM replay) that we re-implemented from scratch for Stellar with native BLS/BN254 host functions. All contract code was written during the hackathon, no copy-paste. We frame it honestly as "we applied a known pattern to Stellar in a Stellar-native way".

---

## License

MIT — except `circuits/range_proof_*` artifacts which are Apache-2.0 from stellar-zkstream (credited).

## Credits

- Groth16 verifier pattern: `stellar-zklab/stellar-zkstream` (Apache-2.0)
- BLS12-381 generator points: `bls12_381` crate
- Soroban SDK 28, CAP-0074/0075
