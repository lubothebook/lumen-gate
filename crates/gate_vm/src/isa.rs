//! The gate VM instruction set: opcodes, the packed program cell format, and
//! the encoding rules the circuit relies on.
//!
//! One program cell is four 3-bit fields packed into a single field element:
//!
//! ```text
//! cell = op * 2^9 + a * 2^6 + b * 2^3 + c
//! ```
//!
//! Packing into one cell is not decoration: the circuit commits the program by
//! folding one Poseidon permutation per cell, so fewer cells means a cheaper
//! root for the same program size. The 3-bit fields are the machine's entire
//! address space, and the circuit's bit decomposition of the selected cell is
//! what makes every reference in-range: an out-of-range index is not a state
//! the machine can enter, it is an unsatisfiable witness.
//!
//! The machine operates over BN254 scalar-field elements. There is deliberately
//! no fixed word width for values: field addition has no wrap-around, so the
//! "arithmetic overflow" class of bug that a 64-bit VM must constrain does not
//! exist here; a SUB is constrained as `r[c] + r[b] == r[a]`, which pins the
//! direction and rules out two representations of the same difference.

/// Number of program lines the machine can address (= 2^3).
pub const PROGRAM_LINES: usize = 8;
/// Number of registers (= 2^3).
pub const REGISTERS: usize = 8;
/// The execution window: steps the trace carries, including the halting one.
pub const DEFAULT_STEPS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
    /// r[c] = r[a]
    Move = 0,
    /// r[c] = r[a] + r[b]
    Add = 1,
    /// r[c] = r[a] - r[b], constrained as r[c] + r[b] == r[a]
    Sub = 2,
    /// r[c] = r[a] * r[b]
    Mul = 3,
    /// r[c] = Poseidon(r[a], r[b]) — the circuit's own permutation, so the
    /// hash the machine performs and the hash the verifier constrains are
    /// literally the same object.
    Pose = 4,
    /// Fail the trace unless r[a] == r[b]. A convenience for programs that
    /// want intermediate assertions; soundness of a lane binds to the outputs,
    /// not to whether this opcode appears.
    AssertEq = 5,
    /// If r[a] != 0, jump to line b; else continue. This is what makes the
    /// machine a machine: the same program cell can execute more than once.
    JumpNZ = 6,
    /// Stop. The trace requires it inside the window; running out of steps
    /// without halting is the VM's bounded-gas failure, stated plainly.
    Halt = 7,
}

impl Opcode {
    pub fn from_u8(v: u8) -> Option<Opcode> {
        match v {
            0 => Some(Opcode::Move),
            1 => Some(Opcode::Add),
            2 => Some(Opcode::Sub),
            3 => Some(Opcode::Mul),
            4 => Some(Opcode::Pose),
            5 => Some(Opcode::AssertEq),
            6 => Some(Opcode::JumpNZ),
            7 => Some(Opcode::Halt),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// One decoded instruction. All operands are 3-bit: the register file and the
/// line space share the same address width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inst {
    pub op: Opcode,
    pub a: u8,
    pub b: u8,
    pub c: u8,
}

impl Inst {
    pub fn new(op: Opcode, a: u8, b: u8, c: u8) -> Inst {
        for operand in [a, b, c] {
            assert!(operand < 8, "operand out of the 3-bit address space");
        }
        Inst { op, a, b, c }
    }

    pub fn encode(&self) -> u16 {
        (u16::from(self.op.as_u8()) << 9) | (u16::from(self.a) << 6) | (u16::from(self.b) << 3) | u16::from(self.c)
    }

    pub fn decode(cell: u16) -> Option<Inst> {
        // The circuit bit-decomposes each cell into exactly 12 bits; a cell
        // with any higher bit set is not an encoding the machine can enter,
        // even though the masks below would happily read a value out of it.
        if cell >> 12 != 0 {
            return None;
        }
        Some(Inst {
            op: Opcode::from_u8(((cell >> 9) & 7) as u8)?,
            a: ((cell >> 6) & 7) as u8,
            b: ((cell >> 3) & 7) as u8,
            c: (cell & 7) as u8,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        for op in 0u8..8 {
            for a in 0u8..8 {
                let inst = Inst::new(Opcode::from_u8(op).unwrap(), a, 7 - a, a % 8);
                let cell = inst.encode();
                assert_eq!(Inst::decode(cell), Some(inst));
            }
        }
        assert_eq!(Inst::decode(1u16 << 12), None); // bit 12 set: op field would be 8
        assert_eq!(Inst::decode(u16::MAX).map(|i| i.op.as_u8()), None);
    }
}
