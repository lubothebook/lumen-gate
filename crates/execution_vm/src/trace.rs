//! The execution trace: one row per fetched instruction.
//!
//! The column layout is the one `circuits/execution_trace.circom` consumes, in
//! this order, because the circuit's signal names are these names. A trace is
//! only useful if the prover and the verifier agree on what a column means, so
//! the order is a constant here and a comment there, and the fixture test in
//! `constraints.rs` pins the two together.
//!
//! | column | meaning |
//! |---|---|
//! | `clk` | row counter, incremented by one per fetched instruction |
//! | `pc` | program counter *before* the instruction executes |
//! | `opcode` | the opcode byte |
//! | `rd_idx`, `rs1_idx`, `rs2_idx` | register indices, five bits each |
//! | `rs1_val`, `rs2_val` | operand values, read before the instruction executes |
//! | `rd_val_new` | the value the instruction computes |
//! | `next_pc` | the program counter after the instruction |
//! | `imm` | the signed immediate, as the program word carries it |
//! | `mem_addr`, `mem_val`, `is_mem_write` | the memory event, zeroed on rows that do not touch memory |
//! | `regs[0..8]` | the register file *after* the instruction |
//!
//! Register `r0` is pinned to zero on every row. The reference machine pins it
//! the same way, and the circuit constrains it, so a program cannot use `r0` as
//! scratch space and quietly get a different answer here than there.

use crate::isa::Opcode;
use serde::{Deserialize, Serialize};

/// Registers. `r0` is pinned to zero; the other seven are general purpose.
/// Eight is the smallest file that lets a program keep five live values and
/// still address memory with a register, and it keeps the circuit's register
/// transition an eight-way mux per row rather than a table lookup.
pub const REGISTERS: usize = 8;

/// Memory words. The address space is carried row to row inside the proof, and
/// every word of it costs constraints on every row, so it is small on purpose:
/// this is the working set of a program, not a heap.
pub const MEMORY_WORDS: usize = 16;

/// Column names in circuit order. The last `REGISTERS` entries are the register
/// file, so `COLUMNS[COLUMNS.len() - 1]` is `r3`.
pub const COLUMNS: [&str; 15] = [
    "clk",
    "pc",
    "opcode",
    "rd_idx",
    "rs1_idx",
    "rs2_idx",
    "rs1_val",
    "rs2_val",
    "rd_val_new",
    "next_pc",
    "imm",
    "mem_addr",
    "mem_val",
    "is_mem_write",
    "regs",
];

/// One executed instruction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub clk: u64,
    pub pc: u64,
    pub opcode: u8,
    pub rd_idx: u8,
    pub rs1_idx: u8,
    pub rs2_idx: u8,
    pub rs1_val: u64,
    pub rs2_val: u64,
    pub rd_val_new: u64,
    pub next_pc: u64,
    pub imm: i64,
    pub mem_addr: Option<u64>,
    pub mem_val: Option<u64>,
    pub is_mem_write: bool,
    /// The register file after this instruction executes.
    pub regs: [u64; REGISTERS],
}

impl Step {
    /// The memory event address, zeroed on rows that do not touch memory. The
    /// circuit works with the zeroed form, so the two never disagree about what
    /// a non-memory row contributes to the transcript.
    pub fn addr_or_zero(&self) -> u64 {
        self.mem_addr.unwrap_or(0)
    }

    /// The memory event value, zeroed on rows that do not touch memory.
    pub fn val_or_zero(&self) -> u64 {
        if self.mem_addr.is_none() {
            0
        } else {
            self.mem_val.unwrap_or(0)
        }
    }

    pub fn is_mem_write_flag(&self) -> u64 {
        if self.is_mem_write {
            1
        } else {
            0
        }
    }
}

/// A complete execution: the program, where the machine started, every step,
/// and where it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trace {
    /// The committed program, one packed word per instruction.
    pub program: Vec<u64>,
    /// Registers before the first step.
    pub initial_regs: [u64; REGISTERS],
    /// Program counter before the first step.
    pub initial_pc: u64,
    /// Memory before the first step. A word each, little-endian, like the
    /// reference machine's memory.
    pub initial_memory: Vec<u64>,
    /// One row per fetched instruction.
    pub steps: Vec<Step>,
    /// Registers after the last step.
    pub final_regs: [u64; REGISTERS],
    /// Program counter after the last step.
    pub final_pc: u64,
    /// Set when the machine reached `Halt`.
    pub halted: bool,
    /// Gas charged by the reference costing, summed over the steps.
    pub gas_used: u64,
}

impl Trace {
    /// Rows in the trace.
    pub fn row_count(&self) -> u64 {
        self.steps.len() as u64
    }

    /// How many rows the run really used: the row count up to and including the
    /// halt. On a padded trace this is the number the statement publishes; on an
    /// unpadded one it equals [`Trace::row_count`].
    pub fn steps_executed(&self) -> u64 {
        for (row, step) in self.steps.iter().enumerate() {
            if Opcode::from_byte(step.opcode) == Ok(Opcode::Halt) {
                return (row + 1) as u64;
            }
        }
        self.steps.len() as u64
    }

    /// The initial state, as the circuit's first row sees it.
    pub fn initial_state(&self) -> ([u64; REGISTERS], u64) {
        (self.initial_regs, self.initial_pc)
    }

    /// The final state, as the circuit's last row leaves it.
    pub fn final_state(&self) -> ([u64; REGISTERS], u64) {
        (self.final_regs, self.final_pc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_memory_row_contributes_nothing_to_the_transcript() {
        let step = Step {
            clk: 0,
            pc: 0,
            opcode: 0x01,
            rd_idx: 1,
            rs1_idx: 2,
            rs2_idx: 3,
            rs1_val: 5,
            rs2_val: 6,
            rd_val_new: 11,
            next_pc: 1,
            imm: 0,
            mem_addr: None,
            mem_val: None,
            is_mem_write: false,
            regs: [0, 11, 5, 6, 0, 0, 0, 0],
        };
        assert_eq!(step.addr_or_zero(), 0);
        assert_eq!(step.val_or_zero(), 0);
        assert_eq!(step.is_mem_write_flag(), 0);
    }

    #[test]
    fn column_order_starts_with_the_clock_and_ends_with_the_register_file() {
        assert_eq!(COLUMNS[0], "clk");
        assert_eq!(COLUMNS[COLUMNS.len() - 1], "regs");
        assert_eq!(COLUMNS.len(), 15);
    }
}
