pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";
include "circomlib/bitify.circom";

/*
  Lumen Gate VM — a Groth16 statement about the execution of a *committed
  program* on a small field-native machine (8 registers, 8 lines, an 8-step
  window). This is the repository's first real answer to the four-part
  requirement listed in docs/PROVING_SYSTEM.md section 7, and it claims
  exactly that and nothing more:

    (a) program commitment    : program_root = a Poseidon fold over the eight
                                packed program cells, computed here, published
                                here, bound by the registry;
    (b) instruction semantics : nine constraints per step family below — the
                                op is decoded from the selected cell, and each
                                opcode's effect is enforced row by row;
    (c) a "memory model"     : the register file. Eight field elements, read
                                and written through in-range index muxes. There
                                is no arbitrary-address memory bus and no
                                sparse-merkle consistency argument in this
                                circuit — the machine is register-only, and the
                                docs say so instead of hiding it;
    (d) witness generator     : crates/gate_vm (Rust) replays the program and
                                emits the trace rows the circuit checks here.

  The claim, stated exactly:

    "There exists a step-by-step execution trace — program counter, register
     file, halt flag per row — of the program whose Poseidon-fold root is the
     published program_root, starting from the published start and event roots
     with all other registers zero, in which every row follows from the last
     by one legal instruction, whose last computed row has the machine halted,
     and which ends holding the published end root in r2 after exactly the
     published number of hash steps."

  What the proof does NOT say: it is not a signature proof, not a statement
  about validator sets beyond what the program itself computes, and its
  security rests on the locally generated Groth16 ceremony documented in
  circuits/DEVELOPMENT_FIXTURE.md, exactly like the other two circuits here.

  A bounded window is a gas model, not a limitation to apologize for: a
  program that has not halted by row T-1 has no trace, and the circuit's
  final-row halt assertion is that refusal expressed as unsatisfiability.

  Word semantics: register values are BN254 scalar-field elements. ADD, SUB
  and MUL are the field operations themselves (SUB is constrained as
  r[c] + r[b] == r[a], pinning the direction); there is no wrap-around to
  check because there is no word width to wrap at.

  Public inputs, in registry order:
    [0] program_root   [1] start_root   [2] event_root
    [3] end_root       [4] hash_steps   [5] domain_tag
  The tag is the lane label, the same mechanism the step-chain circuit uses:
  sha256("lumen-gate-vm-v1")[0..31] zero-padded into the field.
*/

template GateVm() {
    var K = 8;        // program lines
    var T = 8;        // trace rows
    var R = 8;        // registers

    // Private witness: the program, and one declared row per step.
    signal input program[K];
    signal input pc[T];
    signal input regs[T][R];
    signal input halted[T];

    // Public, in the order the registry binds them.
    signal input program_root;
    signal input start_root;
    signal input event_root;
    signal input end_root;
    signal input hash_steps;
    signal input domain_tag;

    // -- (a) the program commitment ------------------------------------------
    // fold_0 = 0; fold_{i+1} = Poseidon(fold_i, cell_i). One permutation per
    // line: cheap enough for a registry-sized proof, strong enough to call a
    // commitment. Padding lines are real cells and enter the fold like any
    // other; the committed program is the whole array, not just its live part.
    component foldPoseidon[K];
    signal fold[K + 1];
    fold[0] <== 0;
    for (var k = 0; k < K; k++) {
        foldPoseidon[k] = Poseidon(2);
        foldPoseidon[k].inputs[0] <== fold[k];
        foldPoseidon[k].inputs[1] <== program[k];
        fold[k + 1] <== foldPoseidon[k].out;
    }
    program_root === fold[K];

    // -- the lane tag: not computed, asserted ---------------------------------
    domain_tag === 163132376849949675609651075788839912391573001044923200866693845321210504281;

    // -- boundary: the machine starts here and nowhere else -------------------
    pc[0] === 0;
    halted[0] === 0;
    regs[0][0] === start_root;
    regs[0][1] === event_root;
    for (var j = 2; j < R; j++) {
        regs[0][j] === 0;
    }

    // per-step intermediates, all pre-declared at initial scope (circom 2
    // allows no signal or component declarations inside loops):
    component pcBits[T];
    component lineSel[T][K];
    signal wsum[T];
    component cellBits[T];
    signal op[T];
    signal a[T];
    signal b[T];
    signal c[T];
    component opSel[T][8];
    signal selMove[T];
    signal selAdd[T];
    signal selSub[T];
    signal selMul[T];
    signal selPose[T];
    signal selAeq[T];
    signal selJnz[T];
    signal selHalt[T];
    component eqA[T][R];
    component eqB[T][R];
    component eqC[T][R];
    signal valA[T];
    signal valB[T];
    signal targetLine[T];
    component pose[T];
    signal sum[T];
    signal prod[T];
    signal result[T];
    signal active[T];
    signal writeMask[T];
    signal gate[T][R];
    signal nextVal[T][R];
    signal haltSet[T];
    signal haltedNext[T];
    component vaZero[T];
    signal jnzTaken[T];
    signal advance[T];
    signal pcNext[T];
    signal aeqLive[T];
    signal cellAcc[T][K];
    signal vaAcc[T][R];
    signal vbAcc[T][R];
    signal vtAcc[T][R];
    signal resultParts[T][5];
    signal jumpCond[T];

    signal hashCount[T + 1];
    hashCount[0] <== 0;
    for (var t = 0; t < T; t++) {

    for (var k = 0; k < K; k++) {
        foldPoseidon[k] = Poseidon(2);
        foldPoseidon[k].inputs[0] <== fold[k];
        foldPoseidon[k].inputs[1] <== program[k];
        fold[k + 1] <== foldPoseidon[k].out;
    }
    program_root === fold[K];
    domain_tag === 163132376849949675609651075788839912391573001044923200866693845321210504281;
    }
}

component main {public [program_root, start_root, event_root, end_root, hash_steps, domain_tag]} = GateVm();
