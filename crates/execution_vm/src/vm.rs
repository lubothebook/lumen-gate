//! The interpreter. This is the reference implementation of the semantics that
//! `circuits/execution_trace.circom` enforces, and `constraints::check_trace` is
//! the tool that proves the two agree: the tests at the bottom of this file run
//! the checker over real programs.
//!
//! A step is produced **only** for an instruction that is really fetched and
//! executed. Running off the end of the program, halting, failing an assertion
//! or touching memory out of range all end the run without a partial row -- the
//! trace ends with a `Halt` row so that the circuit's last-row boundary
//! condition has something true to say.

use crate::isa::{decode, Opcode};
use crate::trace::{Step, Trace, MEMORY_WORDS, REGISTERS};
use serde::{Deserialize, Serialize};

/// Why a run stopped or refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum VmError {
    /// The program counter left the program.
    InvalidPc,
    /// An assertion failed.
    AssertionFailed,
    /// A load or store addressed outside the address space.
    InvalidMemoryAccess,
    /// The instruction word decoded to an opcode outside the subset.
    InvalidOpcode(String),
    /// The machine ran more steps than the caller allowed.
    StepLimitExceeded,
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VmError::InvalidPc => write!(f, "program counter outside the program"),
            VmError::AssertionFailed => write!(f, "assert instruction with a zero operand"),
            VmError::InvalidMemoryAccess => write!(f, "memory access outside the address space"),
            VmError::InvalidOpcode(inner) => write!(f, "invalid opcode: {inner}"),
            VmError::StepLimitExceeded => write!(f, "step limit exceeded"),
        }
    }
}

impl std::error::Error for VmError {}

/// The machine.
#[derive(Debug, Clone)]
pub struct Vm {
    pub pc: usize,
    pub registers: [u64; REGISTERS],
    pub memory: Vec<u64>,
    pub trace: Vec<Step>,
    pub halted: bool,
    pub error: Option<VmError>,
    gas_used: u64,
    initial_regs: [u64; REGISTERS],
    initial_pc: u64,
    initial_memory: Vec<u64>,
}

impl Vm {
    /// A machine with the register file and memory zeroed. Like the reference
    /// machine, the address space is fixed: `MEMORY_WORDS` words of
    /// little-endian storage, addressed by word index.
    pub fn new() -> Vm {
        Vm {
            pc: 0,
            registers: [0; REGISTERS],
            memory: vec![0; MEMORY_WORDS],
            trace: Vec::new(),
            halted: false,
            error: None,
            gas_used: 0,
            initial_regs: [0; REGISTERS],
            initial_pc: 0,
            initial_memory: vec![0; MEMORY_WORDS],
        }
    }

    /// Sets the initial register file. `r0` is ignored: it is pinned to zero.
    pub fn with_registers(mut self, registers: [u64; REGISTERS]) -> Vm {
        let mut registers = registers;
        registers[0] = 0;
        self.registers = registers;
        self.initial_regs = registers;
        self
    }

    /// Sets the initial program counter.
    pub fn with_pc(mut self, pc: usize) -> Vm {
        self.pc = pc;
        self.initial_pc = pc as u64;
        self
    }

    /// Seeds memory. A word index outside the address space is a refusal, not a
    /// silently dropped write.
    pub fn with_memory_word(mut self, address: usize, value: u64) -> Result<Vm, VmError> {
        if address >= self.memory.len() {
            return Err(VmError::InvalidMemoryAccess);
        }
        self.memory[address] = value;
        self.initial_memory = self.memory.clone();
        Ok(self)
    }

    /// Reads a word. The circuit range-checks the address into six bits, so this
    /// refuses anything a six-bit address cannot name.
    pub fn read_word(&self, value: u64, imm: i32) -> Result<u64, VmError> {
        let addr = word_address(value, imm)?;
        Ok(self.memory[addr])
    }

    /// Fetches and executes one instruction, pushing exactly one trace row on
    /// success. On a refusal the machine halts and pushes nothing.
    pub fn step(&mut self, program: &[u64]) -> Result<(), VmError> {
        self.registers[0] = 0;
        if self.halted {
            return Ok(());
        }
        if self.pc >= program.len() {
            self.halted = true;
            self.error = Some(VmError::InvalidPc);
            return Err(VmError::InvalidPc);
        }

        let instruction = match decode(program[self.pc]) {
            Ok(instruction) => instruction,
            Err(inner) => {
                self.halted = true;
                let error = VmError::InvalidOpcode(inner);
                self.error = Some(error.clone());
                return Err(error);
            }
        };

        let cur_pc = self.pc;
        self.gas_used += instruction.opcode.gas();

        let (src1_idx, src2_idx, dst_idx) = (instruction.rs1, instruction.rs2, instruction.rd);
        let src1_val = self.registers[(src1_idx % REGISTERS as u8) as usize];
        let src2_val = self.registers[(src2_idx % REGISTERS as u8) as usize];

        let mut memory_addr: Option<u64> = None;
        let mut memory_val: Option<u64> = None;
        let mut is_memory_write = false;

        let (dst_val, next_pc) = match instruction.opcode {
            Opcode::Halt => {
                self.halted = true;
                (0, cur_pc as u64)
            }
            Opcode::Add => {
                let result = crate::add(src1_val, src2_val);
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Sub => {
                let result = crate::sub(src1_val, src2_val);
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Mul => {
                let result = crate::mul(src1_val, src2_val);
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Eq => {
                let result = if src1_val == src2_val { 1 } else { 0 };
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Lt => {
                let result = if src1_val < src2_val { 1 } else { 0 };
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Load => {
                // `rs1 == r0` with either immediate shape is the "immediate
                // into a register" form, exactly as in the reference machine:
                // it touches no memory and produces no memory event.
                let result = if src1_idx == 0 {
                    instruction.imm as i64 as u64
                } else {
                    let addr = word_address(src1_val, instruction.imm)?;
                    let val = self.memory[addr];
                    memory_addr = Some(addr as u64);
                    memory_val = Some(val);
                    val
                };
                self.registers[(dst_idx % REGISTERS as u8) as usize] = result;
                self.pc += 1;
                (result, (cur_pc + 1) as u64)
            }
            Opcode::Store => {
                let addr = word_address(src1_val, instruction.imm)?;
                self.memory[addr] = src2_val;
                memory_addr = Some(addr as u64);
                memory_val = Some(src2_val);
                is_memory_write = true;
                self.pc += 1;
                (0, (cur_pc + 1) as u64)
            }
            Opcode::Jmp => {
                let target = (cur_pc as i64 + instruction.imm as i64) as u64;
                self.pc = target as usize;
                (0, target)
            }
            Opcode::Jnz => {
                let target = if src1_val != 0 {
                    (cur_pc as i64 + instruction.imm as i64) as u64
                } else {
                    (cur_pc + 1) as u64
                };
                self.pc = target as usize;
                (0, target)
            }
            Opcode::Assert => {
                if src1_val == 0 {
                    self.halted = true;
                    self.error = Some(VmError::AssertionFailed);
                    return Err(VmError::AssertionFailed);
                }
                self.pc += 1;
                (0, (cur_pc + 1) as u64)
            }
        };

        self.registers[0] = 0;
        self.trace.push(Step {
            clk: self.trace.len() as u64,
            pc: cur_pc as u64,
            opcode: instruction.opcode.byte(),
            rd_idx: dst_idx,
            rs1_idx: src1_idx,
            rs2_idx: src2_idx,
            rs1_val: src1_val,
            rs2_val: src2_val,
            rd_val_new: dst_val,
            next_pc,
            imm: instruction.imm as i64,
            mem_addr: memory_addr,
            mem_val: memory_val,
            is_mem_write: is_memory_write,
            regs: self.registers,
        });
        Ok(())
    }

    /// Runs until the machine halts, or until `step_limit` steps have been
    /// executed. The limit is a refusal ([`VmError::StepLimitExceeded`]), never
    /// a truncated trace presented as a complete one.
    pub fn run(&mut self, program: &[u64], step_limit: usize) -> Result<(), VmError> {
        while !self.halted {
            if self.trace.len() >= step_limit {
                self.error = Some(VmError::StepLimitExceeded);
                return Err(VmError::StepLimitExceeded);
            }
            self.step(program)?;
        }
        Ok(())
    }

    /// The trace, with the initial and final state that the circuit's boundary
    /// conditions are checked against. This is what the prover consumes.
    pub fn trace(&self, program: &[u64]) -> Trace {
        Trace {
            program: program.to_vec(),
            initial_regs: self.initial_regs,
            initial_pc: self.initial_pc,
            initial_memory: self.initial_memory.clone(),
            steps: self.trace.clone(),
            final_regs: self.registers,
            final_pc: self.pc as u64,
            halted: self.halted,
            gas_used: self.gas_used,
        }
    }
}

impl Default for Vm {
    fn default() -> Vm {
        Vm::new()
    }
}

/// The word address implied by `value + imm`, refusing anything outside the
/// address space. The circuit range-checks the address to six bits and the
/// address space is 64 words, so both sides agree on the boundary.
pub fn word_address(value: u64, imm: i32) -> Result<usize, VmError> {
    let offset = imm as i64;
    let base = i64::try_from(value).map_err(|_| VmError::InvalidMemoryAccess)?;
    let address = base.checked_add(offset).ok_or(VmError::InvalidMemoryAccess)?;
    if address < 0 || address >= MEMORY_WORDS as i64 {
        return Err(VmError::InvalidMemoryAccess);
    }
    Ok(address as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm::assemble;
    use crate::constraints::check_trace;
    use crate::isa::Instruction;

    #[test]
    fn a_wrapping_add_is_the_arithmetic_the_circuit_proves() {
        let program = assemble(
            r"
            load  r1, 0xFFFFFFFFFFFFFFFF
            load  r2, 2
            add   r3, r1, r2
            halt
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        vm.run(&program, 64).unwrap();
        assert_eq!(vm.registers[3], 1, "0xFFFF... + 2 wraps to 1");
        let trace = vm.trace(&program);
        assert_eq!(trace.steps.len(), 4);
        assert_eq!(check_trace(&trace), Ok(()));
    }

    #[test]
    fn a_loop_terminates_and_every_row_of_it_is_a_legal_step() {
        // r1 counts 5, 4, ... 1; every step asserts r1 is non-zero, and the
        // loop exits when the subtraction reaches zero. Sum 5+4+3+2+1 = 15.
        let program = assemble(
            r"
            load  r1, 5
            load  r2, 0
        loop:
            assert r1
            add   r2, r2, r1
            load  r3, 1
            sub   r1, r1, r3
            jnz   r1, loop
            halt
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        vm.run(&program, 256).unwrap();
        assert!(vm.halted);
        assert_eq!(vm.registers[2], 15, "5+4+3+2+1");
        assert_eq!(vm.registers[1], 0);
        let trace = vm.trace(&program);
        assert_eq!(check_trace(&trace), Ok(()));
    }

    #[test]
    fn a_failed_assertion_stops_the_run_and_produces_no_trace() {
        // 5 < 3 is false, so the comparison writes zero and the assertion
        // refuses. The machine halts with an error; `run` returns `Err`, so
        // there is no trace to present as a completed execution.
        let program = assemble(
            r"
            load  r1, 3
            load  r2, 5
            lt    r3, r2, r1
            assert r3
            halt
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        assert_eq!(vm.run(&program, 64), Err(VmError::AssertionFailed));
        assert!(vm.error.is_some());
    }

    #[test]
    fn memory_is_carried_not_logged() {
        // The loop writes the running sum, reloads it from memory and adds the
        // next term, so the result exists only if every write is carried
        // forward into the next read.
        let program = assemble(
            r"
            load  r1, 15
            load  r3, 1
            load  r5, 8
            load  r6, 0
            store [r5], r6
        loop:
            load  r2, [r5]
            add   r2, r2, r1
            store [r5], r2
            sub   r1, r1, r3
            jnz   r1, loop
            halt
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        vm.run(&program, 256).unwrap();
        assert_eq!(vm.registers[2], 120, "1+2+...+15");
        let trace = vm.trace(&program);
        assert_eq!(check_trace(&trace), Ok(()));

        // Flip one store's value in the trace without touching the program.
        let mut tampered = trace.clone();
        let store_row = tampered
            .steps
            .iter()
            .position(|step| step.is_mem_write)
            .unwrap();
        tampered.steps[store_row].mem_val = Some(999);
        let violation = check_trace(&tampered).unwrap_err();
        assert_eq!(violation.kind, "memory_store_value");
        // The read side is the interesting half of the carry: a load that
        // claims a value the memory state does not hold is refused, and that
        // case is pinned in `constraints.rs`.
    }

    #[test]
    fn running_off_the_end_refuses_instead_of_halting_quietly() {
        let program = assemble("add r1, r1, r1").unwrap();
        let mut vm = Vm::new();
        assert_eq!(vm.run(&program, 8), Err(VmError::InvalidPc));
    }

    #[test]
    fn the_step_limit_is_a_refusal() {
        let program = assemble(
            r"
        spin:
            jmp spin
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        assert_eq!(vm.run(&program, 32), Err(VmError::StepLimitExceeded));
    }

    #[test]
    fn an_unimplemented_opcode_refuses_at_the_machine() {
        let program = vec![Instruction::new(Opcode::Halt, 0, 0, 0, 0).encode() | 0x04];
        let mut vm = Vm::new();
        let error = vm.run(&program, 4).unwrap_err();
        assert!(matches!(error, VmError::InvalidOpcode(_)), "{error:?}");
    }

    #[test]
    fn out_of_range_memory_refuses() {
        let program = assemble(
            r"
            load r1, 64
            load r2, [r1]
            halt
            ",
        )
        .unwrap();
        let mut vm = Vm::new();
        assert_eq!(vm.run(&program, 16), Err(VmError::InvalidMemoryAccess));
    }
}
