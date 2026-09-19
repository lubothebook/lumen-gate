//! The interpreter and trace generator.
//!
//! The machine is small on purpose — 8 registers, 8 lines, a fixed execution
//! window — but it is a machine: the program is data, the same line can run
//! more than once, and the proof covers "this program, committed, reached
//! this state", not one hard-coded relation.
//!
//! Two semantic rules the circuit mirrors exactly, both inherited from the
//! shape of metered VMs:
//!
//! * The window is the gas model. A program that has not halted inside the
//!   window has no trace; there is no partial row and no "it would have
//!   finished soon". The circuit's boundary constraint at the last row is the
//!   same refusal, expressed as unsatisfiability.
//! * A failed assertion aborts generation, not the trace. `AssertEq` failing
//!   is `VmError`, and the emitter refuses to write a witness for a machine
//!   state that did not happen.

use crate::field::Fp;
use crate::isa::{Inst, Opcode, PROGRAM_LINES, REGISTERS};
use crate::poseidon::poseidon2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VmError {
    /// Program cells that do not decode (an impossible input to the
    /// assembler, guarded at build time; typed here so no caller can forget).
    InvalidProgram,
    /// The window ended with the machine still running.
    NoHalt,
    /// An AssertEq instruction whose registers disagreed.
    AssertionFailed,
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VmError::InvalidProgram => {
                write!(f, "a program cell does not decode into a valid instruction")
            }
            VmError::NoHalt => write!(f, "the program did not halt inside the execution window"),
            VmError::AssertionFailed => {
                write!(f, "an AssertEq instruction compared two different values")
            }
        }
    }
}

impl std::error::Error for VmError {}

/// The machine state as it appears at the start of each trace row.
#[derive(Clone, Debug)]
pub struct Step {
    pub pc: u8,
    pub regs: [Fp; REGISTERS],
    pub halted: bool,
}

/// A finished execution: one row per window step, plus the derived facts the
/// circuit publishes and the registry binds.
#[derive(Clone, Debug)]
pub struct Receipt {
    pub steps: Vec<Step>,
    /// Hash steps executed while active — the circuit's own counter, and the
    /// chain length a settlement record reports.
    pub hash_steps: u64,
    /// The final value of r2: the program's output register.
    pub output: Fp,
}

/// Run the machine over `program` with the two public input elements, for
/// exactly `window` rows (the last of which must find the machine halted).
pub fn run(
    program: &[u16; PROGRAM_LINES],
    start: &Fp,
    event: &Fp,
    window: usize,
) -> Result<Receipt, VmError> {
    let mut insts = Vec::with_capacity(PROGRAM_LINES);
    for cell in program {
        insts.push(Inst::decode(*cell).ok_or(VmError::InvalidProgram)?);
    }

    let mut regs = [Fp::ZERO; REGISTERS];
    regs[0] = start.clone();
    regs[1] = event.clone();
    let mut pc: u8 = 0;
    let mut halted = false;
    let mut hash_steps = 0u64;
    let mut steps = Vec::with_capacity(window);

    for _ in 0..window {
        steps.push(Step {
            pc,
            regs: regs.clone(),
            halted,
        });
        if halted {
            // Frozen rows: the machine keeps "executing" the halt line forever,
            // which is what lets the circuit use one uniform step relation
            // with no end-of-program special case.
            continue;
        }
        if pc as usize >= PROGRAM_LINES {
            return Err(VmError::NoHalt);
        }
        let inst = insts[pc as usize];
        let next_pc = match inst.op {
            Opcode::Move => {
                let v = regs[inst.a as usize].clone();
                regs[inst.c as usize] = v;
                pc + 1
            }
            Opcode::Add => {
                let v = regs[inst.a as usize].add(&regs[inst.b as usize]);
                regs[inst.c as usize] = v;
                pc + 1
            }
            Opcode::Sub => {
                let v = regs[inst.a as usize].sub(&regs[inst.b as usize]);
                regs[inst.c as usize] = v;
                pc + 1
            }
            Opcode::Mul => {
                let v = regs[inst.a as usize].mul(&regs[inst.b as usize]);
                regs[inst.c as usize] = v;
                pc + 1
            }
            Opcode::Pose => {
                let v = poseidon2(&regs[inst.a as usize], &regs[inst.b as usize]);
                regs[inst.c as usize] = v;
                hash_steps += 1;
                pc + 1
            }
            Opcode::AssertEq => {
                if regs[inst.a as usize] != regs[inst.b as usize] {
                    return Err(VmError::AssertionFailed);
                }
                pc + 1
            }
            Opcode::JumpNZ => {
                if regs[inst.a as usize].is_zero() {
                    pc + 1
                } else {
                    inst.b
                }
            }
            Opcode::Halt => {
                halted = true;
                pc // the frozen program counter the rows after halt repeat
            }
        };
        pc = next_pc;
    }

    if !halted {
        return Err(VmError::NoHalt);
    }
    Ok(Receipt {
        steps,
        hash_steps,
        output: regs[2].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::program::assemble;

    fn demo() -> [u16; PROGRAM_LINES] {
        assemble(&[
            Inst::new(Opcode::Move, 0, 0, 2),
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::Halt, 0, 0, 0),
        ])
    }

    #[test]
    fn test_demo_program_hashes_chain_four_times() {
        let start = Fp::from_u64(41);
        let event = Fp::from_u64(1);
        let receipt = run(&demo(), &start, &event, 8).expect("halts");
        let mut want = start.clone();
        for _ in 0..4 {
            want = poseidon2(&want, &event);
        }
        assert_eq!(receipt.output, want);
        assert_eq!(receipt.hash_steps, 4);
        assert_eq!(receipt.steps.len(), 8);
        // Frozen rows after the halting step repeat its pc and registers.
        assert!(receipt.steps[6].halted);
        assert_eq!(receipt.steps[7].pc, 5);
        assert_eq!(receipt.steps[7].halted, receipt.steps[6].halted);
        assert_eq!(receipt.steps[7].regs, receipt.steps[6].regs);
    }

    #[test]
    fn test_window_exhaustion_is_a_refusal_not_a_maybe() {
        // A program of only POSE never halts; a four-row window cannot see the
        // halt that would come later. The machine refuses, it does not truncate.
        let insts = [Inst::new(Opcode::Pose, 2, 1, 2); 6];
        let p = assemble(&insts);
        assert_eq!(run(&p, &Fp::ZERO, &Fp::ONE, 4).err(), Some(VmError::NoHalt));
    }

    #[test]
    fn test_failed_assertion_refuses_to_emit_a_trace() {
        let program = assemble(&[
            Inst::new(Opcode::Move, 0, 0, 2),
            Inst::new(Opcode::AssertEq, 2, 1, 0), // r2 (start) != r1 (event)
            Inst::new(Opcode::Halt, 0, 0, 0),
        ]);
        assert_eq!(
            run(&program, &Fp::from_u64(7), &Fp::from_u64(9), 8).err(),
            Some(VmError::AssertionFailed)
        );
    }

    #[test]
    fn test_taken_jump_and_fallthrough() {
        let program = assemble(&[
            Inst::new(Opcode::Move, 0, 0, 2), // acc = start
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::JumpNZ, 0, 5, 0), // start != 0 -> to line 5
            Inst::new(Opcode::Pose, 2, 1, 2),   // skipped by the jump
            Inst::new(Opcode::Halt, 0, 0, 0),   // skipped
            Inst::new(Opcode::Sub, 1, 1, 6),    // r6 = 0
            Inst::new(Opcode::JumpNZ, 6, 1, 0), // r6 == 0 -> fall through
            Inst::new(Opcode::Halt, 0, 0, 0),
        ]);
        let receipt = run(&program, &Fp::from_u64(3), &Fp::from_u64(4), 8).expect("halts");
        assert_eq!(receipt.hash_steps, 1);
        assert_eq!(
            receipt.output,
            poseidon2(&Fp::from_u64(3), &Fp::from_u64(4))
        );
    }

    #[test]
    fn test_the_window_is_the_gas_and_an_unbreakable_loop_spends_it() {
        // A jump that can never fall through (its condition is a field value
        // no instruction in this program can drive to zero) has no trace: the
        // bounded window is the gas model, stated plainly in the docs.
        let program = assemble(&[
            Inst::new(Opcode::Pose, 2, 1, 2),
            Inst::new(Opcode::JumpNZ, 1, 0, 0), // event != 0 -> back forever
        ]);
        assert_eq!(
            run(&program, &Fp::from_u64(3), &Fp::from_u64(4), 8).err(),
            Some(VmError::NoHalt)
        );
    }
}
