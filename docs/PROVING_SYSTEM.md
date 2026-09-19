# The proving system, described without marketing

This document exists to answer one question precisely: **what is actually being proved, by what code, and what is it not?**

The short answer is at the top, the definitions are below it, and every number in this file was measured in this repository. Where a number comes from somewhere else, it says so.

---

## 1. Short answer

Lumen Gate runs **four Groth16 lanes over BN254**, and **two of them are bounded VM-execution proofs** on two deliberately different machines. The execution lane — section 5c, live record [`deployments/execution-lane.json`](../deployments/execution-lane.json) — is a word processor: eleven opcodes, eight registers, sixteen memory words, a twenty-row step budget, and the guest program published as public inputs. The gate-vm lane — section 5d, live record [`deployments/gate-vm-lane.json`](../deployments/gate-vm-lane.json) — is a field-native register machine whose instructions can *hash* (Poseidon is an opcode), whose eight-line program enters the proof as a fold commitment rather than as words, and whose row window is its gas. Neither is a general-purpose zkVM: step budgets are constants in the circuits, there are no syscalls, and the guests are assembled from short listings rather than compiled from high-level languages. Section 7 lists exactly what is still missing, in the same terms as before.

The first lane is a **fixed-statement Groth16 SNARK over BN254**, compiled ahead of time from [`circuits/finality_statement.circom`](../circuits/finality_statement.circom), verified on-chain by a ~180-line verifier inside the registry contract using Stellar's native BN254 host functions (CAP-0074, Protocol 25+). The statement is fixed at compile time, so it cannot be changed without new keys and a new deployment.

| | |
|---|---|
| Proof system | Groth16 |
| Curve | BN254 (bn-128 in snarkjs terms) |
| Circuit | `FinalityStatement(5, 3)` — 4 public inputs, 5 private, 0 outputs |
| Constraints | **628** (630 wires, 970 labels) |
| Trusted setup | local Powers-of-Tau, `pot12` (2^12) |
| Prover | circom 2.2.3 + snarkjs 0.7.6 |
| On-chain artifact sizes | verification key **768 bytes**, proof **256 bytes**, public inputs **4 × 32 bytes** |
| Statement (one sentence) | "At least `threshold` approval bits are set, the threshold equals the registered policy, and `prev_state_root`, `state_root` and `event_root` participate in one Poseidon relation." |

A second lane sits beside it: [`circuits/step_chain_statement.circom`](../circuits/step_chain_statement.circom) proves an **N-step chained state transition** rather than one fixed statement. It is described in section 5b, and it is what the "first honest step toward a machine-shaped proof" in earlier revisions of this document turned into. A chain of state transitions is still not a VM — it has no instruction set — and section 5c describes the third lane, which does. Section 5d describes a fourth, beside it: the same machine-shaped claim on a different machine, the one whose machine can hash.

The third lane is [`circuits/execution_trace.circom`](../circuits/execution_trace.circom) with its interpreter [`crates/execution_vm`](../crates/execution_vm): a **bounded machine**, proved step by step, live on testnet. Four things in section 7's list were missing before it and are present in it: an instruction set with semantics, a commitment to the guest program, a memory model, and a witness generator that replays an execution.

The fourth lane is [`circuits/gate_vm.circom`](../circuits/gate_vm.circom) with its interpreter [`crates/gate_vm`](../crates/gate_vm): also a bounded machine, also live on testnet, and the place where two alternative answers to the same design question are kept side by side for comparison — public program words versus a folded commitment, arithmetic over wrapped 64-bit words versus native field arithmetic with a hash instruction inside the machine.

The full Groth16 rule set — what a proof binds, what it hides, and how public inputs work — is the standard one. Lumen Gate reimplements only the verifier and the byte encoding; it does not invent a proving system.

---

## 2. What is *not* being proved

This is the part that most projects in this space get wrong, so it is stated in the strongest terms:

- **It is not a signature verification proof.** The circuit proves a quorum of approvals exists over a bitmap. It does not prove that any particular validator, key or signature exists. A prover with the required number of set bits can satisfy it. Replacing the bitmap with a BLS or ed25519 signature gadget is the next research step, not something this snapshot claims.
- **The VM-execution claim is bounded, and the bound is a constant in the circuit.** The execution lane proves "program `P`, committed to as a public input, executed from the register file whose Poseidon root is published, produced the published end root and program counter after `n` steps at cost `g`" — the four things this bullet used to say were absent are in section 5c. What it does **not** prove is that a machine of *any* size could have run it: twenty rows, sixteen instructions, sixteen memory words, eight registers, no syscalls. A program that needs a twenty-first step has no proof in this circuit, and the registry refuses a payload claiming one. Nor does it prove anything about consensus, or about a source chain's state transition function — the guest is a program someone writes, and its correctness is theirs.
- **It is not privacy-preserving.** All four public signals are, by design, public. This lane is about *succinctness and on-chain verifiability*, not about hiding anything.
- **It does not authorize settlement.** Because the circuit does not cover an event root with signatures, the registry **does not persist** an event root from this lane: it stores zeroes in that slot. Minting reads an event root, so the settlement anchor for the live round trip comes from the **BLS** lane. This refusal is deliberate: persisting an unsigned root would make an unconstrained value the anchor for Merkle settlement proofs.

The legacy entrypoint name `verify_via_zkvm` is kept only because the live registry's admin has been renounced and the ABI cannot be renamed in place. The function's own comments in [`contracts/finality_registry/src/lib.rs`](../contracts/finality_registry/src/lib.rs) repeat the disclaimer above so that a reader who lands there first is not misled.

---

## 3. The statement, signal by signal

Public signals, in the order the deployed verifier expects:

```text
public_inputs[0] = prev_state_root
public_inputs[1] = event_root
public_inputs[2] = threshold
public_inputs[3] = state_root      <- the value the registry binds to the evidence
```

Private input: `enabled[5]`, the approval bitmap.

The constraints, in plain words:

1. Every `enabled[i]` is exactly `0` or `1` (`enabled[i] * (enabled[i] - 1) === 0`). Without this a prover could inflate the count with values larger than one.
2. The sum of the bits is `>= threshold` (8-bit `GreaterEqThan`).
3. `threshold == 3`, the registered policy for this deployment — so a prover cannot lower the bar by choosing its own threshold.
4. `Poseidon(prev_state_root, state_root, event_root) != 0` — the three roots are bound into one relation, which is what stops any of them from being free metadata.
5. There is deliberately **no `signal output`**: any output would become an extra public input and shift the indices the verifier contract depends on.

The registry additionally enforces, before it ever touches the proof:

- `public_inputs.len() == 4`,
- `public_inputs[3] == evidence.declared_root`,
- `evidence.declared_root` and `evidence.declared_height` match the 40-byte evidence payload (`height u64 LE ‖ state_root`),
- every public input is a **canonical** field element below the BN254 Fr modulus. Soroban's `Bn254Fr::from_bytes` reduces modulo `r`, so a non-canonical input would silently mean a *different* witness; the verifier rejects it up front.

That last check is a verifier bug class, not a formality. It is covered by the `scalar_is_canonical` function and by the replay/tamper probes in `contracts/finality_registry/test_snapshots/`.

---

## 4. Byte encoding, written down

Anyone reproducing this needs the exact layout, because a wrong encoding fails at runtime with a correctly sized key — the worst kind of bug.

```text
proof : A(G1,64) || B(G2,128) || C(G1,64)                     = 256 bytes
vk    : alpha(G1,64) || beta(G2,128) || gamma(G2,128)
        || delta(G2,128) || IC[0..n](G1,64 each)              = 768 bytes for n=4
G1    : X(32) || Y(32)                       big-endian Fp elements
G2    : X(64) || Y(64)                       each Fp2 coordinate as c1(32) || c0(32)
                                             -- imaginary part FIRST
```

snarkjs writes each Fp2 coordinate real-first (`[c0, c1]`); Soroban's host functions want the imaginary part first. [`circuits/convert_to_soroban.py`](../circuits/convert_to_soroban.py) performs that swap and asserts the result. The converter also drops the leading `1` that some snarkjs versions prepend to the public input list; the count is taken from `vk.nPublic` instead of assumed.

---

## 5. What it costs, measured

Two independent measurements, both from this repository.

**Host-model CPU instructions.** The unit tests measure the exact verifier the contract runs, in the Soroban test host:

| measurement | cpu instructions |
|---|---|
| `groth16::verify` only (pairing check + scalar multiplications) | **29,118,183** |
| whole `submit_finality_evidence_zk` call (verifier + storage + event) | **29,234,654** |

The difference is ~116k instructions, i.e. the storage writes and the event cost about 0.4% of the call. The pairing dominates, as expected. Re-measure with:

```bash
cargo test -p finality_registry --lib -- --nocapture
# [proving-system] bn254 pairing check over a 256-byte proof and a 768-byte vk: 29234654 cpu instructions (host model, Rust target)
# [proving-system] pairing + scalars only: 29118183 cpu instructions (host model)
```

Soroban's own documentation notes that these host-model counts **underestimate** the WASM path, so treat them as a lower bound rather than a fee prediction. For context, the CAP-0074 discussion cites roughly 12M instructions for a Groth16 verification of a smaller instance; the extra cost here is consistent with four public inputs (one extra pairing term and four scalar multiplications) plus the native-model caveat. That figure is *cited*, not measured in this repository — the two numbers in the table above are ours.

**Live testnet fee.** The accepted ZK anchor on testnet (see the receipt in the README) proposed 186,219 stroops and was charged **158,961 stroops** (0.0158961 XLM), with 27,258 refunded. That is the real, consensus-charged price of anchoring one finalized source block through this lane on a 3-validator-style statement — small enough that per-message ZK anchoring is not the cost bottleneck in this design.

---

## 5b. The chained lane, and what it changes

The single-statement circuit answers "did finality evidence exist for this exact event". A settlement layer that advances a state wants a different question answered: "does a sequence of quorum-bearing steps carry the state from the root I last accepted to the root being claimed". That is a transition relation, and it is what the second circuit encodes.

| | |
|---|---|
| Circuit | `StepChainStatement(4, 3, 2)` — 6 public inputs, 4×3 + 4 + 4 private |
| Constraints | **2259 non-linear, 2784 linear** (5029 wires, 7720 labels) |
| Public inputs | `chain_start_root`, `chain_end_root`, `event_root`, `threshold`, `chain_length`, `domain_tag` |
| On-chain artifacts | verification key **896 bytes**, proof **256 bytes**, payload **112 bytes**, public inputs **6 × 32 bytes** |
| Domain tag | `lumen-gate-step-chain-v1` → `0x9517e443e84062a6…74f0`, distinct from the `lumen-gate-finality-v1` label the other lane and the BLS hash-to-curve path use |
| Chained verifier cost (host model) | **31,664,510** cpu instructions for the whole `submit_step_chain_zk` call |

**The step relation.** Step *i* takes the previous root and its own evidence, and produces the next:

```
step_digest_i = Poseidon(DIGEST_TAG, effective_count_i, event_root)
root_i        = is_active_i * Poseidon(CHAIN_TAG, root_{i-1}, step_digest_i)
                + (1 - is_active_i) * root_{i-1}
```

The order of steps is not a convention that a test checks after the fact; it is the chaining itself. A prover that wants to claim step 3 happened first has to produce a root that links from the published start root through that digest, and the published end root — which the registry binds to the evidence payload — is the last link. Swapping the start and end roots is refused (there is a test for exactly that), because a chain presented backwards links to nothing.

**Padding is isolated twice.** A capacity-four circuit used for a three-step chain must not let the fourth step contribute. Its approvals are zeroed before they reach the digest — `effective = raw_count * is_active` — *and* the root it leaves behind is exactly the previous root. Both are equality constraints, because a witness-only zeroing is not a proof: a malicious prover would simply set the signal to something else. The test matrix covers this from both sides: writing approvals onto padded steps still verifies to the same end root (so a padded step really contributes nothing), and declaring a padded step active without recomputing the chain is refused (so the padding cannot be turned on for free).

**Nothing is merely computed.** Every signal is boolean-forced, equated to an expression of other signals, or bound to a public input: `is_active * (is_active - 1) = 0`, `approvals[i][j] * (approvals[i][j] - 1) = 0`, exact sums for both counters, an `IsEqual` against the compiled threshold and the compiled tag, a `GreaterEqThan` plus a range-checked margin per step, `intermediate_roots[i] === root[i]` so the declared roots are derived rather than supplied, `chain_length` bounded by bits and required to equal the sum of `is_active`, and `end != start` enforced with the circomlib inverse-witness pattern (`IsEqual`, whose internal `IsZero` uses the standard inverse witness rather than a reinvented comparison). Every public input appears in at least one constraint. The exhaustive list is in the circuit header.

**What the chain does not do.** It does not verify approval *signatures*: the per-step quorum is an approval bitmap, so the chain proves that a quorum was asserted and carried, not that it was cryptographically signed. A production chain replaces the bitmap with a signature gadget inside the circuit. It also does not bind `chain_start_root` to the previously accepted root on-chain — continuity between accepted chains is the registry's monotonic height rule, not a proof. Both limits are stated in the README and in the circuit header rather than left for a reviewer to discover.

**Why the byte sizes differ, and why that matters.** Six public inputs make the verification key 896 bytes instead of 768 (`IC` grows by one G1 point per public input). The contract therefore keeps the two keys in different storage slots with different hard length limits, and refuses a proof or a key of the wrong length *before* decoding anything. A verifier that silently sliced a short byte string would be reading a shifted set of coordinates; both lanes reject that explicitly and both are tested for a proof one byte short and one byte long.

---

## 5c. The execution lane: the machine, and what it cost to install

The chained lane proves that steps are linked. The execution lane proves that a *program* ran: it is the difference between a chain of hashes and a machine.

| | |
|---|---|
| Circuit | `ExecutionTrace(20, 16, 16, 8)` — 22 public inputs, 2224 private signals |
| Constraints | **9996 non-linear, 2694 linear** |
| Public inputs | `program[0..15]`, `initial_regs_root`, `final_regs_root`, `final_pc`, `steps_executed`, `gas_used`, `domain_tag` |
| On-chain artifacts | verification key **1920 bytes**, proof **256 bytes**, payload **232 bytes**, public inputs **22 × 32 bytes** |
| Domain tag | `lumen-gate-execution-v1` → `00cf562c45b7d43f…7db4`, distinct from both other lanes |
| Machine | [`crates/execution_vm`](../crates/execution_vm): 11 opcodes, 8 registers (r0 pinned), 16 memory words, 16-instruction program, wrapping 64-bit arithmetic, per-opcode gas |
| Live run | registry `CAQ77OEK…`, transaction `70cb914a…`, ledger **4,765,687**, **206,052 stroops**, 16 steps of 20 rows, 25 gas, final pc 12 |

**The statement, and where it is written down.** The circuit header lists it in full and the crate's doc comment repeats it: there exists a run of the committed program, from the register file whose Poseidon root is published and from zeroed memory, ending halted at the published program counter after exactly the published number of steps at exactly the published cost, with the ending register file hashing to the published end root, and with every row following from the previous one by one legal instruction.

**Program commitment without a Poseidon fold.** The guest program is sixteen packed 64-bit words held as *public inputs*, and each row's decode is one linear equation:

```
opcode + 2^8·rd + 2^13·rs1 + 2^18·rs2 + 2^23·imm  ===  program[pc]
```

with the row's program counter pinned by a one-hot selection over the sixteen slots, the opcode pinned to one of the eleven implemented bytes by a selector one-hot, the three register indices pinned by their own one-hots, and the immediate's width pinned by a 32-bit decomposition. The useful consequence: the deployer can change the program without redeploying the verifier, because the program is not baked into the key. The registry binds the same words to a sha256 program digest in the evidence payload, so a proof cannot be re-pointed at a different program, and it refuses a payload whose slots past the instruction count are not zero halts.

**The memory argument, in the affordable direction.** A general-purpose memory argument commits the address space and proves read/write consistency with a permutation or a Merkle transcript. At this size there is a cheaper and equally sound shape: the trace *carries* the memory. Sixteen words per row, `mem[i+1] = mem[i] + store_gate·(written value − mem[i])` from `mem[0] = 0`, reads through a one-hot selection gated by `is_load_mem`, writes gated by the store selector, and the address pinned to `rs1 + signed immediate`. A read therefore returns the word the state carried in — there is no separate transcript to be inconsistent with, because the state is the transcript. That is why the address space is sixteen words and not a gigabyte: the carried form costs one column per word per row.

**Wrapping arithmetic, and why the carries are signals.** The machine's arithmetic wraps modulo 2^64 rather than living in the field, which means the circuit cannot simply add two signals. Each addition carries a boolean carry, each subtraction a boolean borrow, and each multiplication a 64-bit quotient, and the destination value is range-checked to 64 bits — which is what pins the carry to the true one, since the alternative choice would put the result above 2^64. The multiplication identity `rs1·rs2 = q·2^64 + rd` with `q` and `rd` both range-checked is an integer equation, not a field equation that happens to have a solution.

**Padding, in one sentence.** The circuit says: *row i is a halt unless it is an active row followed by another active row* — `is_halt[i] = 1 − is_active[i]·is_active[i+1]`, one constraint per row. That single sentence pins the halt to the last active row, makes every padding row a halt, makes the trace's last row a halt, and forces `steps_executed` to equal the number of active rows. A padding row is a halt, and a halt freezes the program counter, the register file and memory, so padded steps cannot contribute to the end state or the cost.

**What the 34-check matrix establishes.** [`tools/execution-trace-tests.mjs`](../tools/execution-trace-tests.mjs) runs two honest inputs and twenty-seven mutations against the compiled witness generator, and requires each mutation to be refused **at the constraint it targets** — the harness matches the refusal against the pinned source line, because a mutation that trips a different constraint would otherwise read as coverage for a family nobody tested. It also runs five programs the machine itself refuses — an assertion on a zero operand, a step overrun, an address past the address space, an instruction outside the subset, a program longer than the committed slots — because a refusal is not a run and the circuit has nothing to prove about one. One of the twenty-seven is worth naming: `assertion_on_a_zero_operand` rewrites the run *consistently* all the way to the final root (the first comparison writes to r0 instead, so the value the assertion reads is zero) so that the only thing left violated is the assertion's semantics — the test distinguishes "the proof machinery noticed something" from "the machine's refusal is unprovable".

**What this lane does not do.** It does not move the settlement anchor: `ExecutionRecord` carries `settlement_anchored: false`, and the registry writes nothing into the domain that minting reads. An execution proof currently establishes that a run happened as stated — not that value may move because of it. It also does not compile anything: the guest arrives as a listing for a small assembler in this repository.

---

## 5d. The gate-vm lane: the machine that hashes, and the commitment that hides the program

The execution lane proves a word processor ran. The gate-vm lane proves a different machine ran, built to answer a question the first machine structurally cannot: *can the program compute hashes as data?* On `execution_trace`, a hash chain is something the circuit wraps around the machine; on `gate_vm`, `POSEIDON r2, r2, r1` is a line of the program, and a proof that the chain ran four steps is a proof about four executed instructions, not about four built-in permutations.

| | |
| --- | --- |
| Circuit | [`circuits/gate_vm.circom`](../circuits/gate_vm.circom): 5109 non-linear and 5075 linear constraints, powers-of-tau 2^14 |
| Machine | [`crates/gate_vm`](../crates/gate_vm): 8 registers of BN254 field elements, 8 program lines of 12 packed bits, 8 opcodes (move, add, sub, mul, poseidon, assert_eq, jnz, halt), 8-row window, halt required by row eight |
| Program commitment | `program_root = fold(Poseidon)` over the eight private cells, computed *in* the circuit and published as a public input; the cells themselves never appear in the statement. Changing the program changes the root, not the verification key — and unlike the public-words form, the statement size does not scale with the program |
| Public inputs | 6: `program_root, start_root, event_root, end_root, hash_steps, domain_tag` — the same domain-tag rule as the other lanes, `sha256("lumen-gate-vm-v1")[0..31]` |
| Gas | the window. A program that has not halted by row seven (of eight) has no witness; `hash_steps` is *counted by the circuit* from executed rows, never declared by the prover, which is what makes it bindable |
| Verification key | 896 bytes — the same length as the step-chain lane's, and that coincidence is tested: the slots keep the keys apart, and the pairing equation catches what a length check cannot |
| Live run | registry `CDWJWDJV…`, transaction `6d67f5f4…`, ledger **4,765,859**, **177,143 stroops**; 14/14 probes in [`deployments/gate-vm-lane.json`](../deployments/gate-vm-lane.json) |
| Ceremony | the same local one (single contribution), documented as not-production in [`circuits/DEVELOPMENT_FIXTURE.md`](DEVELOPMENT_FIXTURE.md) — this lane buys nothing on the trust front, and does not claim to |

**Why the program cells are private.** On the execution lane, publishing the sixteen words lets the contract check the encoding of every instruction *before* verifying anything — a real feature, and its payload carries the words. On this lane the program is witness data and the statement carries its 32-byte fold, so a payload cannot even claim "a longer program" without claiming a different root: the binding is one number instead of sixteen, at the cost of the contract's ability to pre-check instruction encodings. Both forms exist now, in one repository, under one ceremony standard, which is worth more than either argued alone.

**The Poseidon calibration chain, because hand-ported hashes fail silently.** The lane's hash instruction means three implementations of one permutation must agree bit-for-bit: the Rust port (`crates/gate_vm`), the generated round constants (`src/poseidon_consts.rs`, from `gen_poseidon3.py`), and the pinned `circomlib` template the circuit includes. They are welded together by a *probe circuit*: [`circuits/poseidon_probe.circom`](../circuits/poseidon_probe.circom) is a bare `Poseidon(2)` main, `gen_poseidon_probe.py` runs snarkjs over six probe pairs (including near-field-boundary values and the published `(0,0)` test vector), extracts `main.out` through the `.sym` map, and commits the results as `crates/gate_vm/tests/poseidon_golden.json`. The Rust test asserts the port reproduces all six. A wrong round constant is not an error message — it is a different hash, quietly, on both sides of every future proof; this is the mechanism that makes that state unreachable by construction.

**What this lane does not do.** It is register-only: there is no arbitrary-address memory bus and no consistency argument, because there is nothing to be consistent about — a claim the docs make explicitly so nobody has to discover the absence by reading the constraint list. The window bounds the run. It does not move the settlement anchor (`settlement_anchored: false` in its record, a test pinning that it stays false), and the guest's correctness remains its author's problem, exactly as section 7 item 4 says.

---

## 6. How the tests keep this honest

Three tests in `contracts/finality_registry/src/lib.rs` replay the **exact byte strings** captured from the live lane (see [`src/test_vectors.rs`](../contracts/finality_registry/src/test_vectors.rs)):

| test | what it establishes |
|---|---|
| `test_live_groth16_proof_verifies_in_host` | the 256-byte proof and 768-byte key that a testnet transaction accepted also verify in the Soroban host, and the call reports the measured instruction cost |
| `test_live_groth16_proof_is_rejected_when_the_proof_is_not_the_one` | swapping `A` and `C` — both still valid G1 points in valid encodings, so no length or format check can catch it — is rejected with `InvalidProof`. If the pairing check were a stub, this test would pass the swap |
| `test_live_groth16_proof_does_not_cover_another_state_root` | a genuine proof is not evidence about another block: a mismatched declared root is rejected with `DeclaredMismatch` before a pairing is even attempted |

The gate-vm lane brings twelve more host tests (`test_gate_vm_*`), replaying the vectors this repository generated end to end: honest accept with the recorded roots read back field-for-field, a rewritten program-root commitment refused at the binding, an inflated hash count refused as a format error before any pairing, swapped `start`/`event` publics refused by position, the *step-chain lane's* tag refused even though every other number agrees, short proof and short payload refused by the length rules, replay refused by the consumed digest, the anchor untouched, and — the mix-up length checks cannot catch — the step-chain's key, which is also exactly 896 bytes, accepted into the gate-vm slot and refused by the pairing equation itself. Fifteen crate tests and three calibration tests cover the emitter and the Poseidon chain; the full set runs under `cargo test --workspace`.

The execution lane has its own three host tests in the same file: the 256-byte proof and 1920-byte key accepted by the live registry reproduce in the Soroban host (with the measured cost printed under `--nocapture`), a proof whose group elements are moved is rejected with `InvalidProof`, and a payload whose program word differs from the one the proof committed is rejected with `DeclaredMismatch` before a pairing is attempted. Twelve more cover the lane's own payload parser: the instruction words, the halt-padded slots, the step ceiling, the gas ceiling, the tag, the key length, the replay rule and the renounced-admin rule.

**A finding from writing these tests.** Two pre-existing tests (`test_register_and_finalize_bls_rejects_bad_sig`, `test_wrong_vk_fake_proof_rejected`) were passing for the wrong reason: they registered a domain but never called `admit_domain`, so `submit_*` returned `NotAdmitted` (#12) and the signature and pairing checks were never reached. The suite was green while testing the guard clause, not the cryptography. Both tests now admit the domain first and assert the specific expected error variant (`InvalidSignature` and `InvalidProof` respectively). This is exactly the class of failure that a "how do you know your verifier works?" question is designed to expose, and it is recorded here rather than quietly fixed.

---

## 7. What the bounded machine installed, and what a general-purpose VM would still require

This section used to list four things a VM proof needs. Three of them arrived in the execution lane; the fourth is still missing, and it is the one that matters most for a source-chain claim.

1. **A program commitment.** *Installed, in the shape that fits a verifier key.* The sixteen packed instruction words are public inputs, and each row's decode is a linear equation against the word its program counter selects, so a proof is about *that* program and the verifier key does not change when the program does. What that is not: a *universal* machine. The key commits to the machine (its ISA, its widths, its row budget), and the program is bounded by sixteen slots and twenty rows. A general-purpose guest — arbitrary length, arbitrary control flow — would need either a universal circuit with a fixed key over unbounded programs or recursion, and neither is here.
2. **An execution trace as witness.** *Installed, bounded.* [`crates/execution_vm`](../crates/execution_vm) runs the program, exposes the trace (clock, program counter, opcode, the three register indices, both operand values, the result, the next program counter, the memory event, the immediate, the carried registers and memory), pads it to the circuit's rows, and re-checks it row by row with `check_trace` before it becomes witness data. What that is not: a replay of a *source chain's* state transition function. The guest is a program someone writes in this ISA; nothing here reimplements consensus, signature schemes on the guest side, or event emission.
3. **A proof system that fits the host.** *Unchanged, and it is the reason the lane looks like this.* A 12,690-constraint Groth16 circuit with 22 public inputs verifies through Stellar's native BN254 pairing in **206,052 stroops** on testnet. A RISC-V-style STARK prover would still need an on-chain verifier for a large field, recursion, or a wrapper proof, and a wrapper of that size is not aimed at a 64 KB contract and a per-transaction instruction budget in the 10^8 range.
4. **A validation story for the guest.** *Still the whole game, and still absent.* The circuit's soundness covers the *machine*: given the committed program and the published state roots, a proof cannot exist for a run that did not happen. It says nothing about whether the program does something sensible — a correct proof of a foolish program is still a correct proof. Nothing in this repository reimplements consensus, and claiming otherwise would be a lie with extra steps.

**The prediction this section made, checked against what was built.** It said the witness of a real VM is *a table, not a list* — one column per machine state worth tracking, one row per step — that the per-row **transition constraints** are the load-bearing part, and that the hardest column family is memory. That is what the circuit turned out to be: twenty rows of twenty-three columns, with each row's semantics, register carry and memory carry written as constraints against the row before it, and the boundary conditions fixing the first row (program counter zero, r0 zero, memory zeroed) and the last (a halt, the published end root). Two details are worth recording because they were not obvious in advance:

- **The memory argument did not need a transcript.** A general-purpose design commits the address space and proves consistency with a permutation or a Merkle transcript, because the memory is too large to carry. Sixteen words are not: the trace carries the memory itself, `mem[i+1] = mem[i] + store_gate·(written value − mem[i])`, and a read is a one-hot selection over the state carried into the row. The consistency property — a cell holding a value returns that value to every later reader — falls out of the transition constraint rather than needing an argument of its own. The cost of that choice is the size of the address space, and it is stated where it applies rather than in a footnote.
- **Range checks are what make the carries meaningful.** The machine wraps modulo 2^64, so the circuit cannot just add signals: each add carries a bit, each multiplication a quotient, and the destination value is range-checked to 64 bits — which is what forces the carry to be the true one rather than the permissive one. Without the range check the equation would have two solutions and the prover would pick the one that suits it.

**What the settlement decision still rests on.** The execution lane is recorded accurately and deliberately does not move the anchor: `settlement_anchored: false`, nothing written into the domain that minting reads. The live round trip is still anchored by the **BLS aggregate lane**, whose signature covers the event root, plus the fixed-statement circuit for the quorum relation. Wiring an execution proof into the anchor is a contract and policy change — which programs may move it, who may submit them — and it has not been made.

---

## 8. Reproducing the pipeline end to end

The tooling lives in the repository now — these commands are the ones that produced the artifacts committed here, and they need no include directory that is not already pinned in `package.json`.

```bash
npm install --no-audit --no-fund          # pinned circomlib 2.0.5 + snarkjs 0.7.6 + circomlibjs
```

```bash
# 1. circuits -> r1cs + witness generators (circom 2.2.3; four circuits)
./circuits/build.sh                       # all four, or name one

# 2. local trusted setup + honest proof  (stated as a local, non-production ceremony)
node tools/step-chain-input.mjs --length 3 --out build/step_chain_statement_input.json
./circuits/setup.sh step_chain_statement

# 3. one negative test per constraint family -- 18 checks, each requiring its own refusal
node tools/step-chain-tests.mjs

# 4. serialize into the on-chain layout, then let cargo replay the bytes
python3 circuits/convert_to_soroban.py build/step_chain_statement_vk.json \
    build/step_chain_statement_proof.json build/step_chain_statement_public.json \
    build/step_chain_statement --rust-out contracts/finality_registry/src/step_chain_vectors.rs
cargo test -p finality_registry
```

```bash
# the execution lane, end to end. The powers-of-tau for this circuit is 2^14:
# the trace circuit has 12,690 constraints, and circuits/setup.sh derives the
# size from the r1cs rather than from a constant, so this needs no extra flag.
node tools/execution-lane-input.mjs --out build/execution_trace_input.json
./circuits/setup.sh execution_trace                       # compile, setup, prove, verify
node tools/execution-trace-tests.mjs                      # 34 checks, one per constraint family
python3 circuits/convert_to_soroban.py build/execution_trace_vk.json \
    build/execution_trace_proof.json build/execution_trace_public.json \
    circuits/execution_trace --rust-out contracts/finality_registry/src/execution_trace_vectors.rs
cargo test -p finality_registry                            # replays the bytes in the Soroban host
node tools/execution-lane-live.js                          # deploys a fresh registry and probes it live
```

```bash
# the gate-vm lane, end to end. The window circuit needs 2^14 as well, and the
# emitter — not a node tool — produces the witness input:
cargo run -p gate_vm -- --emit-dir build --height 42    # gate_vm_input.json, payload, publics
node_modules/.bin/snarkjs wtns calculate build/gate_vm_js/gate_vm.wasm \
    build/gate_vm_input.json build/gate_vm.wtns
node_modules/.bin/snarkjs wchk build/gate_vm.r1cs build/gate_vm.wtns   # the trace satisfies the circuit
PTAU_POWER=14 ./circuits/setup.sh gate_vm                              # ceremony, prove, verify
python3 circuits/convert_to_soroban.py build/gate_vm_vk.json \
    build/gate_vm_proof.json build/gate_vm_public.json build/gate_vm \
    --public-names program_root,start_root,event_root,end_root,hash_steps,domain_tag \
    --rust-out contracts/finality_registry/src/gate_vm_vectors.rs --expect-inputs 6
cargo test -p finality_registry                            # replays the bytes in the Soroban host
node tools/gate-vm-lane-live.js                              # deploys a fresh registry and probes it live
# Poseidon calibration, after touching the port, the constants or circomlib:
python3 circuits/gen_poseidon_probe.py && cargo test -p gate_vm
```

The input for the execution lane is generated by the machine itself, not by a fixture: `tools/execution-lane-input.mjs` runs `cargo run -p execution_vm --bin execution-lane`, which assembles the program, executes it, pads the trace to twenty rows, checks it with `check_trace`, and prints the trace; the tool then computes the two Poseidon register roots with circomlibjs and writes the circuit input. A mutation that the circuit should refuse is produced by the same tool with `--mutate <name>`, and the harness runs it through the pinned `--mutate` names rather than editing JSON by hand.

The same shape applies to the single-statement circuit (`./circuits/setup.sh finality_statement`), whose vectors live in [`src/test_vectors.rs`](../contracts/finality_registry/src/test_vectors.rs).

A locally generated powers-of-tau and a locally generated proving key are **not** production-grade: whoever ran the ceremony could in principle know the toxic waste, and the ceremony participants are fictional. They are sufficient to demonstrate a real proof verified by a real on-chain pairing check, and `circuits/setup.sh` says so in its own header.

---

## 9. Where the numbers in this document come from

| claim | source |
|---|---|
| 628 constraints, 630 wires, 970 labels, 4 public inputs | `circom circuits/finality_statement.circom --r1cs`, and `docs`'s table |
| 2259 non-linear / 2784 linear constraints, 5029 wires, 7720 labels | `./circuits/build.sh step_chain_statement` |
| 29,118,183 / 29,234,654 cpu instructions (single-statement lane) | `cargo test -p finality_registry --lib -- --nocapture`, this repository |
| 31,664,510 cpu instructions (chained lane, whole call) | same test suite, `test_step_chain_proof_verifies_in_host_and_is_recorded` |
| 158,961 stroops charged | accepted testnet transaction, receipt recorded in `deployments/testnet.json` |
| 768 / 256 / 4×32 byte artifacts | `circuits/convert_to_soroban.py`, asserted lengths in `contracts/finality_registry/src/lib.rs` |
| 896 / 256 / 6×32 / 112-byte artifacts | same converter and contract, chained lane constants |
| 9996 non-linear / 2694 linear constraints, 2224 private signals | `./circuits/build.sh execution_trace` |
| 1920 / 256 / 22×32 / 232-byte artifacts | same converter and contract, execution lane constants |
| 206,052 stroops charged, ledger 4,765,687 | accepted testnet transaction `70cb914a…`, recorded in `deployments/execution-lane.json` |
| 16 steps of 20 rows, 25 gas, final pc 12 | the same record, cross-read from the contract with `get_execution_record` |
| ~12M instructions for a Groth16 verify | CAP-0074 discussion, cited for context only |
| protocol-level host function availability | Stellar Protocol 25 (CAP-0074, BN254) and Protocol 22 (CAP-0059, BLS12-381) |
| tag derivation `sha256(`lumen-gate-step-chain-v1`)[0..31] mod r` | computed in this repository and pinned by `test_step_chain_tag_matches_the_circuit_constant` |
