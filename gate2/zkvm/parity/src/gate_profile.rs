//! The Gate-side closed opcode set (DIRECTIVE 2.0-ZKVM, rule 2).
//!
//! `VerifyMerkle` and the storage opcodes (`SRead`/`SWrite`) stay closed on
//! anything Gate compiles or decodes. Opening them needs a human decision, not
//! a code change made in passing.
//!
//! # Why this lives here instead of in `zk-isa`
//!
//! Measured behaviour of the imported ISA (see `evidence.json`, finding z10):
//!
//! | opcode | `IsaProfile::Production` | `MainnetActivation::default()` |
//! |---|---|---|
//! | `VerifyMerkle` | **accepted** | rejected |
//! | `SRead` / `SWrite` | **accepted** | **accepted** |
//!
//! `Opcode::is_experimental()` returns `false` for every opcode in this
//! revision, so `IsaProfile::Production` on its own refuses nothing, and the
//! mainnet activation gate says nothing about storage. Rule 2 asks for both to
//! be closed at the compile/decode stage.
//!
//! Changing `is_experimental()` in the imported crate would have been the
//! smaller diff, but storage opcodes are exercised by the imported prover and
//! VM suites; flipping the flag turns those green tests red for a reason that
//! has nothing to do with them. Rule 6 forbids reaching for a test to make a
//! gate fit. So the gate is enforced here, additively, on the Gate path only,
//! and the divergence from the source's own defaults is recorded rather than
//! hidden.

use zk_isa::{Instruction, IsaProfile, Opcode};

/// Opcodes Gate refuses to compile or decode, and why.
pub const CLOSED_OPCODES: [(&str, &str); 3] = [
    (
        "VerifyMerkle",
        "64-depth Merkle soundness (Z-B) is not closed in the source; the path \
         verification is unfinished",
    ),
    (
        "SRead",
        "persistent state is out of scope for the execution half; no state \
         crate is imported",
    ),
    (
        "SWrite",
        "persistent state is out of scope for the execution half; no state \
         crate is imported",
    ),
];

#[derive(Debug, PartialEq, Eq)]
pub enum GateIsaError {
    /// The opcode is closed on the Gate path.
    ClosedOpcode { opcode: Opcode, reason: &'static str },
    /// The word did not decode at all.
    Undecodable(String),
}

impl std::fmt::Display for GateIsaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GateIsaError::ClosedOpcode { opcode, reason } => write!(
                f,
                "opcode {opcode:?} is closed on the Gate path: {reason}. \
                 Opening it requires a human decision."
            ),
            GateIsaError::Undecodable(e) => write!(f, "instruction did not decode: {e}"),
        }
    }
}

impl std::error::Error for GateIsaError {}

/// Is this opcode closed on the Gate path?
pub fn is_closed(opcode: Opcode) -> Option<&'static str> {
    match opcode {
        Opcode::VerifyMerkle => Some(CLOSED_OPCODES[0].1),
        Opcode::SRead => Some(CLOSED_OPCODES[1].1),
        Opcode::SWrite => Some(CLOSED_OPCODES[2].1),
        _ => None,
    }
}

/// Decode one instruction word under the Gate profile.
///
/// Production ISA rules first, then the Gate closure on top.
pub fn decode(raw: u64) -> Result<Instruction, GateIsaError> {
    let inst = Instruction::decode_for_profile(raw, IsaProfile::Production)
        .map_err(|e| GateIsaError::Undecodable(format!("{e:?}")))?;
    if let Some(reason) = is_closed(inst.opcode) {
        return Err(GateIsaError::ClosedOpcode {
            opcode: inst.opcode,
            reason,
        });
    }
    Ok(inst)
}

/// Screen a whole bytecode image before it is allowed to run.
///
/// Returns the index of the first closed instruction, so a rejection can name
/// the offending word rather than just failing.
pub fn screen_program(program: &[u64]) -> Result<(), (usize, GateIsaError)> {
    for (i, raw) in program.iter().enumerate() {
        match decode(*raw) {
            Ok(_) => {}
            // A word that does not decode at all is not this gate's business:
            // padding and data words live in the same image. Only a decodable
            // instruction carrying a closed opcode is a refusal.
            Err(GateIsaError::Undecodable(_)) => {}
            Err(e @ GateIsaError::ClosedOpcode { .. }) => return Err((i, e)),
        }
    }
    Ok(())
}

/// Compile source under the Gate profile: the compiler's Production profile,
/// then a screen of the emitted image.
pub fn compile_screened(source: &str) -> Result<Vec<u64>, String> {
    let program = zk_compiler::compile(source, IsaProfile::Production)
        .map_err(|e| format!("compile failed: {e:?}"))?;
    screen_program(&program).map_err(|(i, e)| format!("instruction {i}: {e}"))?;
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(opcode: Opcode) -> u64 {
        Instruction {
            opcode,
            rd: 1,
            rs1: 2,
            rs2: 3,
            imm: 0,
        }
        .encode()
    }

    #[test]
    fn verify_merkle_is_refused_at_decode() {
        let err = decode(word(Opcode::VerifyMerkle)).unwrap_err();
        assert!(matches!(
            err,
            GateIsaError::ClosedOpcode {
                opcode: Opcode::VerifyMerkle,
                ..
            }
        ));
    }

    #[test]
    fn storage_opcodes_are_refused_at_decode() {
        for op in [Opcode::SRead, Opcode::SWrite] {
            let err = decode(word(op)).unwrap_err();
            assert!(
                matches!(err, GateIsaError::ClosedOpcode { .. }),
                "{op:?} should be closed on the Gate path"
            );
        }
    }

    #[test]
    fn a_program_carrying_a_closed_opcode_is_rejected_with_its_index() {
        let program = vec![
            word(Opcode::Add),
            word(Opcode::Mul),
            word(Opcode::SWrite),
            word(Opcode::Halt),
        ];
        let (idx, err) = screen_program(&program).unwrap_err();
        assert_eq!(idx, 2);
        assert!(matches!(
            err,
            GateIsaError::ClosedOpcode {
                opcode: Opcode::SWrite,
                ..
            }
        ));
    }

    #[test]
    fn ordinary_arithmetic_still_passes_the_gate() {
        for op in [
            Opcode::Add,
            Opcode::Sub,
            Opcode::Mul,
            Opcode::Lt,
            Opcode::Gte,
            Opcode::Jmp,
            Opcode::Log,
            Opcode::Halt,
        ] {
            assert!(decode(word(op)).is_ok(), "{op:?} should pass");
        }
    }

    #[test]
    fn the_tier_program_passes_the_gate_screen() {
        // The one program Gate actually runs must be clean under the closed
        // set - otherwise the parity demo would be relying on a gated opcode.
        let program = compile_screened(crate::GATE_TIER_SOURCE).expect("tier program is clean");
        assert!(!program.is_empty());
    }

    #[test]
    fn the_closed_set_is_exactly_three_opcodes() {
        // A guard against the set quietly growing or shrinking: rule 2 names
        // VerifyMerkle and Storage, and nothing else is closed here.
        assert_eq!(CLOSED_OPCODES.len(), 3);
        let closed_count = [
            Opcode::VerifyMerkle,
            Opcode::SRead,
            Opcode::SWrite,
            Opcode::Add,
            Opcode::Poseidon,
            Opcode::Syscall,
            Opcode::Log,
        ]
        .iter()
        .filter(|o| is_closed(**o).is_some())
        .count();
        assert_eq!(closed_count, 3);
    }
}
