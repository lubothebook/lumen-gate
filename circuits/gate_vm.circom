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

    signal hashCount[T + 1];
    hashCount[0] <== 0;

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
    signal cellProd[T][K];
    signal vaProd[T][R];
    signal vbProd[T][R];
    signal haltProd[T];
    signal advSel[T][2];
    signal pcSel[T][2];
    signal nvProd[T][R];
    signal hashInc[T];

    for (var t = 0; t < T; t++) {
        // ---- decode the program line the row claims ------------------------
        // pc is 3 bits, so it can address only real lines; the K equality
        // selectors pick the cell, and the 12-bit decomposition splits it into
        // op, a, b, c — every operand in-range by construction, which is why
        // no separate bounds check is needed anywhere below.
        pcBits[t] = Num2Bits(3);
        pcBits[t].in <== pc[t];

        // The selection sum is accumulated one product per row of signals:
        // R1CS is quadratic, so a bare sum of K products cannot be one
        // constraint and each partial is declared instead of "helpfully"
        // flattened by the compiler.
        for (var k = 0; k < K; k++) {
            lineSel[t][k] = IsZero();
            lineSel[t][k].in <== pc[t] - k;
            cellProd[t][k] <== lineSel[t][k].out * program[k];
            if (k == 0) {
                cellAcc[t][k] <== cellProd[t][k];
            } else {
                cellAcc[t][k] <== cellAcc[t][k - 1] + cellProd[t][k];
            }
        }
        wsum[t] <== cellAcc[t][K - 1]; // the selected packed cell

        cellBits[t] = Num2Bits(12);
        cellBits[t].in <== wsum[t];
        op[t] <== cellBits[t].out[11] * 4 + cellBits[t].out[10] * 2 + cellBits[t].out[9];
        a[t] <== cellBits[t].out[8] * 4 + cellBits[t].out[7] * 2 + cellBits[t].out[6];
        b[t] <== cellBits[t].out[5] * 4 + cellBits[t].out[4] * 2 + cellBits[t].out[3];
        c[t] <== cellBits[t].out[2] * 4 + cellBits[t].out[1] * 2 + cellBits[t].out[0];

        // ---- opcode selectors ------------------------------------------------
        for (var i = 0; i < 8; i++) {
            opSel[t][i] = IsZero();
            opSel[t][i].in <== op[t] - i;
        }
        selMove[t] <== opSel[t][0].out;
        selAdd[t] <== opSel[t][1].out;
        selSub[t] <== opSel[t][2].out;
        selMul[t] <== opSel[t][3].out;
        selPose[t] <== opSel[t][4].out;
        selAeq[t] <== opSel[t][5].out;
        selJnz[t] <== opSel[t][6].out;
        selHalt[t] <== opSel[t][7].out;
        // op is three bits, so exactly one selector is 1 — the eight IsZero
        // gadgets pin the decode; no coverage assertion is needed.

        // ---- read the register file through in-range index muxes ------------
        for (var j = 0; j < R; j++) {
            eqA[t][j] = IsZero();
            eqA[t][j].in <== a[t] - j;
            eqB[t][j] = IsZero();
            eqB[t][j].in <== b[t] - j;
            eqC[t][j] = IsZero();
            eqC[t][j].in <== c[t] - j;
            vaProd[t][j] <== eqA[t][j].out * regs[t][j];
            vbProd[t][j] <== eqB[t][j].out * regs[t][j];
            // `* j` is a constant factor: linear, so it needs no helper.
            if (j == 0) {
                vaAcc[t][j] <== vaProd[t][j];
                vbAcc[t][j] <== vbProd[t][j];
                vtAcc[t][j] <== eqB[t][j].out * j;
            } else {
                vaAcc[t][j] <== vaAcc[t][j - 1] + vaProd[t][j];
                vbAcc[t][j] <== vbAcc[t][j - 1] + vbProd[t][j];
                vtAcc[t][j] <== vtAcc[t][j - 1] + eqB[t][j].out * j;
            }
        }
        valA[t] <== vaAcc[t][R - 1];
        valB[t] <== vbAcc[t][R - 1];
        targetLine[t] <== vtAcc[t][R - 1]; // b as a line number, for JNZ

        // ---- candidates: every result is always computed ----------------------
        // circom has no conditional instantiation; computing the poseidon
        // unconditionally and selecting costs one permutation per row and
        // buys a uniform step relation with no opcode special cases.
        pose[t] = Poseidon(2);
        pose[t].inputs[0] <== valA[t];
        pose[t].inputs[1] <== valB[t];
        sum[t] <== valA[t] + valB[t];
        prod[t] <== valA[t] * valB[t];
        resultParts[t][0] <== selMove[t] * valA[t];
        resultParts[t][1] <== selAdd[t] * sum[t];
        resultParts[t][2] <== selSub[t] * (valA[t] - valB[t]);
        resultParts[t][3] <== selMul[t] * prod[t];
        resultParts[t][4] <== selPose[t] * pose[t].out;
        result[t] <== resultParts[t][0] + resultParts[t][1] + resultParts[t][2]
                   + resultParts[t][3] + resultParts[t][4];

        // ---- writes: only Move/Add/Sub/Mul/Pose, only while active ------------
        active[t] <== 1 - halted[t];
        writeMask[t] <== (selMove[t] + selAdd[t] + selSub[t] + selMul[t] + selPose[t]) * active[t];
        for (var j = 0; j < R; j++) {
            gate[t][j] <== writeMask[t] * eqC[t][j].out;
            nvProd[t][j] <== gate[t][j] * (result[t] - regs[t][j]);
            nextVal[t][j] <== regs[t][j] + nvProd[t][j];
            if (t < T - 1) {
                nextVal[t][j] === regs[t + 1][j];
            }
        }
        // ---- halt: sticky, and set only by a HALT line -----------------------
        haltSet[t] <== selHalt[t] * active[t];
        haltProd[t] <== haltSet[t] * halted[t];
        haltedNext[t] <== halted[t] + haltSet[t] - haltProd[t];
        if (t < T - 1) {
            haltedNext[t] === halted[t + 1];
        }
        if (t == T - 1) {
            // The window must contain the halt. No trace exists for a machine
            // still running when the film runs out.
            haltedNext[t] === 1;
        }

        // ---- program counter --------------------------------------------------
        // JNZ jumps when the tested register is non-zero; a machine that has
        // halted (or halts this very row) keeps its pc, because the frozen
        // rows after a halt re-execute the halt line.
        vaZero[t] = IsZero();
        vaZero[t].in <== valA[t];
        jumpCond[t] <== selJnz[t] * (1 - vaZero[t].out);
        jnzTaken[t] <== jumpCond[t] * active[t];
        advSel[t][0] <== (1 - jnzTaken[t]) * (pc[t] + 1);
        advSel[t][1] <== jnzTaken[t] * targetLine[t];
        advance[t] <== advSel[t][0] + advSel[t][1];
        pcSel[t][0] <== haltedNext[t] * pc[t];
        pcSel[t][1] <== (1 - haltedNext[t]) * advance[t];
        pcNext[t] <== pcSel[t][0] + pcSel[t][1];
        if (t < T - 1) {
            pcNext[t] === pc[t + 1];
        }

        // ---- assertions are real constraints, quietly -------------------------
        aeqLive[t] <== selAeq[t] * active[t];
        aeqLive[t] * (valA[t] - valB[t]) === 0;

        // ---- the hash counter is the chain length ------------------------------
        // Counted from executed rows, never declared by the prover: a program
        // that jumps through the same POSE line three times is three hashes,
        // which is precisely what a compiled fixed-chain circuit cannot say.
        hashInc[t] <== selPose[t] * active[t];
        hashCount[t + 1] <== hashCount[t] + hashInc[t];
    }

    // The public end root is the derived final r2, not the row the prover
    // declared. A prover lying about the output has no witness: the last
    // row's write equation is computed above and pinned here.
    end_root === nextVal[T - 1][2];

    hash_steps === hashCount[T];
}

component main {public [program_root, start_root, event_root, end_root, hash_steps, domain_tag]} = GateVm();
