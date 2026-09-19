# PQ Roadmap — ML-DSA Hybrid (CAP-0087 Draft)

> Selected via ask_user: roadmap priority = PQ ML-DSA hybrid

## Background

From reference universal settlement pattern, hybrid finality: BLS12-381 + post-quantum (ML-DSA-65 FIPS 204 NIST final).

Stellar status (Sep 2026, verified via Raven):
- PQ host not live yet
- CAP-0087 draft proposes ML-DSA for Protocol 29
- In-contract ML-DSA-65 via `soroban-ml-dsa` crate measured ~19% tx budget on testnet
- Our `SecurityBacking` enum already reserves space: `SignatureSet(u32,u32,bool)` for BLS, `ZkProof` for Groth16, future `PqSignature`

## Hybrid Design

```
Finality proof = BLS aggregate + ML-DSA aggregate (or ZK proof of both)
- BLS: 3 validators, fast, native hosts Protocol 22
- ML-DSA-65: post-quantum, FIPS 204, in-contract verification ~19% budget
- Threshold: e.g., 2 BLS + 2 PQ = 4 required
- SecurityBacking::SignatureSet(signers, required, slashable) extended with pq flag
```

## Implementation Plan

### Phase 1: In-Contract ML-DSA (Now, Testnet)

Use `soroban-ml-dsa` crate (already measured):

```rust
// In finality_registry, add:
use soroban_ml_dsa::{ml_dsa_65_verify, MlDsa65PublicKey, MlDsa65Signature};

pub fn submit_finality_evidence_pq(
    env: Env,
    evidence: RawEvidence,
    pq_pubkeys: Vec<Bytes>,
    pq_sigs: Vec<Bytes>,
) -> Result<FinalityAttestation, RegistryError> {
    // Verify ML-DSA-65 signatures over height||state_root||event_root
    for (pk, sig) in pq_pubkeys.iter().zip(pq_sigs.iter()) {
        let pk_obj = MlDsa65PublicKey::from_bytes(pk);
        let sig_obj = MlDsa65Signature::from_bytes(sig);
        if !ml_dsa_65_verify(&pk_obj, &evidence.payload, &sig_obj) {
            return Err(RegistryError::InvalidSignature);
        }
    }
    // If BLS + PQ both pass, store Finalized
}
```

Cost: ~19% tx budget per verification (from community measurements), acceptable for settlement (not per tx).

### Phase 2: Native Host (Protocol 29, CAP-0087)

When CAP-0087 lands:

```rust
// Future native host (draft):
env.crypto().ml_dsa().ml_dsa_65_verify(pubkey, message, signature)
env.crypto().ml_dsa().ml_dsa_87_verify(...)
```

Then BLS + PQ both native, cost drops to ~2% budget.

### Phase 3: Hybrid Threshold

```rust
enum SecurityBacking {
    SignatureSet(u32, u32, bool), // BLS
    PqSignatureSet(u32, u32), // ML-DSA
    Hybrid { bls: (u32,u32), pq: (u32,u32) }, // e.g., 2 BLS + 2 PQ
    ZkProof,
}
```

Domain can require hybrid: `required_depth` + `pq_required`.

## Why PQ Matters

- **Quantum horizon**: Ed25519/ECDSA breakable within lifetime of chain launched today
- **Settlement layer longevity**: Finality proofs stored forever, must be PQ-secure
- **Stellar alignment**: CAP-0087 draft shows Stellar intends native ML-DSA, we prepare

## Current Code

- `contracts/finality_registry/src/lib.rs`: `SecurityBacking` reserves, `FeeConfig` for future, comments on PQ
- `README.md`: Roadmap section mentions PQ, CAP-0087, 19% budget
- This file: detailed roadmap

## References

- Raven search: `search({query: "ML-DSA CAP-0087 Protocol 29"})` → draft, not live
- `soroban-ml-dsa` crate: https://github.com/... (in-contract ML-DSA-65)
- NIST FIPS 204: ML-DSA-65 final
- Our reference pattern: BLS12-381 + ML-DSA-65 hybrid, legacy Dilithium5 only for migration

## Next Steps

- [ ] Add `soroban-ml-dsa` dependency, implement `submit_pq` with 19% budget test
- [ ] Measure gas on testnet, document
- [ ] When Protocol 29 lands, switch to native host
- [ ] Hybrid threshold in `DomainRecord`
