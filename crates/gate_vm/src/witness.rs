//! The witness emitter: turns a Receipt into the JSON `snarkjs` feeds the
//! circuit, and into the payload bytes the registry parses.
//!
//! The two outputs share one source of truth on purpose. The payload is what a
//! submitter claims; the witness is what the proof will show; any divergence
//! between them is caught by the registry re-deriving its public inputs from
//! the payload and binding them against the proof's. A tool that wrote the
//! claim from one trace and the witness from another would hand a prover a
//! way to disagree with itself.

use crate::field::Fp;
use crate::poseidon::poseidon2;
use crate::vm::{Receipt, Step};
use serde::Serialize;

/// Byte length of the registry payload for the vm lane:
/// height(u64) + program_root(32) + start(32) + event(32) + end(32) + steps(u64).
pub const PAYLOAD_LEN: usize = 8 + 32 * 4 + 8;

/// The lane's domain tag: `sha256("lumen-gate-vm-v1")[0..31]`, zero-padded
/// into the field — the exact rule `STEP_CHAIN_TAG_BYTES` documents for its
/// own lane. The circuit asserts this decimal value against the public
/// signal; the registry asserts it against public input #5; the emitter puts
/// it in the witness. Three readings of one constant, pinned in both
/// directions by tests on each side.
pub const DOMAIN_TAG_DEC: &str =
    "163132376849949675609651075788839912391573001044923200866693845321210504281";
pub const DOMAIN_TAG_HEX: &str = "005c546427e7cfce5fc9b9bbeed0c373681304aeea84dcf9d78146ee8419a459";

#[derive(Serialize)]
struct CircomInput {
    program: Vec<String>,
    pc: Vec<String>,
    regs: Vec<Vec<String>>,
    halted: Vec<String>,
    program_root: String,
    start_root: String,
    event_root: String,
    end_root: String,
    hash_steps: String,
    domain_tag: String,
}

/// All ten template inputs — the six publics included, because snarkjs
/// computes a witness for a *satisfied* circuit, not for a claim: the public
/// values arrive as inputs here and re-emerge in `public.json` from there.
/// Every number is a decimal string: no hex prefix convention can drift
/// between this file and ffutils.
pub fn circom_input(
    program: &[u16],
    steps: &[Step],
    start: &Fp,
    event: &Fp,
    receipt: &Receipt,
) -> String {
    if steps.last().map(|s| &s.regs[2]) != Some(&receipt.output) {
        // The circuit derives end_root from the LAST row's register file; if
        // the receipt's output and the trace's tail ever disagreed, the
        // witness would be silently unsatisfiable. Refuse at the source.
        panic!("internal: receipt output disagrees with the trace tail");
    }
    let input = CircomInput {
        program: program.iter().map(|cell| cell.to_string()).collect(),
        pc: steps.iter().map(|s| s.pc.to_string()).collect(),
        regs: steps
            .iter()
            .map(|s| s.regs.iter().map(Fp::to_decimal).collect())
            .collect(),
        halted: steps.iter().map(|s| (s.halted as u8).to_string()).collect(),
        program_root: crate::program::program_root(program).to_decimal(),
        start_root: start.to_decimal(),
        event_root: event.to_decimal(),
        end_root: receipt.output.to_decimal(),
        hash_steps: receipt.hash_steps.to_string(),
        domain_tag: DOMAIN_TAG_DEC.to_string(),
    };
    serde_json::to_string_pretty(&input).expect("plain json, no serializer failure")
}

/// The payload the registry parses: little-endian scalars, big-endian 32-byte
/// roots — the byte order every other lane in this repository already uses.
pub fn payload(height: u64, program: &[u16], start: &Fp, event: &Fp, receipt: &Receipt) -> Vec<u8> {
    let root = crate::program::program_root(program);
    let mut out = Vec::with_capacity(PAYLOAD_LEN);
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&root.to_bytes_be());
    out.extend_from_slice(&start.to_bytes_be());
    out.extend_from_slice(&event.to_bytes_be());
    out.extend_from_slice(&receipt.output.to_bytes_be());
    out.extend_from_slice(&receipt.hash_steps.to_le_bytes());
    out
}

/// The public inputs, in circuit order — exactly the `main {public [...]}`
/// declaration of `circuits/gate_vm.circom`, which is the order snarkjs
/// writes into `public.json` and the order the registry binds. Decimal
/// strings, matching what snarkjs emits, so a replay test can compare the
/// emitter's claim with the prover's output element for element.
pub fn public_inputs(program: &[u16], start: &Fp, event: &Fp, receipt: &Receipt) -> Vec<String> {
    let root = crate::program::program_root(program);
    vec![
        root.to_decimal(),
        start.to_decimal(),
        event.to_decimal(),
        receipt.output.to_decimal(),
        receipt.hash_steps.to_string(),
        DOMAIN_TAG_DEC.to_string(),
    ]
}

/// Recompute what the circuit will recompute for a claimed output — used by
/// the emitter's own self-check before it writes anything.
pub fn fold_chain(start: &Fp, event: &Fp, steps: u64) -> Fp {
    let mut acc = start.clone();
    for _ in 0..steps {
        acc = poseidon2(&acc, event);
    }
    acc
}
