//! The trace checker: the Rust twin of `circuits/execution_trace.circom`.
//!
//! Two implementations of one relation is the point. A constraint that exists
//! only in the circuit cannot be tested without a trusted setup, and a
//! constraint that exists only here proves nothing. So the same sentences are
//! written twice --
//!
//! * here, where a violation is a [`TraceViolation`] with a kind, a row index
//!   and a sentence a reader can act on;
//! * in the circuit, where the same statements are field constraints, and a
//!   violation makes the witness unsatisfiable.
//!
//! -- and the tests in this crate and the negative matrix in `lane_tests`
//! drive both from the same programs.
//!
//! # What is checked
//!
//! Every row is checked against the committed program and against the row
//! before it:
//!
//! 1. the clock counts from zero and the program counter stays inside the
//!    program;
//! 2. the register indices are inside the register file, and the two operand
//!    values are exactly the register file bytes that preceded the instruction;
//! 3. the opcode is one this machine implements, and it is the opcode the
//!    committed program word at that program counter decodes to;
//! 4. the result value is the one the opcode's semantics produce, with the
//!    width the semantics have (`Eq` and `Lt` produce a bit; the arithmetic
//!    wraps modulo 2^64);
//! 5. a memory row addresses inside the address space at `rs1_val + imm`, a
//!    read returns the word the memory state held *before* the instruction, a
//!    write stores the second operand, and a row that is not a memory row
//!    contributes zeros;
//! 6. the next program counter is the one the opcode implies, including the
//!    taken and not-taken forms of the conditional jump;
//! 7. the register file after the instruction differs from the register file
//!    before it in exactly one place -- the destination, when the opcode has
//!    one -- and `r0` is zero on every row;
//! 8. the first row starts where the caller said the machine started, and the
//!    last row is a `Halt` whose next program counter is its own, whose
//!    register file is the trace's final register file, and whose run is
//!    marked halted.
//!
//! The register and memory consistency conditions (2 and 5) are the reason a
//! memory log is not enough. A log says "a read of address a returned v"; it
//! does not say that the value was still there. Carrying the state forward and
//! constraining each read against the carried state says it.

use crate::isa::{decode, Opcode};
use crate::trace::{Trace, MEMORY_WORDS, REGISTERS};
use serde::{Deserialize, Serialize};

/// A refused trace: what was wrong, where, and in one sentence why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceViolation {
    /// Stable machine-readable kind, so a test can assert which constraint bit.
    pub kind: &'static str,
    /// Row the violation is on. For boundary conditions this is `0` or the
    /// last row, whichever the sentence names.
    pub row: usize,
    pub detail: String,
}

impl std::fmt::Display for TraceViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "row {}: {} ({})", self.row, self.detail, self.kind)
    }
}

impl std::error::Error for TraceViolation {}

fn violation(kind: &'static str, row: usize, detail: impl Into<String>) -> TraceViolation {
    TraceViolation {
        kind,
        row,
        detail: detail.into(),
    }
}

/// Does this opcode have a destination register?
fn writes_register(opcode: Opcode) -> bool {
    matches!(
        opcode,
        Opcode::Add | Opcode::Sub | Opcode::Mul | Opcode::Eq | Opcode::Lt | Opcode::Load
    )
}

/// Checks a trace against the committed program. `Ok(())` means every row
/// satisfies every constraint; `Err` names the first row and the first
/// constraint it breaks, in row order.
pub fn check_trace(trace: &Trace) -> Result<(), TraceViolation> {
    // Boundary, first row: an empty trace proves nothing, and a machine that
    // claims to have executed zero instructions and halted is a refusal.
    if trace.steps.is_empty() {
        return Err(violation(
            "empty_trace",
            0,
            "a trace with no rows has no execution to prove",
        ));
    }

    let mut memory = trace.initial_memory.clone();
    if memory.len() != MEMORY_WORDS {
        return Err(violation(
            "memory_shape",
            0,
            format!(
                "the initial memory has {} words, the address space has {MEMORY_WORDS}",
                memory.len()
            ),
        ));
    }

    // Boundary, first row: the machine starts where the trace says it starts.
    let first = &trace.steps[0];
    if first.clk != 0 {
        return Err(violation(
            "clock_start",
            0,
            "the first row's clock is not zero",
        ));
    }
    if first.pc != trace.initial_pc {
        return Err(violation(
            "initial_pc",
            0,
            format!(
                "the first row runs at pc {} but the machine started at {}",
                first.pc, trace.initial_pc
            ),
        ));
    }
    if trace.initial_regs[0] != 0 {
        return Err(violation(
            "initial_r0",
            0,
            "the machine cannot start with a non-zero r0",
        ));
    }

    for (row, step) in trace.steps.iter().enumerate() {
        let previous_regs = if row == 0 {
            trace.initial_regs
        } else {
            trace.steps[row - 1].regs
        };

        // (1) clock and program counter.
        if step.clk != row as u64 {
            return Err(violation(
                "clock_sequence",
                row,
                format!("the clock reads {} on row {row}", step.clk),
            ));
        }
        if step.pc >= trace.program.len() as u64 {
            return Err(violation(
                "pc_in_program",
                row,
                format!(
                    "pc {} is outside a program of {} instructions",
                    step.pc,
                    trace.program.len()
                ),
            ));
        }

        // (2) register indices and the operand values read from them.
        for (name, index) in [
            ("rd_idx", step.rd_idx),
            ("rs1_idx", step.rs1_idx),
            ("rs2_idx", step.rs2_idx),
        ] {
            if index as usize >= REGISTERS {
                return Err(violation(
                    "register_index_range",
                    row,
                    format!("{name} is {index}, the register file has {REGISTERS} registers"),
                ));
            }
        }
        let expected_rs1 = previous_regs[step.rs1_idx as usize];
        if step.rs1_val != expected_rs1 {
            return Err(violation(
                "rs1_value",
                row,
                format!(
                    "rs1 reads r{} which held {expected_rs1:#x}, not {:#x}",
                    step.rs1_idx, step.rs1_val
                ),
            ));
        }
        let expected_rs2 = previous_regs[step.rs2_idx as usize];
        if step.rs2_val != expected_rs2 {
            return Err(violation(
                "rs2_value",
                row,
                format!(
                    "rs2 reads r{} which held {expected_rs2:#x}, not {:#x}",
                    step.rs2_idx, step.rs2_val
                ),
            ));
        }

        // (3) the opcode is implemented, and it is the one the committed word
        // at this program counter decodes to. A trace cannot substitute a
        // cheaper instruction for the one the program contains.
        let opcode = Opcode::from_byte(step.opcode).map_err(|error| {
            violation(
                "opcode_implemented",
                row,
                format!("the row claims an opcode outside the subset: {error}"),
            )
        })?;
        let committed = decode(trace.program[step.pc as usize]).map_err(|error| {
            violation(
                "program_decodes",
                row,
                format!(
                    "the committed word at pc {} does not decode: {error}",
                    step.pc
                ),
            )
        })?;
        if committed.opcode != opcode {
            return Err(violation(
                "program_opcode",
                row,
                format!(
                    "the row runs {:?} but the committed program holds {:?} at pc {}",
                    opcode, committed.opcode, step.pc
                ),
            ));
        }
        if (step.rd_idx, step.rs1_idx, step.rs2_idx, step.imm)
            != (
                committed.rd,
                committed.rs1,
                committed.rs2,
                committed.imm as i64,
            )
        {
            return Err(violation(
                "program_operands",
                row,
                "the row's register and immediate fields are not the committed instruction's",
            ));
        }

        // (5) the memory event. A memory row addresses `rs1_val + imm`; a read
        // returns what the carried memory state holds, a write stores the
        // second operand, and a row that touches no memory contributes zeros.
        let mut expected_result = 0u64;
        if opcode.is_memory() && !(opcode == Opcode::Load && step.rs1_idx == 0) {
            let expected_address = step.rs1_val as i128 + step.imm as i128;
            if !(0..MEMORY_WORDS as i128).contains(&expected_address) {
                return Err(violation(
                    "memory_address_range",
                    row,
                    format!(
                        "{opcode:?} addresses word {expected_address}, outside the address space"
                    ),
                ));
            }
            if step.addr_or_zero() != expected_address as u64 {
                return Err(violation(
                    "memory_address",
                    row,
                    format!(
                        "the row addresses word {} but rs1 + imm is {expected_address}",
                        step.addr_or_zero()
                    ),
                ));
            }
            let address = expected_address as usize;
            if opcode == Opcode::Store {
                if step.mem_val.unwrap_or(0) != step.rs2_val {
                    return Err(violation(
                        "memory_store_value",
                        row,
                        "a store writes the second operand",
                    ));
                }
                if !step.is_mem_write {
                    return Err(violation("memory_write_flag", row, "a store is a write"));
                }
                memory[address] = step.rs2_val;
            } else {
                if step.mem_val.unwrap_or(0) != memory[address] {
                    return Err(violation(
                        "memory_value_mismatch",
                        row,
                        format!(
                            "the row reads {:#x} from word {address} which holds {:#x}",
                            step.mem_val.unwrap_or(0),
                            memory[address]
                        ),
                    ));
                }
                if step.is_mem_write {
                    return Err(violation("memory_write_flag", row, "a load is not a write"));
                }
            }
        } else if step.addr_or_zero() != 0 || step.val_or_zero() != 0 || step.is_mem_write {
            return Err(violation(
                "memory_event_on_non_memory_row",
                row,
                format!("{opcode:?} touches no memory, so its event must be zero"),
            ));
        }

        // (4) the semantics of the opcode.
        match opcode {
            Opcode::Halt | Opcode::Store | Opcode::Jmp | Opcode::Jnz | Opcode::Assert => {}
            Opcode::Add => expected_result = crate::add(step.rs1_val, step.rs2_val),
            Opcode::Sub => expected_result = crate::sub(step.rs1_val, step.rs2_val),
            Opcode::Mul => expected_result = crate::mul(step.rs1_val, step.rs2_val),
            Opcode::Eq => expected_result = u64::from(step.rs1_val == step.rs2_val),
            Opcode::Lt => expected_result = u64::from(step.rs1_val < step.rs2_val),
            Opcode::Load => {
                expected_result = if step.rs1_idx == 0 {
                    // The immediate form: no memory event, the immediate is the
                    // result, as a 64-bit two's-complement value.
                    step.imm as u64
                } else {
                    // The validated read above: the row's own value is the
                    // memory value, and the constraint that it equals the
                    // carried state has already been checked.
                    step.mem_val.unwrap_or(0)
                };
            }
        }
        if step.rd_val_new != expected_result {
            return Err(violation(
                "result_value",
                row,
                format!(
                    "{opcode:?} produces {expected_result:#x} at these operands, the row claims {:#x}",
                    step.rd_val_new
                ),
            ));
        }
        if matches!(opcode, Opcode::Eq | Opcode::Lt) && step.rd_val_new > 1 {
            return Err(violation(
                "comparison_is_a_bit",
                row,
                "a comparison produces zero or one",
            ));
        }

        // (6) the next program counter.
        let expected_next_pc = match opcode {
            Opcode::Halt => step.pc,
            Opcode::Jmp => (step.pc as i128 + step.imm as i128) as u64,
            Opcode::Jnz => {
                if step.rs1_val != 0 {
                    (step.pc as i128 + step.imm as i128) as u64
                } else {
                    step.pc + 1
                }
            }
            _ => step.pc + 1,
        };
        if step.next_pc != expected_next_pc {
            return Err(violation(
                "next_pc",
                row,
                format!(
                    "{opcode:?} goes to {expected_next_pc}, the row says {}",
                    step.next_pc
                ),
            ));
        }

        // (7) the register file after the instruction.
        let mut expected_regs = previous_regs;
        if writes_register(opcode) {
            expected_regs[step.rd_idx as usize] = step.rd_val_new;
        }
        expected_regs[0] = 0;
        for (index, expected) in expected_regs.iter().enumerate() {
            if step.regs[index] != *expected {
                return Err(violation(
                    "register_file",
                    row,
                    format!(
                        "r{index} is {:#x} after the instruction, the transition gives {expected:#x}",
                        step.regs[index]
                    ),
                ));
            }
        }

        // (8) the last row is a halt, and the trace's final state is that row's.
        if row + 1 == trace.steps.len() {
            if opcode != Opcode::Halt {
                return Err(violation(
                    "last_row_is_halt",
                    row,
                    format!("the last row runs {opcode:?}, so the run never halts"),
                ));
            }
            if !trace.halted {
                return Err(violation(
                    "final_halted_flag",
                    row,
                    "the last row halts but the trace is not marked halted",
                ));
            }
            if trace.final_regs != step.regs {
                return Err(violation(
                    "final_registers",
                    row,
                    "the trace's final register file is not the last row's",
                ));
            }
            if trace.final_pc != step.next_pc {
                return Err(violation(
                    "final_pc",
                    row,
                    format!(
                        "the trace ends at pc {} but the halt leaves pc {}",
                        trace.final_pc, step.next_pc
                    ),
                ));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm::assemble;
    use crate::vm::Vm;

    fn run(source: &str, steps: usize) -> Trace {
        let program = assemble(source).unwrap();
        let mut vm = Vm::new();
        vm.run(&program, steps).unwrap();
        vm.trace(&program)
    }

    #[test]
    fn an_honest_trace_satisfies_every_constraint() {
        let trace = run(
            r"
            load r1, 7
            load r2, 6
            mul  r3, r1, r2
            halt
            ",
            32,
        );
        assert_eq!(check_trace(&trace), Ok(()));
    }

    #[test]
    fn a_trace_that_skips_a_step_is_refused_by_the_clock() {
        let mut trace = run(
            r"
            load r1, 1
            add  r1, r1, r1
            halt
            ",
            32,
        );
        trace.steps.remove(1);
        assert_eq!(check_trace(&trace).unwrap_err().kind, "clock_sequence");
    }

    #[test]
    fn a_substituted_opcode_is_refused_against_the_committed_program() {
        let mut trace = run(
            r"
            load r1, 4
            load r2, 9
            add  r3, r1, r2
            halt
            ",
            32,
        );
        // Claim the add was a sub, and keep everything else self-consistent so
        // that only the program binding can catch it.
        let row = 2;
        trace.steps[row].opcode = Opcode::Sub.byte();
        trace.steps[row].rd_val_new = crate::sub(4, 9);
        trace.steps[row].regs[3] = crate::sub(4, 9);
        assert_eq!(check_trace(&trace).unwrap_err().kind, "program_opcode");
    }

    #[test]
    fn a_wrong_result_is_refused() {
        let mut trace = run(
            r"
            load r1, 20
            load r2, 22
            add  r3, r1, r2
            halt
            ",
            32,
        );
        trace.steps[2].rd_val_new += 1;
        trace.steps[2].regs[3] += 1;
        assert_eq!(check_trace(&trace).unwrap_err().kind, "result_value");
    }

    #[test]
    fn a_register_that_changes_without_being_written_is_refused() {
        let mut trace = run(
            r"
            load r1, 3
            load r2, 4
            halt
            ",
            32,
        );
        trace.steps[1].regs[0] = 1;
        assert_eq!(check_trace(&trace).unwrap_err().kind, "register_file");
    }

    #[test]
    fn a_read_of_a_word_that_was_never_written_is_refused() {
        let mut trace = run(
            r"
            load r4, 9
            load r1, 1
            store [r4], r1
            load r2, [r4]
            halt
            ",
            32,
        );
        trace.steps[3].mem_val = Some(0);
        trace.steps[3].rd_val_new = 0;
        trace.steps[3].regs[2] = 0;
        assert_eq!(
            check_trace(&trace).unwrap_err().kind,
            "memory_value_mismatch"
        );
    }

    #[test]
    fn a_final_row_that_is_not_a_halt_is_refused() {
        let mut trace = run(
            r"
            load r1, 1
            halt
            ",
            32,
        );
        trace.steps.pop();
        trace.steps.pop();
        trace.steps.push(crate::trace::Step {
            clk: 0,
            pc: 0,
            opcode: Opcode::Load.byte(),
            rd_idx: 1,
            rs1_idx: 0,
            rs2_idx: 0,
            rs1_val: 0,
            rs2_val: 0,
            rd_val_new: 1,
            next_pc: 1,
            imm: 1,
            mem_addr: None,
            mem_val: None,
            is_mem_write: false,
            regs: [0, 1, 0, 0, 0, 0, 0, 0],
        });
        trace.final_regs = [0, 1, 0, 0, 0, 0, 0, 0];
        trace.final_pc = 1;
        trace.halted = false;
        assert_eq!(check_trace(&trace).unwrap_err().kind, "last_row_is_halt");
    }

    #[test]
    fn an_empty_trace_is_refused() {
        let trace = Trace {
            program: vec![0],
            initial_regs: [0; REGISTERS],
            initial_pc: 0,
            initial_memory: vec![0; MEMORY_WORDS],
            steps: Vec::new(),
            final_regs: [0; REGISTERS],
            final_pc: 0,
            halted: true,
            gas_used: 0,
        };
        assert_eq!(check_trace(&trace).unwrap_err().kind, "empty_trace");
    }
}
