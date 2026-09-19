# Skills

A curated set of agent skills vendored into this repository so every agent
working on Lumen Gate reasons from the same reference material. These are
reference documents, not code: nothing in this directory is executed,
deployed or imported by the contracts, the facade or the console.

## How an agent uses this directory

Pick the skill whose description matches the task at hand and read its
`SKILL.md` first, then the companion file it routes to. The skills
cross-reference each other with relative links; the directory layout is kept
exactly as upstream so those links keep working.

| Task at hand | Skill |
| --- | --- |
| Soroban contract work: patterns, storage, auth, testing, security review | `smart-contracts/` |
| Anything that moves value or messages between Stellar and another chain (rail selection, CCTP, Axelar, LayerZero, intents) | `cross-chain/` |
| Groth16/BN254, BLS12-381, Poseidon verification lanes | `zk-proofs/` |
| Which SEP or CAP applies, ecosystem and documentation lookup | `standards/` |
| Frontend: transaction building, Freighter, RPC submission, smart accounts | `dapp/` |
| Trustlines, SAC behaviour, decimals at boundaries | `assets/` |
| Horizon/RPC data access patterns | `data/` |
| Adversarial review of a diff or a surface before it ships | `code-review/` |
| Exhaustive branch/boundary walk of a single file or diff hunk | `review-edge-case-hunter/` |
| Forensic debugging of a failing flow | `investigate/` |
| The mainnet-readiness checklist (post-hackathon path) | `deploy-stellar-mainnet/` |
| Lost: which of these applies | `navigate-skills/` |

Rules when using them here:

1. The skills are reference material. Where a skill and `DIRECTIVE.md`
   disagree, the directive wins: it is the single authority for what this
   project claims, builds and refuses to build.
2. Facts in a skill may lag the protocol. Before asserting anything about
   protocol versions, CAP status or network behaviour, verify it live (the
   skills themselves say so).
3. Do not copy skill text into product copy. The README and the console tell
   the truth about this build in their own words.
4. Keep this directory in sync with upstream deliberately, not casually: bump
   it like a dependency, and note the bump in DIRECTIVE.md Section 3.

Provenance and licenses are recorded in `NOTICE.md`.
