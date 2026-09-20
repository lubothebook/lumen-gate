//! Gate tier parity and determinism harness.
//!
//! This crate runs `programs/gate_tier.zkl` on the execution VM over the shared
//! vector file `vectors/tier_vectors.json` and checks two things:
//!
//! 1. **Parity** - the tier the VM computes equals the tier the vector expects,
//!    and those are the same thresholds the Soroban `gate_campaign_example`
//!    contract applies. The Soroban side reads the *same JSON file* in its own
//!    unit test, so neither side can drift without the other going red.
//! 2. **Determinism** - the same program over the same input produces the same
//!    execution trace, attested by a hash over the trace rows.
//!
//! # What this is not
//!
//! The trace hash here is a **determinism digest**, not a proof and not a
//! commitment anyone verifies. Nothing in this crate proves that the execution
//! was correct to a third party; it only shows that two runs of the same input
//! produced the same rows. No output reaches a contract, a router or a web
//! flow. See `STATUS.md`.

pub mod gate_profile;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zk_vm::{ExecutionReceipt, Vm};

/// The tier program source, compiled in at build time so the harness and the
/// file on disk can never disagree.
pub const GATE_TIER_SOURCE: &str = include_str!("../../programs/gate_tier.zkl");

/// The shared vector file. The Soroban side reads the same path.
pub const TIER_VECTORS_JSON: &str = include_str!("../../vectors/tier_vectors.json");

/// Memory size for a run. The tier program touches no memory; this is the
/// smallest comfortable arena.
const MEMORY_SIZE: usize = 1024;

/// Gas ceiling for a single tier evaluation. Generous relative to the ~20
/// instructions the program emits, low enough that a runaway loop is caught.
const GAS_LIMIT: u64 = 100_000;

#[derive(Debug, Clone, Deserialize)]
pub struct TierVector {
    pub name: String,
    pub total_usdc: u64,
    pub expected_tier: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Thresholds {
    pub bronze: u64,
    pub silver: u64,
    pub gold: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TierVectorFile {
    pub schema: String,
    pub thresholds: Thresholds,
    pub vectors: Vec<TierVector>,
}

#[derive(Debug)]
pub enum ParityError {
    Compile(String),
    Vectors(String),
    Execution { vector: String, reason: String },
    Mismatch {
        vector: String,
        input: u64,
        expected: u64,
        actual: u64,
    },
    NoTierEvent { vector: String },
    Nondeterministic {
        vector: String,
        first: String,
        second: String,
    },
}

impl std::fmt::Display for ParityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParityError::Compile(e) => write!(f, "compile failed: {e}"),
            ParityError::Vectors(e) => write!(f, "vector file unreadable: {e}"),
            ParityError::Execution { vector, reason } => {
                write!(f, "vector `{vector}`: execution failed: {reason}")
            }
            ParityError::Mismatch {
                vector,
                input,
                expected,
                actual,
            } => write!(
                f,
                "vector `{vector}`: total_usdc={input} expected tier {expected}, VM produced {actual}"
            ),
            ParityError::NoTierEvent { vector } => {
                write!(f, "vector `{vector}`: program emitted no tier event")
            }
            ParityError::Nondeterministic {
                vector,
                first,
                second,
            } => write!(
                f,
                "vector `{vector}`: trace hash changed between runs: {first} != {second}"
            ),
        }
    }
}

impl std::error::Error for ParityError {}

/// One vector's result: the tier the VM produced and the determinism digest of
/// its execution trace.
#[derive(Debug, Clone)]
pub struct VectorOutcome {
    pub name: String,
    pub total_usdc: u64,
    pub expected_tier: u64,
    pub actual_tier: u64,
    pub trace_hash: String,
    pub trace_len: u64,
    pub gas_used: u64,
    /// True when a second identical run produced the same trace hash.
    pub deterministic: bool,
}

/// Parse the shared vector file.
pub fn load_vectors() -> Result<TierVectorFile, ParityError> {
    serde_json::from_str(TIER_VECTORS_JSON).map_err(|e| ParityError::Vectors(e.to_string()))
}

/// Compile the tier program under the Gate profile.
///
/// That is the imported compiler's **Production** profile plus the Gate closed
/// set (`VerifyMerkle`, `SRead`, `SWrite`) screened over the emitted image.
/// The extra screen is not decoration: measured, `IsaProfile::Production` alone
/// refuses none of those three. See `gate_profile` and finding z10.
pub fn compile_tier_program() -> Result<Vec<u64>, ParityError> {
    gate_profile::compile_screened(GATE_TIER_SOURCE).map_err(ParityError::Compile)
}

/// Run the compiled program with `total_usdc` supplied through the sender
/// syscall, and return the raw receipt.
pub fn run_with_total(program: &[u64], total_usdc: u64) -> ExecutionReceipt {
    let mut vm = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
    vm.context.sender = total_usdc;
    vm.run_receipt(program)
}

/// Determinism digest over the execution trace.
///
/// Every row contributes the fields that define what the VM did: the program
/// counter pair, the encoded instruction, the operand slots and their values.
/// Two runs that differ anywhere in that sequence produce different digests.
///
/// This is a self-consistency check. It is not a commitment a verifier checks
/// and it proves nothing to a third party.
pub fn trace_digest(vm: &Vm) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gate-tier-trace/v1");
    hasher.update((vm.trace.len() as u64).to_le_bytes());
    for step in &vm.trace {
        hasher.update((step.pc as u64).to_le_bytes());
        hasher.update((step.next_pc as u64).to_le_bytes());
        hasher.update((step.instruction.opcode as u8).to_le_bytes());
        hasher.update(step.instruction.rd.to_le_bytes());
        hasher.update(step.instruction.rs1.to_le_bytes());
        hasher.update(step.instruction.rs2.to_le_bytes());
        hasher.update(step.instruction.imm.to_le_bytes());
        hasher.update(step.src1_idx.to_le_bytes());
        hasher.update(step.src2_idx.to_le_bytes());
        hasher.update(step.dst_idx.to_le_bytes());
        hasher.update(step.src1_val.to_le_bytes());
        hasher.update(step.src2_val.to_le_bytes());
        hasher.update(step.dst_val.to_le_bytes());
    }
    let out = hasher.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// Run one vector twice: once for the answer, once to confirm the trace is
/// reproducible.
pub fn evaluate_vector(program: &[u64], vector: &TierVector) -> Result<VectorOutcome, ParityError> {
    let mut vm = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
    vm.context.sender = vector.total_usdc;
    let receipt = vm.run_receipt(program);

    if !receipt.success {
        return Err(ParityError::Execution {
            vector: vector.name.clone(),
            reason: format!("{:?}", receipt.error),
        });
    }

    let actual_tier = *receipt
        .events
        .last()
        .ok_or_else(|| ParityError::NoTierEvent {
            vector: vector.name.clone(),
        })?;

    if actual_tier != vector.expected_tier {
        return Err(ParityError::Mismatch {
            vector: vector.name.clone(),
            input: vector.total_usdc,
            expected: vector.expected_tier,
            actual: actual_tier,
        });
    }

    let first_hash = trace_digest(&vm);

    // Second identical run - determinism is the claim being tested, so it is
    // measured rather than assumed.
    let mut vm2 = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
    vm2.context.sender = vector.total_usdc;
    let receipt2 = vm2.run_receipt(program);
    let second_hash = trace_digest(&vm2);

    if first_hash != second_hash || receipt2.events.last() != Some(&actual_tier) {
        return Err(ParityError::Nondeterministic {
            vector: vector.name.clone(),
            first: first_hash,
            second: second_hash,
        });
    }

    Ok(VectorOutcome {
        name: vector.name.clone(),
        total_usdc: vector.total_usdc,
        expected_tier: vector.expected_tier,
        actual_tier,
        trace_hash: first_hash,
        trace_len: receipt.trace_len,
        gas_used: receipt.gas_used,
        deterministic: true,
    })
}

/// Run every vector in the shared file.
pub fn run_all() -> Result<Vec<VectorOutcome>, ParityError> {
    let file = load_vectors()?;
    let program = compile_tier_program()?;
    file.vectors
        .iter()
        .map(|v| evaluate_vector(&program, v))
        .collect()
}

/// The tier ladder as the Soroban contract states it, re-expressed here so the
/// harness can check the vector file itself is consistent with the thresholds
/// it declares (a vector file that disagrees with its own thresholds would make
/// the parity test meaningless).
pub fn expected_tier_for(total: u64, t: &Thresholds) -> u64 {
    if total >= t.gold {
        3
    } else if total >= t.silver {
        2
    } else if total >= t.bronze {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_file_is_self_consistent() {
        let file = load_vectors().expect("vector file parses");
        assert_eq!(file.schema, "gate-tier-parity/v1");
        for v in &file.vectors {
            assert_eq!(
                expected_tier_for(v.total_usdc, &file.thresholds),
                v.expected_tier,
                "vector `{}` disagrees with the thresholds the file declares",
                v.name
            );
        }
    }

    #[test]
    fn thresholds_match_the_soroban_contract() {
        // gate2/soroban/gate_campaign_example/src/lib.rs:
        //   const BRONZE: i128 = 10 * 1_000_000;
        //   const SILVER: i128 = 100 * 1_000_000;
        //   const GOLD:   i128 = 1_000 * 1_000_000;
        let file = load_vectors().expect("vector file parses");
        assert_eq!(file.thresholds.bronze, 10 * 1_000_000);
        assert_eq!(file.thresholds.silver, 100 * 1_000_000);
        assert_eq!(file.thresholds.gold, 1_000 * 1_000_000);
    }

    #[test]
    fn tier_program_compiles_under_production_profile() {
        let program = compile_tier_program().expect("gate_tier.zkl compiles");
        assert!(!program.is_empty());
    }

    #[test]
    fn every_vector_matches_and_is_deterministic() {
        let outcomes = run_all().expect("all vectors pass");
        let file = load_vectors().expect("vector file parses");
        assert_eq!(outcomes.len(), file.vectors.len());
        for o in &outcomes {
            assert_eq!(o.actual_tier, o.expected_tier, "vector `{}`", o.name);
            assert!(o.deterministic, "vector `{}` was not deterministic", o.name);
            assert_eq!(o.trace_hash.len(), 64);
        }
    }

    #[test]
    fn boundary_values_land_on_the_right_rung() {
        let program = compile_tier_program().expect("compiles");
        // One below and one at each threshold - the case the directive calls out.
        let cases: [(u64, u64); 8] = [
            (9_999_999, 0),
            (10_000_000, 1),
            (99_999_999, 1),
            (100_000_000, 2),
            (999_999_999, 2),
            (1_000_000_000, 3),
            (0, 0),
            (1_000_000_000_000, 3),
        ];
        for (total, expected) in cases {
            let receipt = run_with_total(&program, total);
            assert!(receipt.success, "total={total} failed to execute");
            assert_eq!(
                receipt.events.last().copied(),
                Some(expected),
                "total={total}"
            );
        }
    }

    #[test]
    fn identical_input_gives_an_identical_trace_hash() {
        let program = compile_tier_program().expect("compiles");
        let mut a = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
        a.context.sender = 100_000_000;
        let _ = a.run_receipt(&program);

        let mut b = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
        b.context.sender = 100_000_000;
        let _ = b.run_receipt(&program);

        assert_eq!(trace_digest(&a), trace_digest(&b));
    }

    #[test]
    fn different_input_gives_a_different_trace_hash() {
        // Determinism must not degenerate into "every run hashes the same".
        let program = compile_tier_program().expect("compiles");
        let mut a = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
        a.context.sender = 10_000_000;
        let _ = a.run_receipt(&program);

        let mut b = Vm::with_gas_limit(MEMORY_SIZE, GAS_LIMIT);
        b.context.sender = 1_000_000_000;
        let _ = b.run_receipt(&program);

        assert_ne!(trace_digest(&a), trace_digest(&b));
    }

    #[test]
    fn exhausted_gas_is_a_refusal_not_a_partial_answer() {
        // Gas ceiling below what the program needs: the VM must report failure
        // and must not hand back a tier.
        let program = compile_tier_program().expect("compiles");
        let mut vm = Vm::with_gas_limit(MEMORY_SIZE, 5);
        vm.context.sender = 1_000_000_000;
        let receipt = vm.run_receipt(&program);
        assert!(!receipt.success);
        assert!(matches!(receipt.error, Some(zk_vm::VmError::OutOfGas)));
    }
}
