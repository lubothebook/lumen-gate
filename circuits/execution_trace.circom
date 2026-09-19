pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/bitify.circom";

/*
  Lumen Gate -- execution lane: the trace circuit (Groth16 / BN254).

  The single-statement circuit next to this file proves a fixed claim about one
  bitmap and three roots. The chained circuit proves a sequence of such claims.
  This one is different in kind: it proves the execution of a *program*.

  Claim, stated exactly:

      "There is a run of the committed program -- the 16 program words below,
       one packed instruction each -- on a machine with 8 registers and 16 words
       of memory, all values 64 bits wide, which starts at pc 0 with zeroed
       memory, fetches exactly `steps_executed` instructions, ends by executing a
       Halt, and during which every instruction's operands, result, next program
       counter, register file and memory state obey that instruction's
       semantics. The run ends at the published program counter with the
       published register file, and the instructions charged exactly `gas_used`
       at the published costing."

  The machine itself -- the instruction set, the interpreter, and the same
  constraints written a second time in plain Rust -- is
  `crates/execution_vm`. This circuit and that crate are two implementations of
  one relation on purpose: the crate can be read and run, this circuit can be
  proved and verified on-chain, and a disagreement between them is a test
  failure in whichever one is wrong.

  ---------------------------------------------------------------------------
  WHAT MAKES THIS A MACHINE AND NOT A FIXED STATEMENT
  ---------------------------------------------------------------------------
  Every row is a function of the instruction the committed program holds at the
  row's program counter, not a constant of the circuit:

    * decode        the row's opcode byte, register indices and immediate are
                    bound by one linear equation to the program word the row
                    selected, so a row cannot run an instruction the committed
                    program does not contain;
    * semantics     each opcode contributes its own gated term to the result;
    * control       the next program counter is a function of the opcode, the
                    immediate and the operand, and feeds the following row, so
                    branches, loops and the halt are real control flow;
    * state         the register file and the memory are carried row to row
                    under constraints, so a value that is written is the value
                    that is read back;
    * costing       gas is the sum of the per-opcode costing over the rows.

  The program is 16 words of *public* input. A different program is a different
  statement: the registry contract binds all sixteen words before it looks at
  the proof, which is what makes "this program ran" mean something.

  ---------------------------------------------------------------------------
  WHY EVERY SIGNAL HERE IS CONSTRAINED, NOT MERELY COMPUTED
  ---------------------------------------------------------------------------
  A signal that is only computed during witness generation is not proven: a
  malicious prover writes whatever it likes into it. Every signal below is
  therefore (a) forced boolean, (b) forced equal to an expression of other
  signals, or (c) forced equal to a public input or a compile-time constant.

    clk[i]          === i
    pc_sel[i][j]    boolean, sums to one, and sum_j j*pc_sel[i][j] === pc[i],
                    so pc[i] cannot leave the program
    words[i]        === sum_j pc_sel[i][j] * program[j]
    decode          opcode[i] + 2^8*rd_idx[i] + 2^13*rs1_idx[i]
                      + 2^18*rs2_idx[i] + 2^23*imm_u32[i] === words[i]
                    with opcode pinned by a selector one-hot, the three indices
                    pinned by their own one-hots, and imm_u32 range checked to
                    32 bits. Every side of that equation is an integer below
                    2^64, so the modular equation is the integer equation and
                    the field extraction is exact.
    op_sel[i][k]    boolean, sums to one, and
                    sum_k op_sel[i][k]*OPCODE_BYTE[k] === opcode[i]
    rs1_val[i]      === sum_k rs1_sel[i][k]*regs[i][k]        (the register read)
    rs2_val[i]      === sum_k rs2_sel[i][k]*regs[i][k]
    rd_val_new[i]   === the sum of one gated term per opcode, range checked to
                    64 bits; that range check is what pins the carry and the
                    quotient below to their true values rather than to any
                    modular solution
    carry_add[i]    a bit, and
                    is_add*(rs1+rs2-2^64*carry_add-rd_val_new) === 0
    carry_sub[i]    a bit, and
                    is_sub*(rd_val_new+rs2-2^64*carry_sub-rs1) === 0
    quotient[i]     range checked to 64 bits, and
                    is_mul*(rs1*rs2-2^64*quotient-rd_val_new) === 0
    lt_bit[i]       the 65th bit of (rs1-rs2+2^64), inverted: the comparison is
                    proved by a range check rather than asserted
    zero_rs1[i]     the inverse-witness zero test, so
                    is_eq*zero_rs1 === is_eq*(1-eq_bit) holds exactly, and an
                    Assert with a zero operand is *unsatisfiable*:
                    is_assert * zero_rs1.out === 0
    next_pc[i]      === the opcode's own rule, and pc[i+1] === next_pc[i]
    regs[i+1][k]    === regs[i][k] + writes*rd_sel[i][k]*(rd_val_new-regs[i][k])
                    for k >= 1, with regs[i+1][0] === 0
    mem_sel[i][k]   boolean when the row touches memory, summing to one and
                    reconstructing mem_addr[i]
    mem_addr[i]     === rs1_val[i] + signed immediate on a memory row, and zero
                    on a row that touches no memory
    mem_val[i]      === sum_k mem_sel[i][k]*mem[i][k]        (the read)
    mem[i+1][k]     === mem[i][k] + is_store*mem_sel[i][k]*(rs2_val[i]-mem[i][k])
    is_active[i]    a bit, non-increasing, and sum_i is_active[i] === steps_executed
    is_halt[i]      === 1 - is_active[i]*is_active[i+1], and
                    is_halt[i] === op_sel[i][HALT]

  ---------------------------------------------------------------------------
  PADDING: THE ROWS BEHIND THE HALT
  ---------------------------------------------------------------------------
  The row count is fixed, so a run that halts earlier leaves rows behind it, and
  those rows are not free space. `is_active` is an equality constraint; the halt
  pattern above pins the halt to the last active row; a padding row is a Halt,
  whose semantics -- next program counter is its own, no register write, no
  memory event -- are exactly what freezes the state from the halt onwards.
  Zeroing only in the witness would not be enough: a prover could claim work it
  never proved. Both the count and the pattern are constraints, and both have
  their own negative test.

  ---------------------------------------------------------------------------
  ARITHMETIC, AND WHY IT IS 64 BITS RATHER THAN FIELD NATIVE
  ---------------------------------------------------------------------------
  Register and memory values are integers in [0, 2^64), carried in the field as
  those integers. Add and Sub wrap modulo 2^64 with a one-bit carry; Mul wraps
  with a 64-bit quotient. The wrap is the machine's arithmetic, not an artefact
  of the encoding: 2^64-1 + 1 is 0 here exactly as it is in the interpreter, and
  the negative matrix includes that case. The cost of the choice is the range
  checks -- 64 bits for the result, 64 for the multiply quotient, 65 for the
  comparison -- which is why the step budget is 16 rows and not 1024. A
  field-native machine would not need them and would then have to say what "<"
  means on values that are not ordered.

  ---------------------------------------------------------------------------
  DOMAIN SEPARATION
  ---------------------------------------------------------------------------
  This lane's tag is its own, compiled in as a constant and also passed as a
  public input, where it is constrained to equal that constant. Register files
  are committed under a second, different tag, so a register root can never be
  confused with a state root of another lane:

      execution lane : lumen-gate-execution-v1
      register roots : lumen-gate-exec-registers-v1
      chained lane   : lumen-gate-step-chain-v1    (untouched)
      single         : lumen-gate-finality-v1      (the BLS hash-to-curve DST)

  No `signal output` anywhere, deliberately: an output becomes an extra public
  input and shifts the indices the verifier contract expects.
*/

// keccak-free offline derivation: sha256(label) reduced into the BN254 scalar
// field, kept as literals so the compiler, the witness builder and the contract
// agree byte for byte.
//
//   lumen-gate-execution-v1      -> sha256, top 248 bits ->
//      366332086174773927684157067308717544951988300004818040487599723223305911732
//   lumen-gate-exec-registers-v1 -> sha256, top 248 bits ->
//      66197418195871398560001482625765192869627981700346080088648095494354305693

template ExecutionTrace(STEPS, PROGRAM_WORDS, MEMORY_WORDS, REGISTERS) {
    // ---- public ------------------------------------------------------------
    signal input program[PROGRAM_WORDS];
    signal input initial_regs_root;
    signal input final_regs_root;
    signal input final_pc;
    signal input steps_executed;
    signal input gas_used;
    signal input domain_tag;

    // ---- private: the trace, one entry per column ---------------------------
    signal input clk[STEPS];
    signal input pc[STEPS];
    signal input opcode[STEPS];
    signal input rd_idx[STEPS];
    signal input rs1_idx[STEPS];
    signal input rs2_idx[STEPS];
    signal input rs1_val[STEPS];
    signal input rs2_val[STEPS];
    signal input rd_val_new[STEPS];
    signal input next_pc[STEPS];
    signal input imm[STEPS];
    signal input mem_addr[STEPS];
    signal input mem_val[STEPS];
    signal input is_mem_write[STEPS];
    signal input regs[STEPS + 1][REGISTERS];
    signal input mem[STEPS + 1][MEMORY_WORDS];

    // ---- private: the selectors the trace carries ---------------------------
    signal input pc_sel[STEPS][PROGRAM_WORDS];
    signal input op_sel[STEPS][11];
    signal input rd_sel[STEPS][REGISTERS];
    signal input rs1_sel[STEPS][REGISTERS];
    signal input rs2_sel[STEPS][REGISTERS];
    signal input mem_sel[STEPS][MEMORY_WORDS];
    signal input imm_u32[STEPS];
    signal input is_active[STEPS];
    signal input carries_add[STEPS];
    signal input carries_sub[STEPS];
    signal input quotient_mul[STEPS];

    var DST = 366332086174773927684157067308717544951988300004818040487599723223305911732;
    var REGISTER_TAG = 66197418195871398560001482625765192869627981700346088648095494354305693;

    // Selector order, shared with `crates/execution_vm` and with the trace: the
    // *implemented* subset of the instruction set. An instruction outside it has
    // no selector, so no row can run one.
    var OPCODE_BYTE[11] = [0x00, 0x01, 0x02, 0x03, 0x0A, 0x0C, 0x10, 0x11, 0x14, 0x15, 0x18];
    var GAS[11] = [0, 1, 1, 1, 1, 1, 1, 1, 3, 3, 1];

    var HALT = 0;
    var ADD = 1;
    var SUB = 2;
    var MUL = 3;
    var EQ = 4;
    var LT = 5;
    var JMP = 6;
    var JNZ = 7;
    var LOAD = 8;
    var STORE = 9;
    var ASSERT = 10;

    // Bit positions in the packed word, the reference encoding:
    //   bits 0..8 opcode | 8..13 rd | 13..18 rs1 | 18..23 rs2 | 23..55 immediate
    var W_RD = 256;
    var W_RS1 = 8192;
    var W_RS2 = 262144;
    var W_IMM = 8388608;
    var TWO32 = 4294967296;
    var TWO64 = 18446744073709551616;

    // Everything is declared in the initial scope: circom only allows signal
    // and component declarations there. The loops below only wire them.
    signal words[STEPS];
    signal writes[STEPS];
    signal is_mem[STEPS];
    signal is_load_imm[STEPS];
    signal is_load_mem[STEPS];
    signal imm_sign[STEPS];
    signal signed_imm[STEPS];
    signal immediate_64[STEPS];
    signal not_zero_rs1[STEPS];
    signal zero_diff[STEPS];
    signal jump_target[STEPS];
    signal sequential_pc[STEPS];
    signal add_term[STEPS];
    signal sub_term[STEPS];
    signal mul_term[STEPS];
    signal eq_term[STEPS];
    signal lt_term[STEPS];
    signal load_term[STEPS];
    signal product_mul[STEPS];
    signal load_imm_term[STEPS];
    signal load_mem_term[STEPS];
    signal jnz_delta[STEPS];
    signal jnz_target[STEPS];
    signal halt_pc[STEPS];
    signal jmp_pc[STEPS];
    signal jnz_pc[STEPS];
    signal sequential_gate[STEPS];
    signal mem_sel_own[STEPS][MEMORY_WORDS];
    signal reg_write_gate[STEPS][REGISTERS];
    signal mem_write_gate[STEPS][MEMORY_WORDS];
    signal mem_hold_gate[STEPS][MEMORY_WORDS];
    signal active_pair[STEPS];
    signal halt_pattern[STEPS];
    signal word_terms[STEPS][PROGRAM_WORDS];
    signal rs1_terms[STEPS][REGISTERS];
    signal rs2_terms[STEPS][REGISTERS];
    signal mem_read_terms[STEPS][MEMORY_WORDS];

    component imm_bits[STEPS];
    component result_bits[STEPS];
    component quotient_bits[STEPS];
    component diff_bits[STEPS];
    component zero_rs1[STEPS];
    component zero_rs1_diff[STEPS];
    component entry_bits[REGISTERS];
    component initial_root;
    component final_root;
    component steps_bits;
    component steps_nonzero;
    component carried_gas;
    component tag_diff;
    component final_pc_range;

    // -- the statement's own constants ----------------------------------------
    // The domain tag is a public input and is constrained to the constant, so
    // the tag is part of what is proven rather than a comment.
    tag_diff = IsZero();
    tag_diff.in <== domain_tag - DST;
    tag_diff.out === 1;

    // -- boundary conditions on the first row ---------------------------------
    // The machine's lane entry: program counter zero, r0 zero, memory zeroed.
    pc[0] === 0;
    regs[0][0] === 0;
    for (var k = 0; k < MEMORY_WORDS; k++) {
        mem[0][k] === 0;
    }
    for (var i = 0; i < STEPS; i++) {
        clk[i] === i;
    }

    // The initial register file is range checked: every later register value is
    // either this one or a bounded result, so this is the whole range argument.
    for (var k = 0; k < REGISTERS; k++) {
        entry_bits[k] = Num2Bits(64);
        entry_bits[k].in <== regs[0][k];
    }

    // -- the register file is committed before and after ----------------------
    initial_root = Poseidon(REGISTERS + 1);
    initial_root.inputs[0] <== REGISTER_TAG;
    for (var k = 0; k < REGISTERS; k++) {
        initial_root.inputs[k + 1] <== regs[0][k];
    }
    initial_regs_root === initial_root.out;

    final_root = Poseidon(REGISTERS + 1);
    final_root.inputs[0] <== REGISTER_TAG;
    for (var k = 0; k < REGISTERS; k++) {
        final_root.inputs[k + 1] <== regs[STEPS][k];
    }
    final_regs_root === final_root.out;

    // -- lengths and costs are ranges, not conventions -------------------------
    steps_bits = Num2Bits(5);
    steps_bits.in <== steps_executed;
    steps_nonzero = IsZero();
    steps_nonzero.in <== steps_executed;
    steps_nonzero.out === 0;

    carried_gas = Num2Bits(32);
    carried_gas.in <== gas_used;

    // final_pc is public; a value outside the program cannot satisfy the last
    // row's next-pc equation anyway, and this makes that explicit.
    final_pc_range = Num2Bits(4);
    final_pc_range.in <== final_pc;

    // -- walk the rows --------------------------------------------------------
    for (var i = 0; i < STEPS; i++) {
        // 1. the row selects a program slot, and that slot is where it runs
        for (var j = 0; j < PROGRAM_WORDS; j++) {
            pc_sel[i][j] * (pc_sel[i][j] - 1) === 0;
        }
        var pc_sel_sum = 0;
        var pc_reconstruct = 0;
        for (var j = 0; j < PROGRAM_WORDS; j++) {
            pc_sel_sum += pc_sel[i][j];
            pc_reconstruct += j * pc_sel[i][j];
        }
        pc_sel_sum === 1;
        pc_reconstruct === pc[i];

        // 2. the word at that slot. One linear equation ties the row's opcode,
        //    indices and immediate to the committed word.
        // The selection is one product per slot and a linear sum, because a sum
        // of products is not an R1CS constraint: each term is its own.
        var word_sum = 0;
        for (var j = 0; j < PROGRAM_WORDS; j++) {
            word_terms[i][j] <== pc_sel[i][j] * program[j];
            word_sum += word_terms[i][j];
        }
        words[i] <== word_sum;

        // 3. the immediate's width. This is the only range check the decode
        //    needs: with the opcode pinned to a byte and the indices pinned to
        //    [0, REGISTERS), the equation above is an integer equation.
        imm_bits[i] = Num2Bits(32);
        imm_bits[i].in <== imm_u32[i];
        imm_sign[i] <== imm_bits[i].out[31];

        // 4. the opcode is exactly one of the implemented ones, and the
        //    selector one-hot says which.
        for (var k = 0; k < 11; k++) {
            op_sel[i][k] * (op_sel[i][k] - 1) === 0;
        }
        var op_sum = 0;
        var op_byte = 0;
        for (var k = 0; k < 11; k++) {
            op_sum += op_sel[i][k];
            op_byte += OPCODE_BYTE[k] * op_sel[i][k];
        }
        op_sum === 1;
        op_byte === opcode[i];

        // 5. the register indices are inside the register file
        for (var k = 0; k < REGISTERS; k++) {
            rd_sel[i][k] * (rd_sel[i][k] - 1) === 0;
            rs1_sel[i][k] * (rs1_sel[i][k] - 1) === 0;
            rs2_sel[i][k] * (rs2_sel[i][k] - 1) === 0;
        }
        var rd_sum = 0;
        var rd_reconstruct = 0;
        var rs1_sum = 0;
        var rs1_reconstruct = 0;
        var rs2_sum = 0;
        var rs2_reconstruct = 0;
        for (var k = 0; k < REGISTERS; k++) {
            rd_sum += rd_sel[i][k];
            rd_reconstruct += k * rd_sel[i][k];
            rs1_sum += rs1_sel[i][k];
            rs1_reconstruct += k * rs1_sel[i][k];
            rs2_sum += rs2_sel[i][k];
            rs2_reconstruct += k * rs2_sel[i][k];
        }
        rd_sum === 1;
        rs1_sum === 1;
        rs2_sum === 1;
        rd_reconstruct === rd_idx[i];
        rs1_reconstruct === rs1_idx[i];
        rs2_reconstruct === rs2_idx[i];

        // the decode itself
        opcode[i] + W_RD * rd_idx[i] + W_RS1 * rs1_idx[i] + W_RS2 * rs2_idx[i]
            + W_IMM * imm_u32[i] === words[i];

        // 6. the operand reads
        var rs1_read = 0;
        var rs2_read = 0;
        for (var k = 0; k < REGISTERS; k++) {
            rs1_terms[i][k] <== rs1_sel[i][k] * regs[i][k];
            rs2_terms[i][k] <== rs2_sel[i][k] * regs[i][k];
            rs1_read += rs1_terms[i][k];
            rs2_read += rs2_terms[i][k];
        }
        rs1_read === rs1_val[i];
        rs2_read === rs2_val[i];

        // 7. the semantics: one gated term per opcode, summed into the result
        zero_rs1[i] = IsZero();
        zero_rs1[i].in <== rs1_val[i];
        not_zero_rs1[i] <== 1 - zero_rs1[i].out;

        result_bits[i] = Num2Bits(64);
        result_bits[i].in <== rd_val_new[i];

        carries_add[i] * (carries_add[i] - 1) === 0;
        carries_sub[i] * (carries_sub[i] - 1) === 0;

        add_term[i] <== op_sel[i][ADD] * (rs1_val[i] + rs2_val[i] - TWO64 * carries_add[i]);
        sub_term[i] <== op_sel[i][SUB] * (rs1_val[i] - rs2_val[i] + TWO64 * carries_sub[i]);

        quotient_bits[i] = Num2Bits(64);
        quotient_bits[i].in <== quotient_mul[i];
        // the product is its own constraint: a triple product is not R1CS
        product_mul[i] <== rs1_val[i] * rs2_val[i];
        mul_term[i] <== op_sel[i][MUL] * (product_mul[i] - TWO64 * quotient_mul[i]);

        // Eq is one exactly when the difference is zero, and the zero test is
        // the inverse-witness one rather than a comparison
        zero_rs1_diff[i] = IsZero();
        zero_rs1_diff[i].in <== rs1_val[i] - rs2_val[i];
        zero_diff[i] <== zero_rs1_diff[i].out;
        eq_term[i] <== op_sel[i][EQ] * zero_diff[i];

        diff_bits[i] = Num2Bits(65);
        diff_bits[i].in <== rs1_val[i] - rs2_val[i] + TWO64;
        lt_term[i] <== op_sel[i][LT] * (1 - diff_bits[i].out[64]);

        signed_imm[i] <== imm_u32[i] - TWO32 * imm_sign[i];
        immediate_64[i] <== imm_u32[i] + imm_sign[i] * (TWO64 - TWO32);
        is_load_imm[i] <== op_sel[i][LOAD] * rs1_sel[i][0];
        is_load_mem[i] <== op_sel[i][LOAD] - is_load_imm[i];
        load_imm_term[i] <== is_load_imm[i] * immediate_64[i];
        load_mem_term[i] <== is_load_mem[i] * mem_val[i];
        load_term[i] <== load_imm_term[i] + load_mem_term[i];

        rd_val_new[i] === add_term[i] + sub_term[i] + mul_term[i] + eq_term[i]
            + lt_term[i] + load_term[i];

        // the trace carries the signed immediate as its own column, and it must
        // be the one the decode produced
        imm[i] === signed_imm[i];

        // an assertion on a zero operand is not provable: the machine refused,
        // and a refusal is not a run
        op_sel[i][ASSERT] * zero_rs1[i].out === 0;

        // 8. the memory event
        is_mem[i] <== is_load_mem[i] + op_sel[i][STORE];
        is_mem_write[i] === op_sel[i][STORE];
        for (var k = 0; k < MEMORY_WORDS; k++) {
            mem_sel_own[i][k] <== mem_sel[i][k] * (mem_sel[i][k] - 1);
            mem_sel_own[i][k] * is_mem[i] === 0;
        }
        var mem_sel_sum = 0;
        var mem_reconstruct = 0;
        for (var k = 0; k < MEMORY_WORDS; k++) {
            mem_sel_sum += mem_sel[i][k];
            mem_reconstruct += k * mem_sel[i][k];
        }
        is_mem[i] * (mem_sel_sum - 1) === 0;
        mem_addr[i] === mem_reconstruct;
        (1 - is_mem[i]) * mem_addr[i] === 0;
        // the address is the machine's own: rs1 + immediate
        is_mem[i] * (mem_addr[i] - rs1_val[i] - signed_imm[i]) === 0;

        var mem_read = 0;
        for (var k = 0; k < MEMORY_WORDS; k++) {
            mem_read_terms[i][k] <== mem_sel[i][k] * mem[i][k];
            mem_read += mem_read_terms[i][k];
        }
        // A read returns the word the state carried into this row; a row that
        // touches no memory contributes nothing. Both are gated, because on a
        // store the value the row names is the value *written*, not the value
        // that was there.
        is_load_mem[i] * (mem_read - mem_val[i]) === 0;
        (1 - is_mem[i]) * mem_val[i] === 0;

        // a store writes the second operand
        op_sel[i][STORE] * (mem_val[i] - rs2_val[i]) === 0;

        // 9. the next program counter
        jump_target[i] <== pc[i] + signed_imm[i];
        sequential_pc[i] <== pc[i] + 1;
        // Each opcode contributes one gated term; a sum of products is not an
        // R1CS constraint, so every term is its own signal.
        jnz_delta[i] <== not_zero_rs1[i] * (jump_target[i] - sequential_pc[i]);
        jnz_target[i] <== jnz_delta[i] + sequential_pc[i];
        halt_pc[i] <== op_sel[i][HALT] * pc[i];
        jmp_pc[i] <== op_sel[i][JMP] * jump_target[i];
        jnz_pc[i] <== op_sel[i][JNZ] * jnz_target[i];
        sequential_gate[i] <== 1 - op_sel[i][HALT] - op_sel[i][JMP] - op_sel[i][JNZ];
        next_pc[i] === halt_pc[i] + jmp_pc[i] + jnz_pc[i]
            + sequential_gate[i] * sequential_pc[i];

        // 10. the register file after the row
        writes[i] <== op_sel[i][ADD] + op_sel[i][SUB] + op_sel[i][MUL]
            + op_sel[i][EQ] + op_sel[i][LT] + op_sel[i][LOAD];
        for (var k = 0; k < REGISTERS; k++) {
            reg_write_gate[i][k] <== writes[i] * rd_sel[i][k];
        }
        regs[i + 1][0] === 0;
        for (var k = 1; k < REGISTERS; k++) {
            regs[i + 1][k] === regs[i][k]
                + reg_write_gate[i][k] * (rd_val_new[i] - regs[i][k]);
        }

        // 11. the memory after the row: unchanged unless this row is a store
        for (var k = 0; k < MEMORY_WORDS; k++) {
            mem_write_gate[i][k] <== op_sel[i][STORE] * mem_sel[i][k];
            mem_hold_gate[i][k] <== mem_write_gate[i][k] * (rs2_val[i] - mem[i][k]);
        }
        for (var k = 0; k < MEMORY_WORDS; k++) {
            mem[i + 1][k] === mem[i][k] + mem_hold_gate[i][k];
        }

        // 12. the program counter chain
        if (i + 1 < STEPS) {
            pc[i + 1] === next_pc[i];
        } else {
            final_pc === next_pc[i];
        }
    }

    // -- the count of real rows, and where the halt is ------------------------
    var active_count = 0;
    for (var i = 0; i < STEPS; i++) {
        is_active[i] * (is_active[i] - 1) === 0;
        active_count += is_active[i];
    }
    active_count === steps_executed;

    // active rows come first: once a row is padding, every later row is padding
    for (var i = 0; i + 1 < STEPS; i++) {
        (1 - is_active[i]) * is_active[i + 1] === 0;
        active_pair[i] <== is_active[i] * is_active[i + 1];
    }
    active_pair[STEPS - 1] <== 0;

    // Row i is a halt unless it is an active row followed by another active row.
    // One sentence, and it pins the halt to the last active row, makes every
    // padding row a halt, and makes the last row of the trace a halt.
    for (var i = 0; i < STEPS; i++) {
        halt_pattern[i] <== 1 - active_pair[i];
        halt_pattern[i] === op_sel[i][HALT];
    }

    // -- the run's costing is the sum of the per-opcode costing ---------------
    var gas_sum = 0;
    for (var i = 0; i < STEPS; i++) {
        for (var k = 0; k < 11; k++) {
            gas_sum += GAS[k] * op_sel[i][k];
        }
    }
    gas_sum === gas_used;
}

// The parameters, in one place, because four files agree on them:
//
//   STEPS          20 rows, the step budget of one proof
//   PROGRAM_WORDS  16 instructions, unused slots zeroed (which is Halt)
//   MEMORY_WORDS   16 words, the address space the proof carries
//   REGISTERS      8 registers, r0 pinned to zero
//
// Public input order is fixed by the verifier contract:
//
//   public_inputs[0..15]  program[0..15]
//   public_inputs[16]     initial_regs_root
//   public_inputs[17]     final_regs_root
//   public_inputs[18]     final_pc
//   public_inputs[19]     steps_executed
//   public_inputs[20]     gas_used
//   public_inputs[21]     domain_tag
component main {public [program, initial_regs_root, final_regs_root, final_pc, steps_executed, gas_used, domain_tag]} = ExecutionTrace(20, 16, 16, 8);
