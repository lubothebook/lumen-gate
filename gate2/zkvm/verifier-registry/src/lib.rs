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
//! # Verifier Registry - Generic RoleId-based Staking + Slashing Primitive
//!
//! A standalone, domain-agnostic registry for the prover's multi-domain L1.
//! Any role - Master Verifier, Relayer, Attester, Storage Operator, AI Verifier,
//! Or a future caller-defined role - shares **one** registry, **one** staking
//! Mechanism, and **one** slashing pipeline. There is no per-role bespoke code.
//!
//! ## Design principles
//!
//! 1. **Permissionless entry.** The ONLY gate is meeting the `min_stake` floor.
//!    There is no whitelist, no admin approval, no central gate.
//! 2. **Open role set.** [`RoleId`] is a `u32` newtype, not an enum. New roles
//!    Can be introduced without changing this crate.
//! 3. **Cross-role slashing.** Slashing one role automatically jails all other
//!    Roles held by the same address - economic security is per-address, not
//!    Per-role.
//! 4. **Evidence-gated slashing.** Slashing requires a structurally valid AND
//!    Consensus-verified [`SlashingReport`]. Unverified reports are accepted
//!    (for the permissionless RPC endpoint) but never acted on.
//! 5. **Deterministic state root.** `state_root` produces a domain-separated
//!    SHA-256 hash suitable for snapshot and consensus commitment.

pub mod address;
pub mod evidence;
pub mod params;
pub mod registry;
pub mod role;

pub use address::Address;
pub use evidence::{EvidenceError, ProofProvenance, SlashingProof, SlashingReport};
pub use params::RegistryParams;
pub use registry::{
    MemberStatus, Registration, RegistryError, SlashOutcome, SlashingCondition, VerifierRegistry,
    MIN_REGISTRATION_STAKE, UNBONDING_EPOCHS,
};
pub use role::{roles, RoleId};
