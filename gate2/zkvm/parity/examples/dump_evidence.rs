//! Dump measured parity and determinism results as JSON, for `evidence.json`.
//!
//! The numbers in `evidence.json` come from running this - they are measured,
//! not transcribed by hand. Output is a determinism digest per vector; it is
//! not a proof and nobody verifies it. See STATUS.md.
//!
//! Usage: `cargo run -p gate-tier-parity --example dump_evidence`

use std::process::ExitCode;

fn main() -> ExitCode {
    // The workspace denies `unwrap`/`expect` outside tests, and an example is
    // outside tests. Reporting the failure and exiting non-zero is also simply
    // better behaviour for something a script may call.
    let outcomes = match gate_tier_parity::run_all() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("parity run failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    println!("[");
    for (i, o) in outcomes.iter().enumerate() {
        let comma = if i + 1 == outcomes.len() { "" } else { "," };
        println!(
            "  {{\"vector\": \"{}\", \"total_usdc\": {}, \"tier\": {}, \"trace_len\": {}, \
             \"gas_used\": {}, \"trace_hash\": \"{}\", \"deterministic\": {}}}{}",
            o.name,
            o.total_usdc,
            o.actual_tier,
            o.trace_len,
            o.gas_used,
            o.trace_hash,
            o.deterministic,
            comma
        );
    }
    println!("]");
    ExitCode::SUCCESS
}
