// ---------------------------------------------------------------------------
// QUARANTINED — NOT ON THE GATE PATH, NOTHING CLAIMED.
//
// This crate is the proof half of the imported source. It was brought across
// so the import stays byte-faithful and keeps compiling, NOT because Gate uses
// it. No Gate feature, contract, script or document depends on anything in
// here, and no Gate claim rests on it.
//
// What Gate actually uses from gate2/zkvm is the execution half — zk-isa,
// zk-vm, zk-compiler and parity — and what that half provides is deterministic
// execution and trace generation. Re-running the same program on the same
// input reproduces the same trace hash. That is repeatability, not a proof,
// not verified computation, and not a soundness statement.
//
// The boundary is enforced, not just described: parity/tests/quarantine.rs
// fails the build if any Gate-path crate takes a dependency on this package or
// names it in a `use`. Deleting this crate also fails that test, on purpose —
// quarantine means labelled and fenced, not removed.
//
// Promotion (wiring prove/verify into the Gate path) requires the upstream Z-B
// work to close AND a separate directive. Until both exist, treat everything
// below as inert reference material.
// ---------------------------------------------------------------------------
// Unsafe lock: this crate is at 0 unsafe today. The moment an `unsafe` block
// enters, the build FAILs (a regression gate). The same policy as the main crate.
#![forbid(unsafe_code)]
pub mod adapter;
pub mod alarm_log;
pub mod zk_stark;
pub mod canonical_boot;
pub mod canonical_recovery;
pub mod canonical_set;
pub mod plonky3_air;
pub mod plonky3_prover;
pub mod quarantine;
pub mod relayer;
pub mod transfer_verdict;

#[cfg(test)]
// Test-only module: it holds three `#[test]` functions and a helper they
// share, and nothing outside it references the module. It was compiled into
// the production build, which both grew the binary and exempted it from
// nothing - the panic gate flagged its `expect`s as production code.
#[cfg(test)]
pub mod trace_layout_tests;

pub use adapter::{
    event_digest_from_events, initial_state_root_of, memory_image_commitment_of_reads,
    register_image_commitment_of_reads, ExecutionPublicInputs, ProofEnvelope, ProverAdapter,
};
pub use plonky3_prover::Plonky3Adapter;
pub use plonky3_prover::Plonky3Adapter as DefaultAdapter;

pub use plonky3_prover::{initial_memory_reads, initial_register_reads};
