//! The lane statement: exactly what `circuits/execution_trace.circom` proves,
//! expressed here so that a trace can be checked before a proof is attempted.
//!
//! The circuit and this module must agree on five things, and each one is a
//! place where an honest-looking trace could otherwise be refused by the
//! circuit (a wasted proof) or, worse, accepted by the circuit and not by the
//! machine:
//!
//! | | the lane |
//! |---|---|
//! | entry | program counter `0`, `r0` zero, memory all zero |
//! | capacity | exactly [`LANE_STEPS`] rows, padding included |
//! | padding | rows behind the halt repeat the halt, which freezes the state |
//! | halt | the last active row executes the halt, so the run stops there |
//! | decode | every row runs the instruction the committed program holds at its pc |
//!
//! [`lane_witness`] is the third piece: it turns a checked trace into the
//! witness the circuit takes, including the selectors, carries and quotients the
//! circuit treats as witness data. Computing them here rather than in the
//! circuit is what keeps the circuit about the *relation* instead of about
//! bookkeeping.

use crate::isa::{decode, Opcode};
use crate::trace::{Trace, MEMORY_WORDS, REGISTERS};
use serde::{Deserialize, Serialize};

/// The lane's demonstration program, as a listing.
///
/// It is a policy program of the shape the settlement anchor needs: an amount
/// is split into equal installments, a split that does not divide exactly is
/// *refused* (the assertion), and the total paid out is left in memory word 0
/// where the trace commits it.
///
/// ```text
///   pc  0  load  r1, 8        the locked amount
///   pc  1  load  r2, 4        one installment
///   pc  2  load  r3, 0        zero, and the address the total lands at
///   pc  3  sub   r1, r1, r2   loop: take one installment out
///   pc  4  add   r4, r4, r2   and add it to the total
///   pc  5  jnz   r1, loop     until the amount is exactly zero
///   pc  6  store [r3], r4     the total paid out, into memory word 0
///   pc  7  load  r6, [r3]     read it back
///   pc  8  eq    r7, r6, r4   the read-back must be the total
///   pc  9  eq    r5, r1, r3   and the split must have left no remainder
///   pc 10  mul   r7, r7, r5   both, not either
///   pc 11  assert r7          a run whose total does not match is refused
///   pc 12  halt
/// ```
///
/// Sixteen rows of the twenty, so the live proof exercises the padding path as
/// well as the halt, and the loop's back edge is taken rather than merely
/// available.
pub const DEMO_PROGRAM_SOURCE: &str = r"
    load  r1, 8
    load  r2, 4
    load  r3, 0
loop:
    sub   r1, r1, r2
    add   r4, r4, r2
    jnz   r1, loop
    store [r3], r4
    load  r6, [r3]
    eq    r7, r6, r4
    eq    r5, r1, r3
    mul   r7, r7, r5
    assert r7
    halt
";

/// A second listing, used by the test matrix: it exercises the opcodes and the
/// control flow the demonstration program leaves out -- the unsigned
/// comparison, the multiply, an unconditional jump, and a conditional jump that
/// is taken rather than fallen through -- in nine rows rather than sixteen, so
/// the padding is exercised at a depth the other program does not reach.
pub const FIXTURE_PROGRAM_SOURCE: &str = r"
    load  r1, 3
    load  r2, 5
    lt    r3, r1, r2
    mul   r4, r1, r2
    jnz   r3, ahead
    halt
ahead:
    assert r4
    eq    r5, r4, r4
    jmp   end
    halt
end:
    halt
";

/// Rows in one proof. Also the machine's step budget: a run that needs more
/// steps than this cannot be proved in one proof.
pub const LANE_STEPS: usize = 20;

/// Program slots. Unused slots are zero, which decodes to `Halt`.
pub const LANE_PROGRAM_WORDS: usize = 16;

/// The largest packed program word the circuit can decode.
///
/// The decode equation is
/// `word = opcode + 2^8*rd + 2^13*rs1 + 2^18*rs2 + 2^23*imm_u32` with the
/// opcode a byte, the three indices in `[0, 8)` and the immediate 32 bits wide.
/// The largest such word is `2^55 - 1`, so a program word at or above `2^55`
/// has no decode and the statement is unprovable. The registry contract refuses
/// those words itself rather than let a caller pay for a proof that cannot
/// exist -- this bound is that check, in one place.
pub const MAX_PROGRAM_WORD: u64 = (1u64 << 55) - 1;

/// The domain separation tag of this lane, as the circuit compiles it in.
pub const LANE_DOMAIN_TAG: &str =
    "366332086174773927684157067308717544951988300004818040487599723223305911732";

/// The tag the register roots are committed under, as the circuit compiles it.
pub const REGISTER_ROOT_TAG: &str =
    "66197418195871398560001482625765192869627981700346088648095494354305693";

/// What the lane's proof says, in the form the witness builder and the registry
/// contract both use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneStatement {
    /// The committed program, exactly [`LANE_PROGRAM_WORDS`] words, unused
    /// slots zero.
    pub program: Vec<u64>,
    /// How many rows the run really used, up to and including its halt.
    pub steps_executed: u64,
    /// Gas, summed over the rows at the machine's per-opcode costing.
    pub gas_used: u64,
    /// The program counter the halt leaves behind.
    pub final_pc: u64,
}

/// A trace that is not the lane's statement. Every variant names what is wrong,
/// because "the circuit refused it" is not a useful thing to learn after a
/// proof has been attempted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneError(pub String);

impl std::fmt::Display for LaneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LaneError {}

fn refuse(detail: impl Into<String>) -> LaneError {
    LaneError(detail.into())
}

/// Pads a finished run to the lane's row count.
///
/// The padding rows repeat the halt: same program counter, no register write, no
/// memory event. That is what makes them provably frozen -- the halt's own
/// semantics say the next program counter is its own and that nothing is
/// written -- and it is why the circuit can pin the halt pattern with a single
/// constraint per row.
pub fn pad_to(trace: &Trace, steps: usize) -> Result<Trace, LaneError> {
    if trace.steps.is_empty() {
        return Err(refuse("a run with no steps has nothing to pad"));
    }
    if trace.steps.len() > steps {
        return Err(refuse(format!(
            "the run took {} steps, the lane proves at most {steps}",
            trace.steps.len()
        )));
    }
    let last = trace.steps.last().expect("checked non-empty");
    if Opcode::from_byte(last.opcode) != Ok(Opcode::Halt) {
        return Err(refuse(
            "the run did not end by executing a halt, so there is nothing to pad behind",
        ));
    }

    let mut padded = trace.clone();
    while padded.steps.len() < steps {
        let mut row = last.clone();
        row.clk = padded.steps.len() as u64;
        padded.steps.push(row);
    }
    Ok(padded)
}

/// Checks a trace against the lane's statement, on top of [`crate::check_trace`].
///
/// The per-row constraints are the crate's; this adds the five lane conditions
/// from the module comment, in the order a reader would ask about them.
pub fn check_lane_trace(trace: &Trace, statement: &LaneStatement) -> Result<(), LaneError> {
    // the committed program
    if statement.program.len() != LANE_PROGRAM_WORDS {
        return Err(refuse(format!(
            "the statement commits {} program words, the lane has {LANE_PROGRAM_WORDS} slots",
            statement.program.len()
        )));
    }
    for (index, word) in statement.program.iter().enumerate() {
        if *word > MAX_PROGRAM_WORD {
            return Err(refuse(format!(
                "program word {index} is {word:#x}, above the decodable maximum {MAX_PROGRAM_WORD:#x}"
            )));
        }
    }
    if trace.program != statement.program {
        return Err(refuse(
            "the trace's program is not the program the statement commits",
        ));
    }

    // the entry
    if trace.initial_pc != 0 {
        return Err(refuse("the lane's entry program counter is zero"));
    }
    if trace.initial_regs[0] != 0 {
        return Err(refuse("the lane's entry register file has r0 zero"));
    }
    if trace.initial_memory.iter().any(|word| *word != 0) {
        return Err(refuse(
            "the lane's entry memory is zeroed: the proof carries the state the program writes, not a preloaded image",
        ));
    }

    // the capacity
    if trace.steps.len() != LANE_STEPS {
        return Err(refuse(format!(
            "the lane's trace has {} rows, the circuit has {LANE_STEPS}",
            trace.steps.len()
        )));
    }

    // every row, one by one
    crate::constraints::check_trace(trace).map_err(|violation| refuse(violation.to_string()))?;

    // the halt pattern: the last active row halts, and everything behind it is
    // padding that repeats that halt
    if statement.steps_executed == 0 || statement.steps_executed > LANE_STEPS as u64 {
        return Err(refuse(format!(
            "steps_executed is {}, which is not in [1, {LANE_STEPS}]",
            statement.steps_executed
        )));
    }
    let halt_row = statement.steps_executed as usize - 1;
    for row in 0..LANE_STEPS {
        let decoded = decode(trace.program[trace.steps[row].pc as usize])
            .map_err(|error| refuse(format!("row {row} does not decode: {error}")))?;
        let is_halt = decoded.opcode == Opcode::Halt;
        let expected = row == halt_row || row > halt_row;
        if is_halt != expected {
            return Err(refuse(format!(
                "row {row} halts = {is_halt}, but with steps_executed = {} the halt belongs at row {halt_row} and behind it",
                statement.steps_executed
            )));
        }
    }

    // the frozen state behind the halt
    let halt = &trace.steps[halt_row];
    for row in halt_row..LANE_STEPS {
        let step = &trace.steps[row];
        if step.pc != halt.pc || step.regs != halt.regs || step.next_pc != halt.next_pc {
            return Err(refuse(format!(
                "row {row} changes state behind the halt at row {halt_row}"
            )));
        }
    }

    // the published end of the run
    if trace.final_pc != statement.final_pc {
        return Err(refuse(format!(
            "the run ends at pc {} but the statement publishes {}",
            trace.final_pc, statement.final_pc
        )));
    }
    if trace.gas_used != statement.gas_used {
        return Err(refuse(format!(
            "the run charges {} gas but the statement publishes {}",
            trace.gas_used, statement.gas_used
        )));
    }

    Ok(())
}

/// The circuit's witness, ready to be merged with the two Poseidon roots and
/// written as the input file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionWitness {
    pub program: Vec<String>,
    pub clk: Vec<String>,
    pub pc: Vec<String>,
    pub opcode: Vec<String>,
    pub rd_idx: Vec<String>,
    pub rs1_idx: Vec<String>,
    pub rs2_idx: Vec<String>,
    pub rs1_val: Vec<String>,
    pub rs2_val: Vec<String>,
    pub rd_val_new: Vec<String>,
    pub next_pc: Vec<String>,
    pub imm: Vec<String>,
    pub mem_addr: Vec<String>,
    pub mem_val: Vec<String>,
    pub is_mem_write: Vec<String>,
    pub regs: Vec<Vec<String>>,
    pub mem: Vec<Vec<String>>,
    pub pc_sel: Vec<Vec<String>>,
    pub op_sel: Vec<Vec<String>>,
    pub rd_sel: Vec<Vec<String>>,
    pub rs1_sel: Vec<Vec<String>>,
    pub rs2_sel: Vec<Vec<String>>,
    pub mem_sel: Vec<Vec<String>>,
    pub imm_u32: Vec<String>,
    pub is_active: Vec<String>,
    pub carries_add: Vec<String>,
    pub carries_sub: Vec<String>,
    pub quotient_mul: Vec<String>,
    /// The register file before the first row and after the last, for the two
    /// Poseidon roots the witness builder computes.
    pub initial_regs: Vec<String>,
    pub final_regs: Vec<String>,
    pub final_pc: String,
    pub steps_executed: String,
    pub gas_used: String,
}

/// The opcode selector order the circuit uses. Kept in one array here and in one
/// array there, and a test asserts the two lists have the same length and bytes.
pub const SELECTOR_OPCODES: [Opcode; 11] = [
    Opcode::Halt,
    Opcode::Add,
    Opcode::Sub,
    Opcode::Mul,
    Opcode::Eq,
    Opcode::Lt,
    Opcode::Jmp,
    Opcode::Jnz,
    Opcode::Load,
    Opcode::Store,
    Opcode::Assert,
];

fn one_hot(index: usize, width: usize) -> Vec<String> {
    (0..width)
        .map(|slot| if slot == index { "1" } else { "0" }.to_string())
        .collect()
}

/// Turns a checked lane trace into the circuit's witness.
///
/// The helpers are computed here, from the trace, because the circuit treats
/// them as witness data: carries, the multiply quotient, the selector one-hots
/// and the memory one-hot. If this function and the circuit disagree about any
/// of them the honest witness stops satisfying a constraint, which is the point
/// of the shared negative test matrix.
pub fn lane_witness(
    trace: &Trace,
    statement: &LaneStatement,
) -> Result<ExecutionWitness, LaneError> {
    check_lane_trace(trace, statement)?;

    let steps = trace.steps.len();
    let mut witness = ExecutionWitness {
        program: statement.program.iter().map(u64::to_string).collect(),
        clk: Vec::with_capacity(steps),
        pc: Vec::with_capacity(steps),
        opcode: Vec::with_capacity(steps),
        rd_idx: Vec::with_capacity(steps),
        rs1_idx: Vec::with_capacity(steps),
        rs2_idx: Vec::with_capacity(steps),
        rs1_val: Vec::with_capacity(steps),
        rs2_val: Vec::with_capacity(steps),
        rd_val_new: Vec::with_capacity(steps),
        next_pc: Vec::with_capacity(steps),
        imm: Vec::with_capacity(steps),
        mem_addr: Vec::with_capacity(steps),
        mem_val: Vec::with_capacity(steps),
        is_mem_write: Vec::with_capacity(steps),
        regs: Vec::with_capacity(steps + 1),
        mem: Vec::with_capacity(steps + 1),
        pc_sel: Vec::with_capacity(steps),
        op_sel: Vec::with_capacity(steps),
        rd_sel: Vec::with_capacity(steps),
        rs1_sel: Vec::with_capacity(steps),
        rs2_sel: Vec::with_capacity(steps),
        mem_sel: Vec::with_capacity(steps),
        imm_u32: Vec::with_capacity(steps),
        is_active: Vec::with_capacity(steps),
        carries_add: Vec::with_capacity(steps),
        carries_sub: Vec::with_capacity(steps),
        quotient_mul: Vec::with_capacity(steps),
        initial_regs: trace.initial_regs.iter().map(u64::to_string).collect(),
        final_regs: trace.final_regs.iter().map(u64::to_string).collect(),
        final_pc: statement.final_pc.to_string(),
        steps_executed: statement.steps_executed.to_string(),
        gas_used: statement.gas_used.to_string(),
    };

    // The state before the first row, and the memory image the proof carries.
    witness
        .regs
        .push(trace.initial_regs.iter().map(u64::to_string).collect());
    witness
        .mem
        .push(trace.initial_memory.iter().map(u64::to_string).collect());

    let mut memory = trace.initial_memory.clone();
    let mut gas = 0u64;

    for (row, step) in trace.steps.iter().enumerate() {
        let decoded = decode(trace.program[step.pc as usize])
            .map_err(|error| refuse(format!("row {row} does not decode: {error}")))?;
        let opcode = Opcode::from_byte(step.opcode)
            .map_err(|error| refuse(format!("row {row} carries an unknown opcode: {error}")))?;

        witness.clk.push(step.clk.to_string());
        witness.pc.push(step.pc.to_string());
        witness.opcode.push(step.opcode.to_string());
        witness.rd_idx.push(step.rd_idx.to_string());
        witness.rs1_idx.push(step.rs1_idx.to_string());
        witness.rs2_idx.push(step.rs2_idx.to_string());
        witness.rs1_val.push(step.rs1_val.to_string());
        witness.rs2_val.push(step.rs2_val.to_string());
        witness.rd_val_new.push(step.rd_val_new.to_string());
        witness.next_pc.push(step.next_pc.to_string());
        witness.imm.push(step.imm.to_string());
        witness.mem_addr.push(step.addr_or_zero().to_string());
        witness.mem_val.push(step.val_or_zero().to_string());
        witness
            .is_mem_write
            .push(u64::from(step.is_mem_write).to_string());
        witness.imm_u32.push((decoded.imm as u32).to_string());
        witness
            .is_active
            .push(u64::from((row as u64) < statement.steps_executed).to_string());

        // the selectors
        let selector_index = SELECTOR_OPCODES
            .iter()
            .position(|candidate| *candidate == opcode)
            .ok_or_else(|| {
                refuse(format!(
                    "row {row} runs an opcode outside the selector table"
                ))
            })?;
        witness
            .op_sel
            .push(one_hot(selector_index, SELECTOR_OPCODES.len()));
        witness
            .pc_sel
            .push(one_hot(step.pc as usize, LANE_PROGRAM_WORDS));
        witness
            .rd_sel
            .push(one_hot(step.rd_idx as usize, REGISTERS));
        witness
            .rs1_sel
            .push(one_hot(step.rs1_idx as usize, REGISTERS));
        witness
            .rs2_sel
            .push(one_hot(step.rs2_idx as usize, REGISTERS));
        witness.mem_sel.push(one_hot(
            step.addr_or_zero() as usize % MEMORY_WORDS,
            MEMORY_WORDS,
        ));

        // the carries, the multiply quotient and the costing
        let carry_add = u64::from(step.rs1_val as u128 + step.rs2_val as u128 >= 1u128 << 64);
        let carry_sub = u64::from(step.rs1_val < step.rs2_val);
        let quotient = ((step.rs1_val as u128 * step.rs2_val as u128) >> 64) as u64;
        witness.carries_add.push(carry_add.to_string());
        witness.carries_sub.push(carry_sub.to_string());
        witness.quotient_mul.push(if opcode == Opcode::Mul {
            quotient.to_string()
        } else {
            "0".to_string()
        });

        gas += opcode.gas();

        // the state after the row
        if opcode == Opcode::Store {
            let address = step.addr_or_zero() as usize;
            if address >= MEMORY_WORDS {
                return Err(refuse(format!(
                    "row {row} stores to word {address}, outside the lane's address space"
                )));
            }
            memory[address] = step.rs2_val;
        }
        witness
            .regs
            .push(step.regs.iter().map(u64::to_string).collect());
        witness
            .mem
            .push(memory.iter().map(u64::to_string).collect());
    }

    if gas != statement.gas_used {
        return Err(refuse(format!(
            "the rows charge {gas} gas, the statement publishes {}",
            statement.gas_used
        )));
    }
    if trace.gas_used != gas {
        return Err(refuse(format!(
            "the trace records {} gas but its rows charge {gas}",
            trace.gas_used
        )));
    }

    Ok(witness)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm::assemble;
    use crate::vm::Vm;

    fn lane_program() -> Vec<u64> {
        let mut words = assemble(DEMO_PROGRAM_SOURCE).expect("the demonstration program assembles");
        words.resize(LANE_PROGRAM_WORDS, 0);
        words
    }

    fn run_lane() -> (Trace, LaneStatement) {
        let program = lane_program();
        let mut vm = Vm::new();
        vm.run(&program, LANE_STEPS).expect("the run halts");
        let raw = vm.trace(&program);
        let steps_executed = raw.steps_executed();
        let trace = pad_to(&raw, LANE_STEPS).expect("the run pads");
        let statement = LaneStatement {
            program,
            steps_executed,
            gas_used: trace.gas_used,
            final_pc: trace.final_pc,
        };
        (trace, statement)
    }

    #[test]
    fn the_demonstration_program_halts_and_its_result_is_in_memory() {
        let (trace, statement) = run_lane();
        // three prologue rows, two loop iterations of three rows, seven tail rows
        assert_eq!(statement.steps_executed, 16);
        assert_eq!(trace.steps.len(), LANE_STEPS, "padded to the row count");
        assert_eq!(trace.final_pc, 12, "the halt sits at pc 12");
        assert_eq!(check_lane_trace(&trace, &statement), Ok(()));

        // and the result the program computed is in memory word 0
        let witness = lane_witness(&trace, &statement).unwrap();
        assert_eq!(witness.mem[LANE_STEPS][0], "8", "the split paid out 8");
        assert_eq!(witness.mem[LANE_STEPS][1], "0", "and touched nothing else");
    }

    #[test]
    fn the_padding_repeats_the_halt_and_so_freezes_the_state() {
        let (trace, _) = run_lane();
        let halt_row = trace.steps[15].clone();
        for row in 16..LANE_STEPS {
            assert_eq!(trace.steps[row].opcode, halt_row.opcode);
            assert_eq!(trace.steps[row].pc, halt_row.pc);
            assert_eq!(trace.steps[row].regs, halt_row.regs);
            assert_eq!(trace.steps[row].next_pc, halt_row.next_pc);
        }
    }

    #[test]
    fn a_trace_that_is_not_the_committed_program_is_refused() {
        let (trace, statement) = run_lane();
        let mut other = statement.clone();
        other.program[0] = 1;
        assert!(check_lane_trace(&trace, &other).is_err());
    }

    #[test]
    fn a_program_word_above_the_decodable_maximum_is_refused_before_the_proof() {
        let (trace, statement) = run_lane();
        let mut other = statement.clone();
        other.program[15] = MAX_PROGRAM_WORD + 1;
        let error = check_lane_trace(&trace, &other).unwrap_err();
        assert!(error.0.contains("decodable maximum"), "{error}");
    }

    #[test]
    fn a_witness_is_produced_and_its_shapes_are_the_circuits() {
        let (trace, statement) = run_lane();
        let witness = lane_witness(&trace, &statement).expect("the honest trace builds a witness");
        assert_eq!(witness.clk.len(), LANE_STEPS);
        assert_eq!(witness.op_sel[0].len(), SELECTOR_OPCODES.len());
        assert_eq!(witness.pc_sel[0].len(), LANE_PROGRAM_WORDS);
        assert_eq!(witness.mem_sel[0].len(), MEMORY_WORDS);
        assert_eq!(witness.regs.len(), LANE_STEPS + 1);
        assert_eq!(witness.mem.len(), LANE_STEPS + 1);
        assert_eq!(witness.initial_regs.len(), REGISTERS);
        // one slot set per selector, per row
        for row in &witness.op_sel {
            assert_eq!(row.iter().filter(|slot| *slot == "1").count(), 1);
        }
        for row in &witness.pc_sel {
            assert_eq!(row.iter().filter(|slot| *slot == "1").count(), 1);
        }
    }

    #[test]
    fn a_result_that_does_not_follow_from_the_operands_is_refused() {
        let (trace, statement) = run_lane();
        let mut broken = trace.clone();
        // row 3 is `sub r1, r1, r2`; claim it produced one more than it did
        let row = 3;
        broken.steps[row].rd_val_new += 1;
        let error = check_lane_trace(&broken, &statement).unwrap_err();
        assert!(error.0.contains("result_value"), "{error}");
    }

    #[test]
    fn a_run_longer_than_the_step_budget_is_refused_rather_than_truncated() {
        let mut program = assemble(
            r"
        spin:
            jmp spin
            ",
        )
        .unwrap();
        program.resize(LANE_PROGRAM_WORDS, 0);
        let mut vm = Vm::new();
        assert_eq!(
            vm.run(&program, LANE_STEPS),
            Err(crate::vm::VmError::StepLimitExceeded)
        );
        let trace = pad_to(&vm.trace(&program), LANE_STEPS).unwrap_err();
        assert!(
            trace.0.contains("did not end by executing a halt"),
            "{trace}"
        );
    }
}
