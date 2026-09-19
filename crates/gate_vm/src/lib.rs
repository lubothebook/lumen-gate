//! The Lumen Gate VM: a field-native, 8-register, 8-line machine with a
//! bounded execution window, whose executions are proved by
//! `circuits/gate_vm.circom` through the repository's existing Groth16
//! verifier pipeline.
//!
//! This crate is the machine and its witness generator; it is *not* the
//! prover's crypto (the circom+snarkjs pipeline is) and *not* the verifier
//! (the registry contract is). What lives here:
//!
//! * [`isa`] — the opcodes and the packed program-cell format;
//! * [`vm`] — the interpreter, whose trace the circuit re-derives;
//! * [`poseidon`] — the pinned circomlib permutation, ported so the Rust
//!   trace and the circuit's hash agree to the constant;
//! * [`program`] — assembly plus the Poseidon-fold program commitment;
//! * [`witness`] — the snarkjs input emitter and the registry payload writer,
//!   sharing one receipt so a claim and a proof can never be built from
//!   different runs.
//!
//! What is deliberately *not* claimed: this is not a RISC-V, not recursive,
//! and the window (8 steps) is the machine's gas limit, not a performance
//! ceiling. The docs in `docs/PROVING_SYSTEM.md` state the boundary exactly;
//! the machine is small so that its soundness can be read, not so that the
//! README can say "zkVM" without footnotes.

pub mod field;
pub mod isa;
pub mod poseidon;
pub mod program;
pub mod vm;
pub mod witness;

pub use field::Fp;
pub use isa::{Inst, Opcode};
pub use poseidon::poseidon2;
pub use program::{assemble, demo_program, program_root};
pub use vm::{Receipt, VmError, run};
pub use witness::{
    DOMAIN_TAG_DEC, DOMAIN_TAG_HEX, PAYLOAD_LEN, circom_input, payload, public_inputs,
};
