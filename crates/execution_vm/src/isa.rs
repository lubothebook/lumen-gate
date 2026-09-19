//! The instruction set, its encoding, and decoding.
//!
//! The opcode numbers and the instruction encoding are the ones used by the
//! reference machine this lane's ISA is derived from: an opcode byte, then
//! two 5-bit register fields, then a signed 32-bit immediate, packed into one
//! 64-bit word. Keeping the numbers means a program written for the reference
//! encoding assembles to the same words here, and it makes the subset obvious:
//! every opcode this machine does not implement is a hole in a numbered table
//! rather than an invented scheme.
//!
//! # The subset, and why it is a subset
//!
//! Implemented: `Halt`, `Add`, `Sub`, `Mul`, `Eq`, `Lt`, `Jmp`, `Jnz`, `Load`,
//! `Store`, `Assert`. That is enough to write a real program with arithmetic,
//! comparison, branching, memory and a terminating condition -- which is what a
//! machine-shaped proof has to cover to be worth anything.
//!
//! Not implemented: `Div`, `Inv`, `And`, `Not`, `Neq`, `Gt`, `Lte`, `Gte`,
//! `Call`, `Ret`, `Push`, `Pop`, `Poseidon`, `Log`, `SRead`, `SWrite`,
//! `Syscall`, `VerifyMerkle`, `VerifyInference`, `PrivacyCommit`,
//! `NullifierCheck`, `SumConservation`. Decoding one of those is a hard refusal
//! ([`DECODE_ERROR_UNKNOWN_OPCODE`]), never a silent no-op, and the trace
//! checker refuses a row that claims one.

use serde::{Deserialize, Serialize};

/// Decoded to an opcode this machine does not implement. The value is the byte
/// that was decoded, so the message can name it.
pub const DECODE_ERROR_UNKNOWN_OPCODE: &str = "unknown_opcode";

/// Opcode of an instruction this machine implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Opcode {
    Halt,
    Add,
    Sub,
    Mul,
    Eq,
    Lt,
    Jmp,
    Jnz,
    Load,
    Store,
    Assert,
}

impl Opcode {
    /// The byte this opcode occupies in an instruction word.
    pub fn byte(self) -> u8 {
        match self {
            Opcode::Halt => 0x00,
            Opcode::Add => 0x01,
            Opcode::Sub => 0x02,
            Opcode::Mul => 0x03,
            Opcode::Eq => 0x0A,
            Opcode::Lt => 0x0C,
            Opcode::Jmp => 0x10,
            Opcode::Jnz => 0x11,
            Opcode::Load => 0x14,
            Opcode::Store => 0x15,
            Opcode::Assert => 0x18,
        }
    }

    /// Every opcode this machine implements, in numeric order.
    pub fn all() -> [Opcode; 11] {
        [
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
        ]
    }

    /// Decodes an opcode byte, refusing anything outside the subset.
    pub fn from_byte(byte: u8) -> Result<Opcode, String> {
        for candidate in Opcode::all() {
            if candidate.byte() == byte {
                return Ok(candidate);
            }
        }
        Err(format!("{DECODE_ERROR_UNKNOWN_OPCODE}:{byte:#04x}"))
    }

    /// Gas, as the reference machine charges it. Carried so that a program's
    /// cost is comparable to the ISA it was written for.
    pub fn gas(self) -> u64 {
        match self {
            Opcode::Halt => 0,
            Opcode::Add | Opcode::Sub | Opcode::Mul | Opcode::Eq | Opcode::Lt => 1,
            Opcode::Jmp | Opcode::Jnz | Opcode::Assert => 1,
            Opcode::Load | Opcode::Store => 3,
        }
    }

    /// Does this instruction write memory?
    pub fn is_memory_write(self) -> bool {
        matches!(self, Opcode::Store)
    }

    /// Does this instruction touch memory at all?
    pub fn is_memory(self) -> bool {
        matches!(self, Opcode::Load | Opcode::Store)
    }
}

/// One instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Instruction {
    pub opcode: Opcode,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub imm: i32,
}

impl Instruction {
    pub fn new(opcode: Opcode, rd: u8, rs1: u8, rs2: u8, imm: i32) -> Instruction {
        Instruction {
            opcode,
            rd,
            rs1,
            rs2,
            imm,
        }
    }

    /// Packs the instruction into the reference word layout.
    pub fn encode(self) -> u64 {
        let mut word = self.opcode.byte() as u64;
        word |= (self.rd as u64) << 8;
        word |= (self.rs1 as u64) << 13;
        word |= (self.rs2 as u64) << 18;
        word |= ((self.imm as u32) as u64) << 23;
        word
    }

    /// The instruction's fields as separate field elements, in the order the
    /// circuit takes them. `imm` is signed, so it is returned as an `i64` and
    /// the caller decides how to embed it.
    pub fn fields(self) -> (u8, u8, u8, u8, i32) {
        (self.opcode.byte(), self.rd, self.rs1, self.rs2, self.imm)
    }
}

/// Unpacks a word into an instruction, refusing an unimplemented opcode.
pub fn decode(word: u64) -> Result<Instruction, String> {
    let opcode = Opcode::from_byte((word & 0xFF) as u8)?;
    Ok(Instruction {
        opcode,
        rd: ((word >> 8) & 0x1F) as u8,
        rs1: ((word >> 13) & 0x1F) as u8,
        rs2: ((word >> 18) & 0x1F) as u8,
        imm: ((word >> 23) & 0xFFFF_FFFF) as u32 as i32,
    })
}

/// Packs an instruction into the reference word layout.
pub fn encode(instruction: &Instruction) -> u64 {
    instruction.encode()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_round_trips_through_the_reference_layout() {
        let instruction = Instruction::new(Opcode::Add, 1, 2, 3, -7);
        let word = instruction.encode();
        assert_eq!(word & 0xFF, 0x01, "opcode occupies the low byte");
        assert_eq!((word >> 8) & 0x1F, 1, "rd occupies the next five bits");
        assert_eq!((word >> 13) & 0x1F, 2, "rs1 follows rd");
        assert_eq!((word >> 18) & 0x1F, 3, "rs2 follows rs1");
        assert_eq!(decode(word).unwrap(), instruction, "a word decodes to itself");
    }

    #[test]
    fn unimplemented_opcodes_are_refused_rather_than_ignored() {
        // Div (0x04) exists in the reference instruction set and is not part of
        // this machine's subset. It must be a refusal: an unknown opcode that
        // decoded to something harmless would be a silent semantic change.
        let word = Instruction::new(Opcode::Halt, 0, 0, 0, 0).encode() | 0x04;
        let error = decode(word).unwrap_err();
        assert!(error.starts_with(DECODE_ERROR_UNKNOWN_OPCODE), "{error}");
    }

    #[test]
    fn every_implemented_opcode_has_a_distinct_byte() {
        let mut seen = std::collections::BTreeSet::new();
        for opcode in Opcode::all() {
            assert!(seen.insert(opcode.byte()), "{opcode:?} reuses a byte");
        }
    }
}
