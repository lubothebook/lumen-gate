# PROVENANCE — gate2/zkvm

Record of where this workspace's code came from, what was changed on the way in,
and which claims about it are measured rather than assumed.

This file is bookkeeping, not a permission request.

---

## 1. Ownership and licence

**Owner statement:** the upstream repositories belong to this team. There is no
licensing obstacle, and none is treated as one.

For the record, the licence file carried by each candidate:

| Repository | `LICENSE` on disk |
|---|---|
| `budlum-xyz/budlum` (selected source) | PolyForm Shield 1.0.0 |
| `Budlum/BudZKVM` (alternative) | MIT |

`budzero/LICENSE` is byte-identical to the monorepo's root `LICENSE.md`
(sha256 `77080c7c…897401`) and that exact file is vendored here as
[`LICENSE`](./LICENSE), unmodified — so the identifier the crates declare
(`LicenseRef-PolyForm-Shield-1.0.0`) has its text present alongside it.

---

## 2. Source selection

**Selected:** `budlum-xyz/budlum`, the in-tree `budzero/` workspace.

| | value |
|---|---|
| URL | https://github.com/budlum-xyz/budlum |
| Commit SHA | `d8423b773d54b12e84b256dba1570b9b20c0465c` |
| Commit date | 2026-09-17 00:49:54 +0300 |
| Subject | Update, harden and wire the protocol (#50) |
| Tree taken from | `budzero/` |
| Retrieved | 2026-09-20 |

Selected because the annex names it the default source, and because the
comparison below shows it is the safer of the two (gated opcodes, larger and
more constrained VM).

### 2.1 The two candidates, compared

| | `budlum-xyz/budlum` → `budzero/` | `Budlum/BudZKVM` |
|---|---|---|
| SHA | `d8423b77` (2026-09-17) | `8c16dbdd` (2026-09-13) |
| Licence | PolyForm Shield 1.0.0 | MIT |
| Crates | isa, vm, compiler, state, proof, node, cli, verifier-registry | isa, vm, compiler, state, proof, node, cli |
| Opcodes | 33 | 31 |
| `bud-isa` | 622 lines | 170 lines |
| `bud-vm` | 3 267 lines | 1 123 lines |
| `bud-compiler` | 4 541 lines | 4 513 lines |
| `bud-proof` | 18 715 lines | 4 989 lines |
| Opcode gating | `IsaProfile` **and** `MainnetActivation`; `VerifyMerkle`, `VerifyInference` off by default | `is_experimental()` hardcoded `false`; no activation gate |
| Baseline tests | **409 passed / 0 failed** (measured, see §5) | not run (not selected) |

### 2.2 The known contradiction — confirmed, and it is real

The annex predicted a disagreement between the two READMEs. Both sides were
read and the disagreement is exactly as described:

- `Budlum/BudZKVM` README: *"Faz 0 completed — 31/31 opcodes production-ready"*,
  listing `VerifyMerkle (poseidon4_hash-based 64-depth)` and `Storage` among them.
- `budzero/` README: `VerifyMerkle` is **mainnet-gated** (`MainnetActivation`,
  default off), staged ceremony rollout; the root `budlum` README says the path
  at production depth is **disabled**.

Per the annex, the safe reading governs: **`VerifyMerkle` and the storage
opcodes stay closed here.** How that is enforced — and why it needed code rather
than a flag — is §4 below and finding **z10**.

`lubosruler/budlum` and `lubosruler/BudZero`, mentioned in the annex as
historical inputs, both return **HTTP 404**. Nothing was taken from them.

---

## 3. The situation this landed in (important context)

`gate2/zkvm/` **already existed** when this work began. It arrived in commit
`28026a9` (2026-09-20 03:11 UTC, "lumen-gate auditor"), 62 files and 31 687
lines, with the message *"self-contained ZK proving stack lands with 365 green
tests"*.

That tree is a **renamed copy of the same `budzero/` workspace** this annex
points at. Measured by normalising only the rename (`bud_*` → `zk_*`,
`budzero` → `zkzero`, `.bud` → `.zkl`):

```
zk-isa/src/lib.rs            vs bud-isa/src/lib.rs            0 lines differ
zk-compiler/src/ast.rs       vs bud-compiler/src/ast.rs       0
zk-compiler/src/codegen.rs   vs bud-compiler/src/codegen.rs   0
zk-compiler/src/lexer.rs     vs bud-compiler/src/lexer.rs     0
zk-compiler/src/parser.rs    vs bud-compiler/src/parser.rs    0
zk-vm/src/private_transfer.rs, syscall_context.rs, tests/     0
zk-vm/src/lib.rs (2 579 lines both sides)                     8
```

So the execution half the annex asked for was **already present** — along with
the proof half it asked to leave behind (`zk-proof`, `zk-state`,
`verifier-registry`, `note-packing`).

This was reported as a stop (annex §9: *"if you would have to write a 'ZK' or
'proof' claim somewhere"*) before any file was written. The operator's
instruction was to proceed and **take what testnet needs**. Recorded as decision
**d2**.

What that means concretely, and what it does not:

- The pre-existing tree was **left in place**. Its 365 tests still pass.
- No new copy of the VM was made. Duplicating an already-identical tree would
  have added a second VM to maintain and proved nothing.
- What was **added** is the part that was genuinely missing: the Gate closed-opcode
  profile, the tier program, the shared parity vectors, the determinism harness,
  the toolchain pin, the licence file, this record, `STATUS.md`, `evidence.json`
  and the diff script.
- The "ZK proving stack" framing of commit `28026a9` is **not** adopted or
  repeated. `STATUS.md` states what is and is not true, and the proof half
  remains unclaimed and unwired. See findings z1–z4.

---

## 4. Deviations from source — `patches[]`

Full machine-checkable listing: `./scripts/diff_against_source.sh`, whose output
must match this section exactly. Current output: **21 differing, 0 local-only,
0 not-copied.**

The count moved 18 → 21 in the hardening pass described in §4.2: three files
that previously matched source now carry Gate-authored edits. The three are
`zk-isa/src/lib.rs`, `zk-proof/src/lib.rs` and `zk-state/src/lib.rs`; the other
new content landed in files already on the differing list, or in
`verifier-registry/src/lib.rs`, whose line count grew for the same reason.

### 4.1 Pre-existing, inherited from commit `28026a9`

These 18 files — the import-time set — differ for **one** reason: the source project's
identifiers were renamed. Every diff inspected is of this form —

```
-  // The env var `ZKVM_VERIFY_MERKLE` was removed for a good reason
+  // The env var `BUDLUM_VERIFY_MERKLE` was removed for a good reason
-  let air = ZkAir { ... }
+  let air = BudAir { ... }
-  /// This mirrors `the settlement core's chain_config::slash_penalty`
+  /// This mirrors `budlum_core::core::chain_config::slash_penalty`
```

| file | changed lines | nature |
|---|---|---|
| `zk-vm/src/lib.rs` | 8 | identifier/comment rename |
| `zk-compiler/src/lib.rs` | 12 | rename + spec fence `` ```budl `` → `` ```bud `` with a length fix |
| `zk-proof/src/plonky3_prover.rs` | 70 | `BudAir` → `ZkAir`, comment renames |
| `zk-proof/src/plonky3_air.rs` | 8 | rename |
| `zk-proof/src/relayer.rs` | 10 | rename |
| `zk-proof/src/alarm_log.rs`, `quarantine.rs`, `canonical_boot.rs`, `canonical_recovery.rs`, `transfer_verdict.rs`, `zk_stark/mod.rs` | 2–4 each | rename |
| `zk-proof/benches/canonical_programs.rs`, `proof_baseline.rs` | 2–4 | rename |
| `zk-proof/tests/fiat_shamir_binding.rs`, `soundness_negatives.rs` | 2–6 | rename |
| `zk-state/src/note.rs` | 4 | rename |
| `verifier-registry/src/lib.rs`, `params.rs` | 2–6 | rename |
| `zk-state/Cargo.toml` | 2 | dependency repointed (below) |
| `verifier-registry/Cargo.toml` | 2 | rename |
| directory `bud_stark/` → `zk_stark/` | — | directory rename |

One is not a pure rename and is called out separately:

- **`zk-state/Cargo.toml`** — upstream depends on
  `budlum-note-packing = { path = "../../crates/note-packing" }`, which reaches
  outside the `budzero/` workspace into the monorepo. Here it is
  `zk-note-packing = { path = "../note-packing" }`, i.e. the crate was vendored
  into this workspace to make it self-contained. Content-identical; the path and
  package name changed.

The annex (§1) says existing copyright headers must not be deleted, and this
rename programme conflicts with that: the source project's name appears
**nowhere** in this workspace (`grep -ri 'budlum|budzero|budzkvm'` over
`*.rs`/`*.toml`/`*.md` → **0 matches**). The operator was asked and chose to
continue the scrub rather than restore the headers — decision **d3**, finding
**z3**. The vendored `LICENSE` and this file are now the provenance trail that
the headers would otherwise have carried.

### 4.2 Hardening pass — two operator-directed changes to imported code

These are the only edits in this import that change imported **behaviour** or
imported **text** for a reason other than the rename programme. Both were
directed by the operator after the first review pass.

**(a) `VerifyMerkle` closed at the ISA level — `zk-isa/src/lib.rs`**

Before, the closure lived only in `parity/src/gate_profile.rs`: the Gate profile
refused the opcode, but the imported ISA still accepted it under
`IsaProfile::Production`, and `MainnetActivation::full()` was enough to open it.
That is a narrow lock — it covers the Gate path and the mainnet decode path, and
leaves `decode_for_profile(_, Production)` accepting an opcode whose 64-depth
soundness work (Z-B) is not closed upstream.

`Opcode::is_experimental()` now returns `true` for `VerifyMerkle`, so the refusal
happens one layer earlier and no activation bitmask can override it. Resulting
behaviour, all measured:

| layer | `VerifyMerkle` |
|---|---|
| `Opcode::is_experimental()` | `true` |
| `decode_for_profile(_, Production)` | `Err(ExperimentalOpcodeDisabled)` |
| `decode_for_profile(_, Testing)` | Ok — gated, **not deleted**; the VM and prover suites still exercise it |
| `decode_for_mainnet(_, default())` | refused, one layer earlier than before |
| `decode_for_mainnet(_, full())` | **still refused** — full activation no longer suffices |
| `zk-compiler` codegen, default features | refuses regardless of profile |
| Gate closed set (`gate_profile.rs`) | second, independent refusal |

`Storage` (`SRead`/`SWrite`) was deliberately **not** given the same treatment:
it stays closed on the Gate profile only. Flipping it at the ISA level would
redden imported `zk-proof`/`zk-vm` suites that legitimately use storage, which
would be green-washing in reverse — breaking working imported tests to make a
Gate-side point. `VerifyInference` is likewise left out; it has no verification
circuit upstream and no Gate surface, so the ISA-level list stays minimal and
justified rather than precautionary.

Five imported assertions encoded the old "Production accepts VerifyMerkle"
assumption. They were **rewritten, not deleted** — see `superseded[]` in
`evidence.json` for each one and what replaced it.

**(b) Quarantine banner on the proof half — 4 files**

`zk-proof/src/lib.rs`, `zk-state/src/lib.rs`, `verifier-registry/src/lib.rs` and
`note-packing/src/lib.rs` each gained a header block stating that the crate is
not on the Gate path and that nothing is claimed on it. The banner is prose only
— no code, no attribute, no behaviour change — and it restates in the file what
`parity/tests/quarantine.rs` enforces in the build.

The proof half was **not deleted**. Deleting it would have made the import
unfaithful and would have hidden, rather than answered, the question of what the
Gate does and does not rest on. Quarantine means labelled and fenced.

### 4.3 Added by this work (Gate-authored, no upstream twin)

None of these modify imported code; all are additive.

| path | what it is |
|---|---|
| `parity/` (crate `gate-tier-parity`) | Gate closed-opcode profile, tier parity + determinism harness |
| `programs/gate_tier.zkl` | the tier ladder program |
| `vectors/tier_vectors.json` | shared parity vectors, read by **both** sides |
| `rust-toolchain.toml` | 1.97.1 pin (isolation, rule 4 — finding z6) |
| `LICENSE` | the source's licence file, vendored byte-identical |
| `PROVENANCE.md`, `STATUS.md`, `evidence.json` | this record |
| `scripts/diff_against_source.sh` | the check behind §4 |
| `Cargo.toml` | one line: `parity` added to `members` |

Outside this workspace, exactly one file was touched — permitted by the annex
(§4 rule 7) as the single allowed edit:

| path | change |
|---|---|
| `gate2/soroban/gate_campaign_example/tests/campaign.rs` | **+2 tests** reading `vectors/tier_vectors.json`. No production contract code altered. |

---

## 5. Baselines (measured before copying, from real output)

```
cargo test --manifest-path budzero/Cargo.toml --workspace     # at d8423b77
  20 suites   409 passed   0 failed   0 ignored   exit 0
```

Baseline is **green**, so the annex's "stop if the baseline is red" condition
did not fire.

Gate root, before any change:

```
cargo test --workspace --lib
  domain_adapter 20 · execution_vm 28 · finality_registry 61
  gate_vm 17 · settlement_gateway 11 · gate_campaign_example 0 · gate_claim 0
  all green, exit 0
```

Note on the "12 / 11 / 3" figure the directives quote: `DIRECTIVE.md:68` already
records that this is the 1.0 write-time count and that the repo's floor has
grown to 61/17/11/20/28. The measured numbers agree with that note.

---

## 6. Dependency analysis (annex Z1)

Does the execution half depend on the proof half? **No.**

```
bud-isa       →  (no path dependencies)
bud-vm        →  bud-isa, serde, tracing
bud-compiler  →  bud-isa, logos, tracing
```

References to `bud_proof` or `bud_state` in the sources of `bud-isa`, `bud-vm`
and `bud-compiler`: **0**.

So the boundary the annex draws is real and the "stop if they cannot be
separated" condition did not fire. Two secondary findings:

- `bud-cli` **does** depend on `bud-proof` and `bud-state`, so a `compile`/`run`
  CLI cannot be lifted as-is. Not needed for the parity demo, so not built;
  recorded in `evidence.json` under `excluded[]`.
- `bud-state` reaches outside the workspace for `note-packing` (§4.1).

---

## 7. Decisions taken by the operator

| id | question | decision |
|---|---|---|
| d1 | Which of the two candidate sources to import from | keep `budzero/` (the annex default, and the safer ISA) |
| d2 | `gate2/zkvm/` already exists and contains the proof half | proceed; take what testnet needs; do not duplicate |
| d3 | Source name scrubbed, conflicting with "do not delete copyright lines" | continue the scrub; record the deviation here |

---

## 8. Findings

Findings are never deleted. Full list with detail in `evidence.json` →
`findings[]`; summary:

| id | finding |
|---|---|
| z1 | `gate2/zkvm/` pre-existed and already contained the proof half |
| z2 | that tree is a renamed copy of `budzero/` (normalised diff ≈ 0) |
| z3 | source project name scrubbed everywhere (0 matches) — conflicts with annex §1 |
| z4 | no `LICENSE`, `PROVENANCE.md` or `STATUS.md` accompanied it — now added |
| z6 | no `rust-toolchain.toml`; the tree was building on the root's 1.98.1 — now pinned to 1.97.1 |
| z7 | Z1 clean: execution half has zero dependencies on the proof half |
| z8 | README contradiction confirmed; safe reading adopted |
| z9 | the pre-existing tree is not wired to any contract or web flow (rule 3 intact) |
| z10 | **`IsaProfile::Production` gated nothing as imported** — `is_experimental()` was hardcoded `false` and `MainnetActivation` said nothing about storage; measured, `VerifyMerkle`/`SRead`/`SWrite` all decoded under Production. **Partly closed since:** `VerifyMerkle` is now refused by the ISA itself (§4.2a), so `full()` can no longer open it. `SRead`/`SWrite` stay Gate-profile-only via `parity/src/gate_profile.rs`, an accepted divergence — raising them would redden imported suites that legitimately use storage |
| z11 | the zero-amount vector cannot exist on the Soroban side (`GateClaim` rejects a zero mint, `NothingMinted` #13); checked on the VM side only, recorded in `parity` |
