//! Program assembly and the program commitment.
//!
//! The commitment is a Poseidon fold over the packed cells — the same hash the
//! hash opcode exposes — so a program is pinned by an output of the machine it
//! describes, with no second hashing story to keep in sync:
//!
//! ```text
//! root_0 = 0
//! root_{i+1} = Poseidon(root_i, cell_i)      for i in 0..8
//! ```
//!
//! Lines beyond the program's length are HALT cells (0b111_000_000_000), which
//! execute as the no-op the frozen machine state already is. Padding with HALT
//! rather than zero matters: a zero cell decodes to `Move r0, r0, r0`, which
//! the machine could not tell apart from a real instruction at run time, and
//! padding must be part of the committed program exactly like the rest.

use crate::field::Fp;
use crate::isa::Inst;
use crate::poseidon::poseidon2;

pub const PROGRAM_LINES: usize = 8;
pub const HALT_CELL: u16 = 7 << 9;

/// Assemble instructions into the fixed program array, padded with HALT.
pub fn assemble(instructions: &[Inst]) -> [u16; PROGRAM_LINES] {
    assert!(
        instructions.len() <= PROGRAM_LINES,
        "a program longer than the line space is a policy error, not padding"
    );
    let mut cells = [HALT_CELL; PROGRAM_LINES];
    for (slot, inst) in instructions.iter().enumerate() {
        cells[slot] = inst.encode();
    }
    cells
}

/// The fold the circuit recomputes and the registry binds as a public input.
pub fn program_root(cells: &[u16; PROGRAM_LINES]) -> Fp {
    let mut acc = Fp::ZERO;
    for cell in cells {
        acc = poseidon2(&acc, &Fp::from_u64(u64::from(*cell)));
    }
    acc
}

/// The demo program of the lane's vectors: fold the two public roots together
/// four times and halt — the same relation the compiled step-chain circuit
/// hard-wires, now expressed as *data* the proof commits to rather than as
/// constraints the verifier is rebuilt for.
pub fn demo_program() -> [u16; PROGRAM_LINES] {
    use crate::isa::Opcode;
    assemble(&[
        Inst::new(Opcode::Move, 0, 0, 2),
        Inst::new(Opcode::Pose, 2, 1, 2),
        Inst::new(Opcode::Pose, 2, 1, 2),
        Inst::new(Opcode::Pose, 2, 1, 2),
        Inst::new(Opcode::Pose, 2, 1, 2),
        Inst::new(Opcode::Halt, 0, 0, 0),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::isa::{Inst, Opcode};

    #[test]
    fn test_demo_program_is_the_cells_the_committed_vectors_prove() {
        // The vectors under deployments/vectors/gate_vm/ were snarkjs-proved
        // against exactly these eight cells. Pinned as literals, not derived
        // from assemble(), because the point is to notice if the encoding
        // moves: a demo program that quietly re-encodes would leave the
        // registry's committed program_root pointing at nothing.
        assert_eq!(
            demo_program(),
            [2, 2186, 2186, 2186, 2186, 3584, 3584, 3584]
        );
    }

    #[test]
    fn test_padding_is_halt_not_zero() {
        let cells = assemble(&[Inst::new(Opcode::Move, 0, 0, 2)]);
        assert_eq!(cells[1..], [HALT_CELL; PROGRAM_LINES - 1]);
        assert_ne!(
            HALT_CELL, 0,
            "the padded cell must not alias the Move opcode"
        );
    }

    #[test]
    fn test_program_root_is_a_commitment() {
        let a = program_root(&assemble(&[
            Inst::new(Opcode::Move, 0, 0, 2),
            Inst::new(Opcode::Halt, 0, 0, 0),
        ]));
        let b = program_root(&assemble(&[
            Inst::new(Opcode::Move, 0, 0, 2),
            Inst::new(Opcode::Halt, 1, 0, 0),
        ]));
        assert_ne!(
            a, b,
            "two programs that differ only after the halt must still differ"
        );
    }
}
