# STATUS — gate2/zkvm

> **This is half a job. It does not produce or verify a ZK proof.**

Every line below has a counterpart in [`evidence.json`](./evidence.json) or
[`PROVENANCE.md`](./PROVENANCE.md).

---

## What this workspace actually does

Deterministic execution and trace generation. A program compiles to bytecode,
the VM runs it, and the run is reproducible: the same input produces the same
execution trace, attested by a digest over the trace rows.

That is the whole claim. In particular:

- **No proof is produced on the Gate path**, and none is verified.
- **No output reaches the chain.** Nothing here feeds a Soroban contract,
  `BurnRouter`, `GateClaim`, or any web flow.
- The trace digest in the parity harness is a **determinism check**, not a
  commitment and not evidence to a third party. Two runs agreeing tells you the
  VM is deterministic; it tells a verifier nothing.

## One caveat, stated plainly

This workspace also contains `zk-proof`, `zk-state`, `verifier-registry` and
`note-packing`, which arrived in commit `28026a9` before this work started and
were left in place (PROVENANCE §3, findings z1–z4). They carry their own tests
and those tests pass.

**None of that is wired to Gate, and none of it is claimed here.** The proof
half is not part of this deliverable, is not exercised by the Gate parity demo,
and its presence does not make any statement in this file less true. The
"self-contained ZK proving stack" phrasing of that commit is not adopted.

---

## Taken (the execution half)

| component | state |
|---|---|
| `zk-isa` — opcodes, encode/decode, bytecode | present, imported |
| `zk-vm` — deterministic VM, gas, trace generation | present, imported |
| `zk-compiler` — lexer, parser, sema, codegen | present, imported |
| `parity` — Gate opcode gate, tier parity + determinism harness | **written for Gate** |
| `programs/gate_tier.zkl` | **written for Gate** |
| `vectors/tier_vectors.json` — read by both sides | **written for Gate** |

## Not taken (the proof half and its surroundings)

| component | why |
|---|---|
| `bud-cli` (`prove`, `verify`, `deploy`, `batch`) | out of scope; also depends on `bud-proof` + `bud-state` |
| a `compile`/`run` CLI | not built — the harness is a library and a test suite; no CLI was needed for parity |
| `bud-node`, L1 host integration | out of scope |
| prover tests, negative soundness tests, docs book | belong to the proof half; see the source |

The proof half (`prove`/`verify` as a Gate capability) is taken up by a
**separate directive**, and only after the source closes its Z-B gate (64-depth
Merkle soundness). Until then no feature resembling a "hidden tier proof" is
promised, and none exists.

---

## Closed opcodes

`VerifyMerkle`, `SRead`, `SWrite` — refused at compile and decode on the Gate
path by `parity/src/gate_profile.rs`. Opening any of them needs a human decision
**and** the Z-B gate closing upstream.

**Why a Gate-side gate rather than the ISA's own profile (finding z10).** The
imported ISA was measured, not assumed:

| opcode | `IsaProfile::Production` | `MainnetActivation::default()` |
|---|---|---|
| `VerifyMerkle` | accepted | rejected |
| `SRead` / `SWrite` | accepted | accepted |

`Opcode::is_experimental()` returns `false` for every opcode in this revision, so
the Production profile on its own refuses nothing, and the mainnet gate is silent
about storage. Flipping `is_experimental()` upstream-style would have turned
imported prover and VM tests red for reasons unrelated to them — which the rules
forbid working around. So the closure is enforced additively on the Gate path and
the divergence is recorded rather than hidden.

---

## Parity and determinism (what was measured)

- 12 shared vectors in `vectors/tier_vectors.json`, including every boundary the
  directive names: 0, 9 999 999, 10 000 000, 99 999 999, 100 000 000,
  999 999 999, 1 000 000 000, and a large value.
- The VM runs all 12 and matches the expected rung on each.
- The Soroban `gate_campaign_example` reads **the same file** and agrees.
- Thresholds are asserted equal to the contract's own constants
  (10 / 100 / 1 000 USDC at 6 decimals), so the two cannot drift silently.
- Each vector is run twice; trace digests match — determinism. Different inputs
  produce different digests, so the check cannot pass vacuously.
- Gas exhaustion is a refusal: the VM reports `OutOfGas` and yields no tier.

Two vectors are VM-side only, for a real reason rather than convenience:

| vector | why |
|---|---|
| `total = 0` | `GateClaim` refuses a zero mint (`NothingMinted`, #13), so a zero-total migration record cannot exist on-chain at all (finding z11) |
| `total = 1 000 000 USDC` | larger than the mocked CCTP message carries in that harness; the rung above Gold is already pinned there by the exact-Gold case |

---

## Known contradiction between the sources

`Budlum/BudZKVM` declares all 31 opcodes production-ready including
`VerifyMerkle`. `budlum-xyz/budlum` keeps `VerifyMerkle` gated off and describes
64-depth Merkle soundness as unfinished. **The safe reading governs here:** the
opcode stays closed. Detail in PROVENANCE §2.2.

---

## Not done

- No `compile`/`run` CLI binary.
- No proof, prover, verifier or on-chain verification on the Gate path.
- Example `.zkl` programs beyond `gate_tier.zkl` were not imported; the four that
  arrived with commit `28026a9` are untouched.
- The pre-existing proof-half crates were neither audited nor removed — out of
  scope for this annex. Their status is an open question for the operator, not a
  claim made here.
- Source copyright headers were **not** restored; the scrub predates this work and
  continuing it was an explicit decision (PROVENANCE d3, finding z3).

---

## Licence

Code here derives from `budlum-xyz/budlum` @ `d8423b77`, licensed
**PolyForm Shield 1.0.0** — *not* MIT, contrary to the annex's assumption. The
file is vendored verbatim at [`LICENSE`](./LICENSE). See PROVENANCE §1.
