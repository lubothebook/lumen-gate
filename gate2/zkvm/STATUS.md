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
path. Opening any of them needs a human decision **and** the Z-B gate closing
upstream.

The two are closed at **different layers**, on purpose.

**`VerifyMerkle` — closed in the imported ISA itself.** `Opcode::is_experimental()`
returns `true` for it, so the refusal happens before any Gate-side code runs and
no activation bitmask can reach around it:

| layer | behaviour |
|---|---|
| `Opcode::is_experimental()` | `true` |
| `decode_for_profile(_, Production)` | refused — `ExperimentalOpcodeDisabled` |
| `decode_for_profile(_, Testing)` | decodes — **gated, not deleted** |
| `MainnetActivation::default()` | refused |
| `MainnetActivation::full()` | **still refused** — the profile gate outranks it |
| `zk-compiler` codegen, default features | refused regardless of profile |
| Gate closed set (`parity/src/gate_profile.rs`) | refused again, independently |

At import this was a Gate-side gate only: the ISA accepted the opcode under
`Production` and `MainnetActivation::full()` was enough to open it. That lock was
too narrow — it covered the Gate path and the mainnet decode path, and left
`decode_for_profile(_, Production)` accepting an opcode whose 64-depth soundness
work is unfinished upstream. Five imported assertions encoded the old behaviour;
they were **rewritten, not deleted**, and each one is listed in `superseded[]`
with what replaced it.

**`SRead` / `SWrite` — closed on the Gate profile only**, by
`parity/src/gate_profile.rs`. They are deliberately *not* raised to the ISA
layer: imported `zk-proof` and `zk-vm` suites legitimately use storage, and
flipping the ISA flag would turn those red for reasons unrelated to them.
Breaking working imported tests to make a Gate-side point is the same failure as
green-washing, in the other direction. The Gate-path refusal is unconditional
either way.

`VerifyInference` was considered for the ISA list and **left out**: it has no
verification circuit upstream and no Gate surface, so closing it there would be
precautionary rather than justified.

---

## The proof half is quarantined, not deleted

`zk-proof`, `zk-state`, `verifier-registry` and `note-packing` are in the tree
and still compile, but nothing on the Gate path touches them. Each carries a
header saying so in its own words: *not used on the Gate path, nothing claimed*.

The boundary is **enforced, not just asserted**. `parity/tests/quarantine.rs`
fails the build if any Gate-path crate names one of them in a manifest or a
`use`, and also fails if one of them silently disappears. The gate was proved
non-vacuous by deliberately violating it — a `zk-state` dependency was injected
into `zk-vm/Cargo.toml`, the test failed naming the offender, and the manifest
was restored.

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

Code here derives from `budlum-xyz/budlum` @ `d8423b77` (PolyForm Shield 1.0.0);
the licence file is vendored verbatim at [`LICENSE`](./LICENSE). Both
repositories are this team's own. See PROVENANCE §1.
