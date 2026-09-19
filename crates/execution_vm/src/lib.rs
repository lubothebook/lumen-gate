//! A small register machine whose execution becomes a proof.
//!
//! # What this is, and what it is not
//!
//! This crate is the *execution* half of Lumen Gate's execution lane: an
//! instruction set, a program encoding, an interpreter that really runs the
//! program, an execution trace with one row per fetched instruction, and a
//! constraint checker that decides whether a trace is a legal execution of the
//! committed program.
//!
//! The *proof* half is `circuits/execution_trace.circom`, which proves the same
//! relation over the same columns and is verified on-chain by the registry
//! contract. The two are deliberately separate so that the relation can be
//! tested in two independent ways: this crate checks a trace in plain Rust,
//! where a failure prints a sentence, and the circuit checks it in a field,
//! where a failure is an unsatisfiable constraint.
//!
//! It is **not** a general-purpose virtual machine in the sense a zkVM is: the
//! address space is 64 words, the register file is four words wide, the
//! instruction set is a subset, and the number of steps in one proof is fixed
//! by the circuit. What it is, exactly, is a machine whose *execution* is
//! proved: a committed program, per-step transition constraints, boundary
//! conditions on the first and last rows, and a memory model that carries state
//! instead of trusting a log. Section by section:
//!
//! * [`isa`] the instruction set, encoding and decoding;
//! * [`asm`] a two-pass assembler, so a program in the tests reads like code;
//! * [`vm`] the interpreter, which is the reference implementation of the
//!   semantics the circuit enforces;
//! * [`trace`] one row per step, in the column order the circuit uses;
//! * [`constraints`] the checker, which is the Rust twin of the circuit.
//!
//! # Arithmetic, stated precisely
//!
//! Register values are 64-bit unsigned integers. `Add`, `Sub` and `Mul` wrap
//! modulo 2^64. `Eq` and `Lt` compare the exact integers. This differs from the
//! design this machine's instruction set is derived from, which evaluates the
//! same opcodes over a 64-bit prime field rather than over 2^64: the semantics
//! are the same shape, the modulus is not, and the difference is written down
//! here because a reader comparing the two will otherwise find it the hard way.
//!
//! Wrapping is not an accident of the implementation: it is what the circuit
//! proves, because the circuit has the room to express it exactly. `Add`,
//! `Sub` and `Mul` are checked against the modular equations
//! `rs1 + rs2 = rd + 2^64·carry`, `rd + rs2 = rs1 + 2^64·borrow` and
//! `rs1·rs2 = rd + 2^64·quotient`, with every result range-checked to 64 bits.

pub mod asm;
pub mod constraints;
pub mod isa;
pub mod lane;
pub mod trace;
pub mod vm;

pub use asm::assemble;
pub use constraints::{check_trace, TraceViolation};
pub use isa::{decode, encode, Instruction, Opcode, DECODE_ERROR_UNKNOWN_OPCODE};
pub use lane::{
    check_lane_trace, lane_witness, pad_to, ExecutionWitness, LaneError, LaneStatement,
    LANE_PROGRAM_WORDS, LANE_STEPS, MAX_PROGRAM_WORD,
};
pub use trace::{Step, Trace, COLUMNS, MEMORY_WORDS, REGISTERS};
pub use vm::{Vm, VmError};

/// The largest value a register can hold.
pub const MASK64: u128 = u64::MAX as u128;

/// Wrapping addition, in the domain the circuit proves.
pub fn add(a: u64, b: u64) -> u64 {
    a.wrapping_add(b)
}

/// Wrapping subtraction, in the domain the circuit proves.
pub fn sub(a: u64, b: u64) -> u64 {
    a.wrapping_sub(b)
}

/// Wrapping multiplication, in the domain the circuit proves.
pub fn mul(a: u64, b: u64) -> u64 {
    a.wrapping_mul(b)
}
