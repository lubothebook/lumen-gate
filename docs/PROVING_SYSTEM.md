# The proving system, described without marketing

This document exists to answer one question precisely: **what is actually being proved, by what code, and what is it not?**

The short answer is at the top, the definitions are below it, and every number in this file was measured in this repository. Where a number comes from somewhere else, it says so.

---

## 1. Short answer

Lumen Gate does **not** run a zkVM. There is no virtual machine, no instruction set, no memory model, no program commitment and no execution trace anywhere in this system.

What the ZK lane is: a **fixed-statement Groth16 SNARK over BN254**, compiled ahead of time from [`circuits/finality_statement.circom`](../circuits/finality_statement.circom), verified on-chain by a ~180-line verifier inside the registry contract using Stellar's native BN254 host functions (CAP-0074, Protocol 25+). The statement is fixed at compile time, so it cannot be changed without new keys and a new deployment.

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

The full Groth16 rule set — what a proof binds, what it hides, and how public inputs work — is the standard one. Lumen Gate reimplements only the verifier and the byte encoding; it does not invent a proving system.

---

## 2. What is *not* being proved

This is the part that most projects in this space get wrong, so it is stated in the strongest terms:

- **It is not a signature verification proof.** The circuit proves a quorum of approvals exists over a bitmap. It does not prove that any particular validator, key or signature exists. A prover with the required number of set bits can satisfy it. Replacing the bitmap with a BLS or ed25519 signature gadget is the next research step, not something this snapshot claims.
- **It is not a VM-execution proof.** A zkVM proves "program `P`, committed to as `cP`, executed on inputs `I`, produced output `O` and final state `S`". To claim that, a system needs (a) a program commitment and a verifier for that program, (b) an instruction set with semantics, (c) a memory model, (d) a witness generator that replays guest execution. Lumen Gate has none of these four things. It has one statement, hard-coded.
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

## 6. How the tests keep this honest

Three tests in `contracts/finality_registry/src/lib.rs` replay the **exact byte strings** captured from the live lane (see [`src/test_vectors.rs`](../contracts/finality_registry/src/test_vectors.rs)):

| test | what it establishes |
|---|---|
| `test_live_groth16_proof_verifies_in_host` | the 256-byte proof and 768-byte key that a testnet transaction accepted also verify in the Soroban host, and the call reports the measured instruction cost |
| `test_live_groth16_proof_is_rejected_when_the_proof_is_not_the_one` | swapping `A` and `C` — both still valid G1 points in valid encodings, so no length or format check can catch it — is rejected with `InvalidProof`. If the pairing check were a stub, this test would pass the swap |
| `test_live_groth16_proof_does_not_cover_another_state_root` | a genuine proof is not evidence about another block: a mismatched declared root is rejected with `DeclaredMismatch` before a pairing is even attempted |

**A finding from writing these tests.** Two pre-existing tests (`test_register_and_finalize_bls_rejects_bad_sig`, `test_wrong_vk_fake_proof_rejected`) were passing for the wrong reason: they registered a domain but never called `admit_domain`, so `submit_*` returned `NotAdmitted` (#12) and the signature and pairing checks were never reached. The suite was green while testing the guard clause, not the cryptography. Both tests now admit the domain first and assert the specific expected error variant (`InvalidSignature` and `InvalidProof` respectively). This is exactly the class of failure that a "how do you know your verifier works?" question is designed to expose, and it is recorded here rather than quietly fixed.

---

## 7. What a real zkVM lane would require

If someone asks "why not just run a zkVM?", the honest engineering answer has four parts:

1. **A program commitment.** A zkVM proves execution of *arbitrary* code; the verification key must therefore commit to the guest program (or to a universal machine), and the deployer must be able to change the program without redeploying the verifier. Today, changing one line of `finality_statement.circom` changes the verification key, and the live registry's admin is renounced — the statement is frozen by design.
2. **An execution trace as witness.** The prover needs a guest program that replays source-chain execution (state transition function, signature checks, event emission). That is a source-chain VM reimplementation, exactly the kind of work this repository deliberately did not copy from anywhere.
3. **A proof system that fits the host.** Stellar exposes BN254 and BLS12-381 host functions, which suits Groth16 and pairing-based schemes. General-purpose zkVMs (RISC-V style) produce STARK or folding proofs, which would need an on-chain verifier for a large field, recursion, or a STARK→Groth16 wrapper. A wrapper proof of that size is not aimed at a 64 KB contract and a per-transaction instruction budget in the 10^8 range; the entire registry contract — verifier included — is 22.5 KB of WASM, and the verifier costs ~29M instructions in the host model.
4. **A validation story for the guest.** If the guest reimplements consensus, its correctness is the whole game: the circuit's soundness no longer covers the interesting part. Nothing in this snapshot does that, and claiming it would be a lie with extra steps.

Taken seriously, item 2 has a known shape, and naming its parts is the difference between "we did not have time" and "we know exactly what time is needed". The witness of a real VM is a **table, not a list**: one column per machine state worth tracking — program counter, register file, memory bus, read/write flags, a step counter — and one row per execution step. "The program ran correctly" is then two claims about that table. *Locally*, per-row checks called **transition constraints** enforce that each step obeys the instruction semantics, comparing row *i* against row *i+1* so the machine can never take an illegal step; *globally*, boundary conditions fix what the first and last rows must look like, so the trace is anchored to the claimed input and output. Prover cost grows linearly with the number of steps, which is what makes a fixed 628-constraint statement a constant-time verification in comparison. The hardest column family is memory: a guest that reads and writes arbitrary addresses must be *consistent* — a cell holding a value must return that value to every later reader — and that property is not free arithmetic. It is a separate argument, typically built by committing the memory transcript into a hash tree and constraining read and write lookups against it. None of the three parts — the wide table, the transition constraints, the memory argument — exists in this repository, and none is hinted at in its marketing. What exists is the part the settlement decision actually needs: one constrained Poseidon relation binding the roots, verified by a native pairing. If a zkVM lane arrives later, it is this machinery arriving, not a label.

So: what Lumen Gate does instead is the boring, verifiable version — a **fixed statement that is cheap to verify on-chain**, plus a **BLS aggregate signature lane** for the part that actually needs signatures (the event root that authorizes settlement). If a zkVM lane arrives later, it slots in as a third evidence version behind the same `submit_finality_evidence_*` interface, and it will be described accurately on the day it lands.

---

## 8. Reproducing the pipeline end to end

```bash
# 1. circuit -> r1cs + witness generator (circom 2.2.3, circomlib 2.0.5)
circom circuits/finality_statement.circom --r1cs --wasm -o build/ -l tools/include

# 2. local trusted setup (pot12), then circuit-specific setup
snarkjs powersoftau new bn128 12 pot12_0000.ptau -v
snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name="lumen-gate" -e="entropy"
snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau -v
snarkjs groth16 setup build/finality_statement.r1cs pot12_final.ptau fs_0000.zkey
snarkjs zkey export verificationkey fs_final.zkey vk.json      # -> verified by convert_to_soroban.py

# 3. prove a statement
snarkjs wtns calculate build/finality_statement_js/finality_statement.wasm input.json witness.wtns
snarkjs groth16 prove fs_final.zkey witness.wtns proof.json public.json

# 4. serialize into the on-chain layout and submit
python3 circuits/convert_to_soroban.py vk.json proof.json public.json out
stellar contract invoke --id <registry> --source <admin> --network testnet -- \
  submit_finality_evidence_zk --evidence "$EVIDENCE" --proof "$(cat out_proof.hex)" \
  --public_inputs "$(cat out_public.hex)"
```

A `pot12` ceremony run like this is **not** production-grade: the entropy is local and the ceremony participants are fictional. It is sufficient to demonstrate a real proof verified by a real on-chain pairing check, and it is described that way everywhere.

---

## 9. Where the numbers in this document come from

| claim | source |
|---|---|
| 628 constraints, 630 wires, 4 public inputs | `snarkjs r1cs info build/finality_statement.r1cs` |
| 29,118,183 / 29,234,654 cpu instructions | `cargo test -p finality_registry --lib -- --nocapture`, this repository |
| 158,961 stroops charged | accepted testnet transaction, receipt recorded in `deployments/testnet.json` |
| 768 / 256 / 4×32 byte artifacts | `circuits/convert_to_soroban.py`, asserted lengths in `contracts/finality_registry/src/lib.rs` |
| ~12M instructions for a Groth16 verify | CAP-0074 discussion, cited for context only |
| protocol-level host function availability | Stellar Protocol 25 (CAP-0074, BN254) and Protocol 22 (CAP-0059, BLS12-381) |
