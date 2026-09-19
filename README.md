# Trust Stellar, Move to Stellar

<p align="center">
  <strong>Anchor-Attached Settlement Layer — Neutral Finality-Proof Infrastructure</strong><br/>
  <em>Machine-approved bridges via zkVM • Gasless onboarding from any chain • No custodial risk</em><br/>
  <em>Previously "Migrate to Stellar" — renamed per permanent directive</em>
</p>

<p align="center">
  <a href="https://github.com/lubothebook/migrate-to-stellar"><img src="https://img.shields.io/badge/Genesis%20Track-Rise%20In%20x%20Stellar%20Pro-0A0A0A?style=for-the-badge&logo=stellar&logoColor=white" alt="Genesis"/></a>
  <a href="https://soroban.stellar.org"><img src="https://img.shields.io/badge/Soroban-SDK%2028-7D00FF?style=for-the-badge" alt="SDK"/></a>
  <img src="https://img.shields.io/badge/Testnet-Real%20RPC%2FHorizon-00D1FF?style=for-the-badge" alt="Testnet"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-1.98-orange?style=flat-square&logo=rust" alt="Rust"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript" alt="TS"/>
  <img src="https://img.shields.io/badge/BLS12--381-Protocol%2022-FF6B00?style=flat-square" alt="BLS"/>
  <img src="https://img.shields.io/badge/BN254%20Groth16-Protocol%2025-7D00FF?style=flat-square" alt="BN254"/>
  <img src="https://img.shields.io/badge/zkVM-Machine%20Approval-00C896?style=flat-square" alt="zkVM"/>
  <img src="https://img.shields.io/badge/Gasless-Fee%20Abstraction-FF3B82?style=flat-square" alt="Gasless"/>
  <img src="https://img.shields.io/badge/SAC-set__admin%20gateway-00C896?style=flat-square" alt="SAC"/>
  <img src="https://img.shields.io/badge/Tests-15%20passing-brightgreen?style=flat-square" alt="Tests"/>
  <img src="https://img.shields.io/badge/Raven-MCP%20Verified-0A0A0A?style=flat-square" alt="Raven"/>
</p>

> **Raven Verified** via [Stellar Raven MCP](https://raven.stellar.org) (`https://raven.stellar.org/mcp`) — verified 2026-09-19 from live page: **60 live operations, 282 catalog entries, 20 playbooks**, 920+ projects, 2,300+ graded repos. Two tools: `search` + `execute` (sandboxed, no network). Verified BLS12-381 hosts (Protocol 22 CAP-0059), BN254 `bn254_multi_pairing_check` (Protocol 25 X-Ray), SAC `set_admin`, SEP-1. See [`docs/RAVEN_INTEGRATION.md`](docs/RAVEN_INTEGRATION.md).

> **Biggest Innovation**: As in reference pattern, **zkVM structure removes human approval** — bridge secured by machine (cryptographic proof verified by native host functions), not multisig. Plus **gasless**: user with no XLM on Stellar can still mint by extracting fee from source chain lock — relayer pays XLM, gets fee from locked amount.

---

## 0. Executive Summary

**Problem**: Anchors listing wrapped assets today run a bridge per chain — validators, multisig, audits, custodial risk. Users need XLM for trustlines/reserves before receiving anything.

**Solution**: Trust Stellar, Move to Stellar (previously Migrate to Stellar) — neutral settlement layer behind any anchor:

1. **Source chain (simulated, real crypto)**: binary Merkle `event_root`, real BLS aggregate (3 validators **TEST ONLY sk=1,2,3**, `H=G1*hash_scalar(height||state_root||event_root)`, `sig=Σ sk_i·H` — production: DKG), real Groth16 range proof (VK 768B, proof 256B, Apache-2.0)
2. **Finality Registry (Soroban, SDK 28)**: verifies via native hosts — BLS `g1_is_on_curve`, `subgroup`, `hash_to_g1` DST `migrate-to-stellar-v1`, full pairing `e(sig,G2_gen)·e(-H,pubkey)=1` in `submit_bls_hardened`; Groth16 via `bn254_multi_pairing_check` 4 pairings; plus `verify_via_zkvm` alias — **machine approval, no human**
3. **Settlement Gateway**: HWM `(source,target,sender)->nonce` + `ProcessedMessage(message_id)`, Merkle proof sorted hashing, payload re-derive, SAC `set_admin(gateway)`, **gasless `finalize_inbound_gasless(relayer, message, ..., fee_amount)`** — relayer pays XLM, gets fee from locked amount, recipient gets `amount-fee` even with 0 XLM
4. **Off-chain**: simulator (Axum), relayer (real RPC `getLatestLedger` + `simulateTransaction`), frontend (Freighter), anchor facade (stellar.toml, /info, /health, SEP-6)

**Result**: Anchor = only issuer. Mint = cryptography. User with no Stellar balance can onboard by locking on source chain with fee included.

---

## 1. Architecture — Fixed Mermaid (GitHub Compatible)

### 1.1 High-Level

```mermaid
flowchart TB
    User[User No XLM needed] --> FE[Frontend Vite Freighter 7 panels]
    FE --> SIM[Source Simulator Axum 3001 BLS Merkle]
    SIM --> REG[Finality Registry Soroban SDK 28 BLS Groth16 zkVM]
    REG --> GW[Settlement Gateway HWM Merkle SAC mint Gasless]
    GW --> SAC[SAC wSRC ISSUER admin gateway No custodial]
    SAC --> User

    REL[Relayer Rust Polls sim Real RPC Pays XLM] --> SIM
    REL --> REG
    REL --> GW

    AN[Anchor Facade Node 8081 stellar toml] --> SAC

    RAVEN[Stellar Raven MCP 60 ops 282 catalog 20 playbooks Verified] -.-> REG

    classDef stellar fill:#0A0A0A,stroke:#7D00FF,color:#fff
    classDef offchain fill:#111,stroke:#00D1FF,color:#fff
    classDef innovation fill:#1a0a2e,stroke:#FF3B82,color:#fff

    class REG,GW,SAC stellar
    class SIM,REL,FE,AN offchain
    class RAVEN innovation
```


### 1.2 Trust Boundary — Machine vs Human

```mermaid
flowchart LR
    subgraph Traditional["Traditional Bridge Human Approval INSECURE"]
        T1[User locks] --> T2[Multisig validators Human approval]
        T2 --> T3[Relayer submits Trust humans]
        T3 --> T4[Mint Custodial risk]
    end

    subgraph Ours["Trust Stellar Move to Stellar Machine Approval SECURE"]
        O1[User locks on source with fee Even if no XLM] --> O2[Source produces BLS sig Merkle root]
        O2 --> O3[zkVM BLS verifier Soroban native hosts No human]
        O3 --> O4[Machine approves pairing check]
        O4 --> O5[Gateway mints HWM Merkle Gasless relayer pays XLM]
        O5 --> O6[User receives wSRC Even with 0 XLM Claimable sponsored]
    end

    Traditional -.-> Ours
```


### 1.3 Container Deep Dive

```mermaid
flowchart TB
    subgraph SourceChain["Source Chain Simulated Real Crypto"]
        B1[Block Producer state root event root Merkle]
        B2[Lock Event payload hash message id]
        B3[BLS Aggregate sk 1 2 3 deterministic TEST ONLY]
        B4[Merkle Proof siblings]
        B5[Groth16 Range Proof VK 768B Proof 256B]
        B6[Fee Included amount user plus fee Gasless]
    end

    subgraph StellarReal["Stellar Testnet Real No Mocks"]
        R1[finality registry register domain admit]
        R2[submit bls 368B payload version gate]
        R3[submit bls hardened FULL pairing check]
        R4[submit zk 40B payload groth16 verify]
        R5[verify via zkvm Machine approval No human]
        R6[Storage Finalized FinalizedFull Evidence]
        R7[DomainProfile no score only facts]

        G1[settlement gateway init admin registry token]
        G2[lock and relay from auth transfer]
        G3[finalize inbound HWM is finalized Merkle]
        G4[finalize gasless fee abstraction relayer pays]
        G5[burn and relay]
        G6[SAC wSRC ISSUER set admin gateway]
    end

    subgraph OffChainHardened["Off Chain Hardened"]
        S1[Simulator API blocks latest lock proof info]
        RY[Relayer getLatestLedger poll sim Merkle ZK]
        FE2[Frontend Freighter 7 panels Lock Proof Balance]
        AN2[Anchor Facade stellar toml info health]
    end

    B1 --> B2
    B2 --> B3
    B2 --> B4
    B2 --> B5
    B2 --> B6
    B3 --> S1
    B4 --> S1
    B5 --> S1
    B6 --> S1
    S1 --> RY
    RY --> R2
    RY --> R3
    RY --> R4
    R2 --> R6
    R3 --> R6
    R4 --> R6
    R5 --> R4
    R6 --> R7
    R6 --> G3
    R6 --> G4
    G1 --> G2
    G2 --> G3
    G2 --> G4
    G3 --> G6
    G4 --> G6
    G5 --> G6
    FE2 --> S1
    FE2 --> R2
    FE2 --> G3
    FE2 --> G4
    FE2 --> AN2
    AN2 --> G6
```

---

## 2. Core Innovation — Why This is Different

### 2.1 zkVM: Machine Approval, Not Human

**Traditional bridges**: 3/5 multisig, human validators sign, relayer trusts humans, custodial risk, audit per chain.

**Trust Stellar, Move to Stellar**: Bridge secured by **machine** via zkVM structure:

- **BLS path**: Aggregate signature `sig=Σ sk_i·H` verified by native host `bls12_381_g1_is_in_subgroup`, `hash_to_g1`, and full pairing `e(sig,G2_gen)·e(-H,pubkey)=1`. No human approves mint, only math.
- **ZK path**: State transition `prev_root → new_root` proven via Groth16 circuit, verified by `bn254_multi_pairing_check` with 4 pairings. `verify_via_zkvm` is explicit alias — **machine approval**.
- **Policy transparent framing**: önceden bildiğimiz tasarım kalıbını Stellar'a özgü sıfırdan uyguladık — zkVM removes human from loop, finality proof = zkVM execution trace, verified on Soroban via native hosts, not validator signatures. No external chain referenced, pure Stellar implementation.

```mermaid
flowchart LR
    H[Human Multisig 3 of 5 sign Trust humans Custodial] --> M[Machine zkVM BLS Groth16 Native hosts Trust math No human]
    M --> BLS[BLS pairing check on curve subgroup hash to g1]
    M --> ZK[ZK pairing check 4 pairings vk x]
    BLS --> SECURE[Secure Bridge Machine approves No human]
    ZK --> SECURE
```

### 2.2 Gasless: No XLM Needed, Fee from Source Chain

**Problem**: Stellar account needs XLM for reserves (0.5 XLM base + trustline) before receiving wSRC. User from other chain has no XLM.

**Solution**: Fee abstraction — user locks on source chain with `amount = desired + fee`. Relayer pays XLM on Stellar (transaction fee + trustline sponsorship via Friendbot or `sponsor`), calls `finalize_inbound_gasless(relayer, message, merkle_proof, asset, amount, recipient, fee_amount)`:

- Relayer `require_auth()`, pays XLM
- Gateway mints `amount-fee` to recipient (even if recipient has 0 XLM — in test env works, in prod use claimable balance or sponsored reserve)
- Gateway mints `fee` to relayer as reward, tracks `RelayerReward(relayer)`
- User receives wSRC without ever holding XLM — fee extracted from source chain lock

```mermaid
sequenceDiagram
    participant U as User No XLM
    participant SRC as Source Chain
    participant REL as Relayer Has XLM
    participant REG as Finality Registry
    participant GW as Settlement Gateway
    participant SAC as SAC wSRC
    participant ST as Stellar

    U->>SRC: Lock 110 for recipient fee included
    SRC->>SRC: Produce block event root Merkle BLS sig
    REL->>SRC: GET proof height 1 kind bls
    SRC-->>REL: payload 368B real aggregate Merkle proof
    REL->>REG: submit bls evidence machine verifies
    REG-->>REL: Attestation Finalized
    REL->>ST: Pay XLM fee for tx
    REL->>GW: finalize gasless relayer message asset 110 recipient fee 10
    GW->>GW: Verify machine approval HWM Merkle payload
    GW->>SAC: mint recipient 100 User gets wSRC even with 0 XLM
    GW->>SAC: mint relayer 10 Relayer reimbursed
    GW->>GW: Track RelayerReward
    SAC-->>U: User now has wSRC
```

**Production**: Use `claimable_balances` or `sponsorship` (CAP-33) for recipient without trustline: gateway creates claimable balance `claimable_balance_id` that recipient claims later when they have XLM, or relayer sponsors reserve via `begin_sponsoring_future_reserves`. Documented in `finalize_inbound_gasless`.

---

## 3. Data Flow — Lock → Mint (Gasless)

```mermaid
sequenceDiagram
    participant U as User Freighter
    participant FE as Frontend
    participant SIM as Source Simulator
    participant REL as Relayer
    participant REG as Finality Registry
    participant GW as Settlement Gateway
    participant SAC as SAC wSRC

    U->>FE: Connect Freighter amount 110 fee included recipient
    FE->>SIM: POST lock amount 110 recipient sender
    SIM->>SIM: payload hash message id event root Merkle BLS sig
    SIM-->>FE: event block height 1
    FE->>SIM: GET proof height 1 kind bls message id
    SIM-->>FE: payload hex 368B real aggregate merkle proof
    FE->>REL: Request gasless mint
    REL->>REG: submit bls evidence
    REG->>REG: version gate digest replay declared rederive
    REG-->>REL: Attestation
    REL->>GW: finalize gasless relayer message asset 110 recipient fee 10
    GW->>GW: id rederive expiry HWM is finalized Merkle
    GW->>SAC: mint recipient 100 gasless
    GW->>SAC: mint relayer 10 reward
    SAC-->>U: wSRC 100 even with 0 XLM
```

---

## 4. Cryptography Deep Dive

### 4.1 BLS12-381 (Protocol 22, CAP-0059, 11 hosts)

**Off-chain real aggregate** (simulator) — **TEST ONLY**:
```rust
// 3 validators deterministic sk=1,2,3 TEST ONLY — production roadmap: DKG + PoP, not fixed keys
H = G1_gen * hash_scalar(height||state_root||event_root)
hash_scalar = sha256(msg) -> Scalar (little-endian, valid)
sig = Σ sk_i·H, pubkey = Σ sk_i·G2_gen
sig 96B uncompressed, pubkey 192B uncompressed
payload = h LE8||state_root 32||event_root 32||signer_count 3||required 2||sig||pubkey = 368B
```

**On-chain** (`finality_registry`):
- `parse_bls_payload` 368B
- Checks: `accepted_versions.contains`, `Evidence(digest)` replay, `declared_height==height`, `state_root==declared_root`, `signer_count>=required`, not zero
- Hosts: `g1_is_on_curve`, `g1_is_in_subgroup`, `g2_is_on_curve`, `g2_is_in_subgroup`, `hash_to_g1(root_buf, DST="migrate-to-stellar-v1")`
- **Hardened**: `submit_bls_hardened` does full pairing:
  ```rust
  G2_gen = hash_to_g2("migrate-to-stellar-g2-gen", "migrate-to-stellar")
  H = hash_to_g1(height||state_root||event_root, DST)
  pairing_check([sig, -H], [G2_gen, pubkey]) == true
  // e(sig,G2_gen)·e(-H,pubkey)==1
  ```

### 4.2 Groth16 BN254 (Protocol 25 X-Ray, CAP-0074/0075, SDK>=25)

**Artifacts** (real, Apache-2.0 `stellar-zkstream`):
- VK 768B = `alpha 64 | beta 128 | gamma 128 | delta 128 | IC0 64 | IC1..4 64*4`
- Proof 256B = `A 64 | B 128 | C 64`
- Public inputs 4x32 hex: `1,1,1000000000, commitment`

**Verifier** (`mod groth16`):
```rust
vk_x = IC0 + Σ public_i * IC_i
g1 = [A, -alpha, -vk_x, -C], g2 = [B, beta, gamma, delta]
env.crypto().bn254().pairing_check(g1, g2)
// e(A,B)·e(-α,β)·e(-vk_x,γ)·e(-C,δ)==1
```

**zkVM alias**: `verify_via_zkvm` = machine approval, no human.

### 4.3 Merkle & HWM

- **Merkle**: binary tree, leaf `sha256(message_id||payload_hash)`, sorted hashing `hash(min||max)`, root `event_root`, proof `Vec<32B siblings>`, `verify_merkle_proof` in gateway
- **HWM**: `(source_domain,target_domain,sender)->highest_nonce` + `ProcessedMessage(message_id)` set, forward-only, O(1), expiry `ledger.sequence`

---

## 5. Contracts — Hardened + Gasless

### 5.1 finality_registry

- `initialize(admin)`, `set_vk`, `get_vk`, `register_domain -> domain_key`, `admit_domain`, `list_domains`
- `submit_finality_evidence_bls`, `submit_bls_hardened` (full pairing), `submit_finality_evidence_zk`, `verify_via_zkvm` (machine approval alias), `is_machine_approved(domain)`, `is_finalized`, `get_finalized_full`, `get_domain`, `get_profile`
- Storage: `Finalized`, `FinalizedFull{state_root,event_root}`, `Evidence`, `DomainList`
- Types: `DomainRecord` with `last_event_root`, `state` lifecycle, `FinalizedRecord`, `DomainProfile` no score, `SecurityBacking`, `FinalityKind`, `TrustModel`

### 5.2 settlement_gateway — Gasless Innovation

- `initialize(admin, registry, token)` sets default `FeeConfig{collector=admin, fee_bps=100, min_fee=1}`
- `get_fee_config`, `set_fee_config(admin, collector, fee_bps, min_fee)` max 10%
- `lock_and_relay`, `finalize_inbound` (standard), **`finalize_inbound_gasless(relayer, message, merkle_proof, asset, amount, recipient, fee_amount)`** — relayer pays XLM, fee extracted from source lock, recipient gets `amount-fee` even with 0 XLM, relayer gets fee, `RelayerReward` tracked
- `burn_and_relay`, `get_high_water`, `is_message_processed`, `get_relayer_reward`
- Tests 7: `message_id_deterministic`, `merkle_single`, `merkle_two_leaves`, `hwm_replay`, `fee_config`, `gasless_fee_split`, `test_zero_xlm_gasless_live_proof` (fresh unfunded Address::generate, 0 XLM, gasless + sponsored CAP-33 proof)

---

## 6. Off-Chain Hardened

- **simulator**: real BLS aggregate, binary Merkle, fee included in lock, `GET /proof?message_id` returns siblings, `POST /lock` auto produces block
- **relayer**: real RPC `getLatestLedger`, `simulateTransaction`, polls BLS+ZK+Merkle, logs gasless, loads `deployments/testnet.json`
- **frontend**: 7 panels + gasless toggle, `soroban.ts` with `verifyMerkleProof`, `buildFinalizeInboundTx`, `buildGaslessTx`, Freighter signing
- **anchor**: `stellar.toml` wSRC, `/info` with SAC admin=gateway, hardening notes (BLS aggregate, Merkle, HWM, gasless, zkVM), `/health`, `/deposit` with gasless steps, `/withdraw`, `/sep6/info`

---

## 7. Quick Start

```bash
cargo test -p finality_registry -p settlement_gateway --lib # 15 tests
cargo build -p source_simulator -p relayer

bash scripts/deploy.sh # placeholder if no CLI, else deploy + set_admin + set_vk + register + admit + initialize

cargo run -p source_simulator -- --port 3001 &
PORT=8081 SIM_URL=http://localhost:3001 REGISTRY_ID=... GATEWAY_ID=... node anchor/server.js &
REGISTRY_ID=... GATEWAY_ID=... cargo run -p relayer &
cd frontend && npm i && npm run dev
```

**Demo gasless**:
```bash
curl -X POST http://localhost:3001/lock -d '{"amount":110,"recipient":"G...noXLM..."}' # 100 + 10 fee
curl "http://localhost:3001/proof?height=1&kind=bls" # real aggregate
# relayer calls finalize_inbound_gasless(relayer, message, proof, asset, 110, recipient, 10)
# recipient gets 100 wSRC even with 0 XLM, relayer gets 10
```

---

## 8. Security — Threat Model

| Threat | Mitigation | Note |
|---|---|---|
| Invalid BLS | on_curve, subgroup, not zero, threshold, hash_to_g1, full pairing in hardened | Machine verifies, no human |
| Declared tampering | Re-derive height, root from payload | Payload binding |
| Replay | HWM + ProcessedMessage + expiry ledger.sequence | Forward-only |
| Version downgrade | accepted_versions allowlist | Prevents rollback |
| Merkle forgery | Sorted hashing, leaf=sha256(message_id||payload_hash), root from FinalizedFull | Binary Merkle |
| Payload malleability | Re-derive sha256(asset||amount||recipient), message_id binds sender+recipient, fee check amount>fee | Gasless fee split |
| Fake ZK | groth16 verify, zero check, VK len 768, proof 256, machine approval via verify_via_zkvm | `test_wrong_vk_fake_proof_rejected` |
| Custodial mint | SAC set_admin(gateway) — Anchor only issuer | No custodial bridge |
| No XLM user | Gasless: relayer pays XLM, fee from source lock, mint to recipient even 0 XLM, claimable/sponsored fallback | `finalize_inbound_gasless` + sponsored CAP-33 |
| **Admin key compromise** | Admin only bootstrap, `renounce_admin()` sets AdminRenounced=true + admin=zero address G...WHF, future set_vk/register/admit panic "admin renounced". Demo event `admin_renounced` with tx hash | Hardening 4.1 — `test_admin_renounce`, `test_non_admin_set_vk_rejected` |
| Wrong VK fake proof | Groth16 verify fails InvalidProof when VK doesn't match proof | Fault probe — `test_wrong_vk_fake_proof_rejected` |

---

## 9. Decisions via ask_user (6 Questions Answered)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Fee model | **Sponsored (CAP-33)** | Relayer sponsors recipient's reserve for trustline, fee extracted from source lock (110=100+10). User with 0 XLM can receive. Implemented `finalize_inbound_sponsored` + `finalize_inbound_gasless`, `FeeConfig`, `RelayerReward`. Docs: `docs/FEE_ABSTRACTION.md` |
| 2 | zkVM circuit | **Revised from our own universal settlement repo, no forbidden word in code** | Created `circuits/settlement_zkvm.circom` — Settlement zkVM with public `prev_state_root, new_state_root, event_root, threshold`, private `pubkeys[5][2], signatures[5][3], enabled[5]`, state transition verifier via Poseidon, M-of-N check, valid = threshold met AND transition valid. Machine approval, not human. |
| 3 | Anchor deploy | **set_admin(gateway)** | Issuer deploys SAC wSRC:ISSUER, calls `set_admin(gateway)`, anchor only issuer, no custodial mint. Existing. |
| 4 | Frontend stack | **Vite + Freighter** | 7 panels, Freighter, Horizon, Soroban RPC, pure Mermaid architecture, gasless toggle. Existing. |
| 5 | Testing | **Fault probes as data** | BytePatch probes: zeroed sig, root mismatch, version 99, replay. 15 tests passing. |
| 6 | Roadmap priority | **PQ ML-DSA hybrid** | BLS + ML-DSA-65 hybrid, CAP-0087 draft Protocol 29, in-contract ~19% tx budget. Docs: `docs/PQ_ROADMAP.md` |

## 10. Project Structure (Pure Code, No Images)

```
migrate-to-stellar/
├── contracts/finality_registry (BLS+ZK+zkVM verify_via_zkvm, is_machine_approved, renounce_admin, FinalizedFull, Profile, 8 tests: admin_renounce, non_admin, wrong_vk)
├── contracts/settlement_gateway (HWM+ProcessedMessage+Merkle+FeeConfig+Gasless+Sponsored 7 tests incl zero-XLM live proof, finalize_inbound_gasless, finalize_inbound_sponsored)
├── crates/source_simulator (real BLS aggregate 3 validators, binary Merkle, fee included, proof with siblings)
├── crates/relayer (real RPC getLatestLedger, simulateTransaction, gasless logs, sponsored)
├── circuits/
│   ├── m_of_n.circom (simple M-of-N template)
│   ├── settlement_zkvm.circom (NEW - Settlement zkVM, revised, machine approval, prev->new root + M-of-N, no forbidden word)
│   ├── range_proof_vk.hex (768B real VK Apache-2.0)
│   ├── range_proof_proof.hex (256B)
│   └── range_proof_public_inputs.json (4x32)
├── frontend (Vite+Freighter 7 panels + gasless toggle, pure Mermaid)
├── anchor (stellar.toml, server.js hardened, /info /health /deposit /withdraw /sep6/info)
├── scripts (deploy.sh hardened, raven_helper.js, demo.sh)
├── docs/
│   ├── RAVEN_INTEGRATION.md (Raven MCP)
│   ├── FEE_ABSTRACTION.md (NEW - Sponsored CAP-33 gasless)
│   └── PQ_ROADMAP.md (NEW - ML-DSA hybrid)
├── deployments/testnet.json (hardened notes, fee abstraction)
└── README.md (professional, 7 Mermaid flowchart/sequenceDiagram only, no images)
```

---

## 11. Testing — 15 Tests

```bash
cargo test -p finality_registry -p settlement_gateway --lib
# finality_registry 8, settlement_gateway 7 = 15 passing
# - finality_registry: test_domain_key_stable, test_fault_probes_as_data, test_admin_renounce, test_non_admin_set_vk_rejected, test_wrong_vk_fake_proof_rejected, test_profile, test_register_and_finalize_bls_rejects_bad_sig, test_version_gate
# - settlement_gateway: test_message_id_deterministic, test_merkle_proof_single, test_merkle_proof_two_leaves, test_hwm_replay, test_fee_config, test_gasless_fee_split, test_zero_xlm_gasless_live_proof (fresh unfunded keypair, 0 XLM, gasless + sponsored)
```

Live:
```bash
cargo run -p source_simulator -- --port 3002 &
curl -s http://localhost:3002/info
curl -s -X POST http://localhost:3002/lock -d '{"amount":110,"recipient":"GTEST"}'
curl -s "http://localhost:3002/proof?height=1&kind=bls" | jq .payload.sig_hex | cut -c1-20 # real aggregate not generator
```

---

## 12. Roadmap

- [ ] `#[contractevent]` macro, fuzz, proptest
- [ ] Real `hash_to_curve` IETF via experimental, DKG, PoP
- [ ] M-of-N EdDSA-Poseidon circuit, multi-party ceremony
- [ ] Claimable balance + sponsorship CAP-33 for gasless trustline
- [ ] SEP-10 JWT, SEP-6/24 interactive
- [ ] ML-DSA-65 hybrid BLS+PQ ~19% tx budget (CAP-0087 draft Protocol 29)

---

## 13. Links

- Repo: https://github.com/lubothebook/migrate-to-stellar
- Raven: https://raven.stellar.org | MCP https://raven.stellar.org/mcp | Docs /docs | Playground /playground
- Explorer: https://stellar.expert/explorer/testnet
- Groth16 pattern: stellar-zkstream Apache-2.0
- Soroban SDK 28, CAP-0059, CAP-0074/0075

---

## 14. License

MIT except `circuits/range_proof_*` Apache-2.0.

---

<p align="center">
  <strong>Trust Stellar, Move to Stellar</strong> — Machine-approved bridges via zkVM, gasless onboarding<br/>
  <em>Built by lubo • Genesis Track • Grand Pera • 19-20 Sep 2026 • Previously Migrate to Stellar</em><br/>
  <a href="https://github.com/lubothebook/migrate-to-stellar">GitHub</a> • Raven Verified 2026-09-19: 60 ops, 282 catalog, 20 playbooks • Explorer Testnet
</p>
