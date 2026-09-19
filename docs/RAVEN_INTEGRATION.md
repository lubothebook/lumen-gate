# Optional Stellar documentation research

This file records an optional developer workflow for consulting the Stellar
Raven MCP service while implementing Lumen Gate. Raven is not a runtime
component, a bridge validator, a source of mint authority or a dependency of
the deployed contracts.

## Why it is optional

The project must be reproducible from official Stellar documentation and the
repository itself. A Raven result is therefore a research note, not proof that
an on-chain feature is available. Before a submission, host-function and
protocol claims must be checked against the target Soroban network, SDK and a
real RPC call.

Do not put Raven catalog counts, project counts, playbook counts or a
"verified" badge in the product README unless the value and date are checked
from a primary source immediately before submission.

## Connection examples

The hosted endpoint, if available to the contributor, is:

```text
https://raven.stellar.org/mcp
```

Example MCP client commands:

```bash
claude mcp add --transport http stellar-raven "https://raven.stellar.org/mcp"
codex mcp add stellar-raven --url "https://raven.stellar.org/mcp"
```

Authentication and availability are external to this repository. No secret or
access token belongs in the repository.

## Questions worth checking

When using any documentation assistant, ask for primary sources and verify the
answer against the target protocol:

1. Which BLS12-381 curve, subgroup, hash-to-curve and pairing host functions are
   available on the selected Soroban protocol?
2. Which BN254 multi-pairing API and SDK types are available for the deployed
   contract WASM?
3. What is the correct Stellar Asset Contract `set_admin` flow for the anchor
   issuer and gateway?
4. Which SEP-1 fields are required for the anchor's `stellar.toml`?
5. How should `simulateTransaction`, resource assembly, signing and
   `sendTransaction` be sequenced for the selected RPC version?

The answer is not accepted until a small local test or a Testnet transaction
confirms it.

## Local project mapping

- Registry cryptography: `contracts/finality_registry/src/lib.rs`
- Gateway settlement: `contracts/settlement_gateway/src/lib.rs`
- Deployment procedure: `scripts/deploy.sh`
- Anchor metadata: `anchor/stellar.toml` and `anchor/server.js`
- Testnet proof: `deployments/testnet.json`

## Submission rule

Raven may help a contributor find an official document, but it must not be
used to imply that the Lumen Gate contracts are deployed, that a proof was
accepted, or that a gasless flow works. Those claims require a contract ID,
transaction hash, receipt and negative test result recorded in the main
README and the permanent directive.

## Links

- Stellar developer documentation: https://developers.stellar.org/
- Stellar protocol and Soroban documentation: https://soroban.stellar.org/
- Raven MCP, when available: https://raven.stellar.org/mcp
