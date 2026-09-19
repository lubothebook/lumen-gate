# Post-quantum roadmap

Post-quantum signatures are intentionally out of the Lumen Gate hackathon
scope. The current implementation uses the two paths that can be demonstrated
with the selected Soroban environment:

- BLS12-381 aggregate signatures;
- Groth16 proofs over BN254.

No post-quantum host is assumed to exist. Any future ML-DSA integration must be
re-checked against the protocol and SDK used by the deployment; a draft proposal
or an off-chain benchmark is not an available Soroban primitive.

## Future design

A future domain policy may require a hybrid finality statement:

```text
BLS aggregate + ML-DSA threshold
```

The hybrid path would need:

1. a versioned evidence encoding;
2. domain-bound BLS and ML-DSA public keys;
3. native or independently audited in-contract verification;
4. explicit fee and resource measurements;
5. key rotation and revocation policy;
6. new negative tests for partial and mixed-threshold proofs.

Until those conditions exist, no PQ field is added to the production demo
message and no PQ security claim is made in the README.

## Not in this submission

- ML-DSA verification inside `finality_registry`;
- hybrid quorum policy;
- PQ validator key generation or rotation;
- claims about a future protocol's host API;
- production migration from the BLS/ZK policies.

## Acceptance criteria for future work

- official protocol documentation and target-network support;
- a small verified fixture and failure matrix;
- measured Soroban resource budget;
- live Testnet receipt;
- migration note for already registered domains.
