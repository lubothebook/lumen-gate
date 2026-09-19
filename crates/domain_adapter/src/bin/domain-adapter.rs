//! Reads a proof document from the source chain and answers with an
//! attestation or a refusal.
//!
//! This is the off-chain half of the boundary: it exists so that a payload can
//! be judged before anybody spends a fee on it, and so that the judgement is a
//! re-runnable command instead of a paragraph in a README.
//!
//! Usage:
//!   curl -s "$SIM_URL/proof?height=1&kind=bls" | domain-adapter verify
//!   domain-adapter verify --proof proof.json --min-height 5
//!   domain-adapter verify --proof proof.json --require-slashable   # refuses
//!   domain-adapter describe
//!
//! Exit codes: 0 accepted, 1 refused, 2 the input could not be read at all.
//! A refusal is a normal, expected outcome and is reported on stdout as JSON.

use domain_adapter::source_chain::{SourceChainBlsAdapter, ADAPTER_NAME};
use domain_adapter::{AdapterError, FinalityAdapter, RawEvidence, VerificationPolicy};
use serde::Deserialize;
use std::io::Read;

/// The proof document the source chain serves, in the fields this tool reads.
#[derive(Debug, Deserialize)]
struct ProofDocument {
    adapter_id: String,
    network: String,
    evidence_version: u32,
    declared_height: u64,
    declared_root: String,
    payload_hex: String,
    #[serde(default)]
    submitter: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("verify");

    let adapter = SourceChainBlsAdapter::new();

    match command {
        "describe" => {
            let descriptor = adapter.descriptor();
            println!(
                "{}",
                serde_json::to_string_pretty(&descriptor).expect("descriptor serialises")
            );
        }
        "verify" => {
            let mut proof_path: Option<String> = None;
            let mut min_height = 0u64;
            let mut require_slashable = false;
            let mut max_age: Option<u64> = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--proof" => {
                        proof_path = args.get(index + 1).cloned();
                        index += 2;
                    }
                    "--min-height" => {
                        min_height = args
                            .get(index + 1)
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                        index += 2;
                    }
                    "--max-age" => {
                        max_age = args.get(index + 1).and_then(|v| v.parse().ok());
                        index += 2;
                    }
                    "--require-slashable" => {
                        require_slashable = true;
                        index += 1;
                    }
                    _ => index += 1,
                }
            }

            let text = match read_input(proof_path.as_deref()) {
                Ok(text) => text,
                Err(reason) => {
                    eprintln!("could not read the proof document: {reason}");
                    std::process::exit(2);
                }
            };
            let document: ProofDocument = match serde_json::from_str(&text) {
                Ok(document) => document,
                Err(error) => {
                    eprintln!("the proof document is not the shape this tool reads: {error}");
                    std::process::exit(2);
                }
            };

            let evidence = match to_evidence(&document) {
                Ok(evidence) => evidence,
                Err(reason) => {
                    eprintln!("the proof document could not be turned into evidence: {reason}");
                    std::process::exit(2);
                }
            };

            let policy = VerificationPolicy {
                min_height,
                require_declared_match: true,
                max_age: max_age.unwrap_or(u64::MAX),
                now: document.declared_height,
                require_slashable,
            };

            match adapter.verify(&evidence, &policy) {
                Ok(attestation) => {
                    let report = serde_json::json!({
                        "verdict": "accepted",
                        "adapter": ADAPTER_NAME,
                        "attestation": attestation,
                        "profile_facts": attestation.profile_facts(),
                        "note": "an attestation is not a settlement decision: the pairing check runs inside the Soroban contract, which is where value moves",
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&report).expect("report serialises")
                    );
                }
                Err(refusal) => {
                    let report = serde_json::json!({
                        "verdict": "refused",
                        "adapter": ADAPTER_NAME,
                        "refusal": refusal,
                        "note": "nothing was submitted and no fee was spent",
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&report).expect("report serialises")
                    );
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown command {other}: try `verify` or `describe`");
            std::process::exit(2);
        }
    }
}

fn read_input(path: Option<&str>) -> Result<String, String> {
    match path {
        Some(path) => std::fs::read_to_string(path).map_err(|error| error.to_string()),
        None => {
            let mut buffer = String::new();
            std::io::stdin()
                .read_to_string(&mut buffer)
                .map_err(|error| error.to_string())?;
            if buffer.trim().is_empty() {
                return Err(
                    "no proof document on stdin; pipe one in or pass --proof <file>".to_string(),
                );
            }
            Ok(buffer)
        }
    }
}

fn to_evidence(document: &ProofDocument) -> Result<RawEvidence, String> {
    let adapter_bytes = hex::decode(&document.adapter_id).map_err(|error| error.to_string())?;
    if adapter_bytes.len() != 32 {
        return Err(format!(
            "adapter_id must be 32 bytes, found {}",
            adapter_bytes.len()
        ));
    }
    let mut adapter_id = [0u8; 32];
    adapter_id.copy_from_slice(&adapter_bytes);

    let root_bytes = hex::decode(&document.declared_root).map_err(|error| error.to_string())?;
    if root_bytes.len() != 32 {
        return Err(format!(
            "declared_root must be 32 bytes, found {}",
            root_bytes.len()
        ));
    }
    let mut declared_root = [0u8; 32];
    declared_root.copy_from_slice(&root_bytes);

    let payload = hex::decode(&document.payload_hex).map_err(|error| error.to_string())?;

    Ok(RawEvidence {
        adapter_id: domain_adapter::AdapterId(adapter_id),
        evidence_version: document.evidence_version,
        network: document.network.clone(),
        payload,
        declared_height: document.declared_height,
        declared_root,
        submitter: document
            .submitter
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
    })
}

/// Kept so the refusal type is part of this tool's public shape: a caller that
/// wants to branch on the refusal can match on it instead of parsing text.
#[allow(dead_code)]
fn describe_refusal(refusal: &AdapterError) -> String {
    refusal.to_string()
}
