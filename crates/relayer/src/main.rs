// Clippy's argument-count and type-complexity caps exist for code where a
// struct would clarify; here the argument list IS the specification - a
// verifier's public inputs and a transaction builder's envelope fields read
// clearer inline than buried in a wrapper type. The lint is allowed at the
// crate root, once, with this reason, rather than silently at call sites.
#![allow(clippy::too_many_arguments, clippy::type_complexity)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::convert::TryInto;
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

#[derive(Deserialize, Debug)]
struct Block {
    height: u64,
    state_root: String,
    event_root: String,
}

#[derive(Deserialize, Debug, Clone)]
struct LockEvent {
    message_id: String,
    payload_hash: String,
    amount: u64,
    recipient_on_source: String,
    sender_on_source: String,
    height: u64,
    event_index: u32,
    nonce: u64,
    expiry_height: u64,
}

#[derive(Deserialize, Debug, Clone)]
struct BlsPayloadDecoded {
    height: u64,
    state_root: String,
    event_root: String,
    signer_count: u32,
    required: u32,
    sig_hex: String,
    pubkey_hex: String,
}

#[derive(Deserialize, Debug, Clone)]
struct ProofResponse {
    adapter_id: String,
    network: String,
    evidence_version: u32,
    declared_height: u64,
    declared_root: String,
    payload_hex: String,
    payload: BlsPayloadDecoded,
    submitter: String,
    proof_hex: Option<String>,
    public_inputs: Option<Vec<String>>,
    vk_hex: Option<String>,
    merkle_proof: Option<Vec<String>>,
}

#[derive(Serialize)]
struct SorobanRpcRequest {
    jsonrpc: String,
    id: u32,
    method: String,
    params: serde_json::Value,
}

/// The deployment manifest (`deployments/testnet.json`) is the source of truth
/// for addresses, so the relayer reads it instead of trusting the operator's
/// environment. Contract entries are objects carrying a `contract_id`; a bare
/// string is accepted as well so hand-written manifests keep working.
#[derive(Deserialize, Debug)]
struct Deployment {
    network: String,
    rpc_url: String,
    #[serde(default)]
    contracts: HashMap<String, serde_json::Value>,
    #[serde(default)]
    accounts: HashMap<String, String>,
    #[serde(default)]
    domain: Option<ManifestDomain>,
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    target_domain: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ManifestDomain {
    domain_key: Option<String>,
}

impl Deployment {
    /// First key that resolves to a contract id wins, so renaming an entry in
    /// the manifest cannot silently leave the relayer pointing at nothing.
    fn contract(&self, keys: &[&str]) -> Option<String> {
        for key in keys {
            if let Some(value) = self.contracts.get(*key) {
                if let Some(id) = value.as_str() {
                    return Some(id.to_string());
                }
                if let Some(id) = value.get("contract_id").and_then(|value| value.as_str()) {
                    return Some(id.to_string());
                }
            }
        }
        None
    }
    /// Same first-key-wins rule as `contract`, for operator accounts. The
    /// relayer's own address matters: it is the fee recipient of a gasless
    /// mint, and a placeholder there is how an operator pays without being
    /// repaid. The manifest names it, so the manifest is consulted before the
    /// broken default is used.
    fn account(&self, keys: &[&str]) -> Option<String> {
        for key in keys {
            if let Some(value) = self.accounts.get(*key) {
                if !value.is_empty() && !is_placeholder(value) {
                    return Some(value.clone());
                }
            }
        }
        None
    }
}

fn is_placeholder(value: &str) -> bool {
    value.contains("PLACEHOLDER") || value.contains("REPLACE-ME") || value.starts_with("CD-")
}

#[derive(Debug, Clone, Serialize)]
struct BurnUnlockRequest {
    burn_message_id: String,
    amount: u64,
    source_height: u64,
    nonce: u64,
    expiry_height: u64,
    recipient_on_source: String,
    payload_hash: String,
    target_domain: String,
}

#[derive(Debug, Clone)]
struct BurnEvent {
    burn_message_id: String,
    amount: u64,
    source_height: u64,
    nonce: u64,
    expiry_height: u64,
    recipient_on_source: String,
    payload_hash: String,
    target_domain: String,
}

fn decode_scval_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    // SCVal::Bytes XDR: enum tag SCV_BYTES (13), uint32 length, then padded bytes.
    let raw = BASE64
        .decode(encoded)
        .map_err(|error| format!("invalid event XDR base64: {error}"))?;
    if raw.len() < 8 || u32::from_be_bytes(raw[0..4].try_into().unwrap()) != 13 {
        return Err("event value is not SCV_BYTES".to_string());
    }
    let len = u32::from_be_bytes(raw[4..8].try_into().unwrap()) as usize;
    let end = 8usize
        .checked_add(len)
        .ok_or_else(|| "event byte length overflow".to_string())?;
    if end > raw.len() {
        return Err("event byte value is truncated".to_string());
    }
    Ok(raw[8..end].to_vec())
}

fn decode_burn_event(burn_message_id: String, encoded_value: &str) -> Result<BurnEvent, String> {
    // Must match settlement_gateway::encode_burn_event exactly.
    let bytes = decode_scval_bytes(encoded_value)?;
    if bytes.len() < 108 {
        return Err("burn event payload is too short".to_string());
    }
    let amount_i128 = i128::from_le_bytes(bytes[0..16].try_into().unwrap());
    if amount_i128 <= 0 || amount_i128 > u64::MAX as i128 {
        return Err("burn event amount is outside source simulator range".to_string());
    }
    let source_height = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
    let nonce = u64::from_le_bytes(bytes[24..32].try_into().unwrap());
    let expiry_height = u64::from_le_bytes(bytes[32..40].try_into().unwrap());
    if source_height > expiry_height {
        return Err("burn event is expired".to_string());
    }
    let target_domain = hex::encode(&bytes[40..72]);
    let payload_hash = hex::encode(&bytes[72..104]);
    let recipient_len = u32::from_le_bytes(bytes[104..108].try_into().unwrap()) as usize;
    let end = 108usize
        .checked_add(recipient_len)
        .ok_or_else(|| "burn recipient length overflow".to_string())?;
    if end != bytes.len() {
        return Err("burn event recipient length does not match payload".to_string());
    }
    let recipient_on_source = String::from_utf8(bytes[108..end].to_vec())
        .map_err(|error| format!("burn recipient is not UTF-8: {error}"))?;
    Ok(BurnEvent {
        burn_message_id,
        amount: amount_i128 as u64,
        source_height,
        nonce,
        expiry_height,
        recipient_on_source,
        payload_hash,
        target_domain,
    })
}

#[derive(Deserialize)]
struct RpcEvent {
    #[serde(default)]
    topic: Vec<String>,
    value: String,
}

async fn poll_burn_events(
    client: &reqwest::Client,
    rpc_url: &str,
    gateway_id: &str,
    cursor: &mut u64,
) -> Result<Vec<BurnEvent>, String> {
    let request = SorobanRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: 42,
        method: "getEvents".to_string(),
        params: serde_json::json!({
            "startLedger": *cursor,
            "filters": [{
                "type": "contract",
                "contractIds": [gateway_id],
                "topics": [["AAAADwAAAARidXJu", "*"]]
            }],
            "pagination": {"limit": 100}
        }),
    };
    let response = client
        .post(rpc_url)
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("burn event RPC request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("burn event RPC returned {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("invalid burn event RPC JSON: {error}"))?;
    if let Some(error) = value.get("error") {
        return Err(format!("burn event RPC error: {error}"));
    }
    let result = value
        .get("result")
        .ok_or_else(|| "burn event RPC response has no result".to_string())?;
    if let Some(latest) = result.get("latestLedger").and_then(|v| v.as_u64()) {
        *cursor = latest.saturating_add(1);
    }
    let events: Vec<RpcEvent> = serde_json::from_value(
        result
            .get("events")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| format!("invalid burn event list: {error}"))?;
    let mut burns = Vec::new();
    for event in events {
        if event.topic.len() < 2 {
            continue;
        }
        let topic = decode_scval_bytes(&event.topic[1])?;
        if topic.len() != 32 {
            return Err("burn event message id is not 32 bytes".to_string());
        }
        burns.push(decode_burn_event(hex::encode(topic), &event.value)?);
    }
    Ok(burns)
}

async fn unlock_source_from_burn(
    client: &reqwest::Client,
    sim_url: &str,
    burn: &BurnEvent,
) -> Result<(), String> {
    let request = BurnUnlockRequest {
        burn_message_id: burn.burn_message_id.clone(),
        amount: burn.amount,
        source_height: burn.source_height,
        nonce: burn.nonce,
        expiry_height: burn.expiry_height,
        recipient_on_source: burn.recipient_on_source.clone(),
        payload_hash: burn.payload_hash.clone(),
        target_domain: burn.target_domain.clone(),
    };
    let response = client
        .post(format!("{sim_url}/burn-unlock"))
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("source burn unlock request failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("source burn unlock returned {status}: {body}"));
    }
    println!(
        "  source unlock receipt for burn {}: {}",
        burn.burn_message_id, body
    );
    Ok(())
}

async fn check_rpc(client: &reqwest::Client, rpc_url: &str) -> Result<u64, String> {
    let request = SorobanRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: 1,
        method: "getLatestLedger".to_string(),
        params: serde_json::json!({}),
    };
    let response = client
        .post(rpc_url)
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("Soroban RPC request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Soroban RPC returned {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("invalid RPC JSON: {error}"))?;
    if value.get("error").is_some() {
        return Err(format!("Soroban RPC error: {value}"));
    }
    let latest = value
        .get("result")
        .and_then(|result| result.get("sequence"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Soroban RPC getLatestLedger omitted result.sequence".to_string())?;
    println!("  Soroban RPC getLatestLedger OK (ledger {latest})");
    Ok(latest)
}

async fn run_stellar_cli(args: &[String]) -> Result<String, String> {
    let output = Command::new("stellar")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to start stellar CLI: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("stellar CLI failed: {}{}", stdout, stderr));
    }
    Ok(format!("{}{}", stdout, stderr))
}

/// A contract error code, as printed by the CLI (`Error(Contract, #N)`).
/// Each contract numbers its own errors, so the check is applied to the result
/// of a known call and never shared between the registry and the gateway.
fn contract_error_is(output: &str, code: u32) -> bool {
    output.contains(&format!("Error(Contract, #{code})"))
}

/// Every 64-hex-character run in the CLI output, in order.
///
/// The CLI echoes the arguments it was given, and those arguments contain hex
/// (adapter ids, payload hashes, merkle siblings). A naive "first hash-looking
/// string" parser therefore reports the *adapter id* as a transaction hash -
/// which is exactly what an earlier revision of this relayer did. Candidates
/// are collected here and then confirmed against the RPC before any of them is
/// reported as a receipt.
fn hash_candidates(receipt: &str) -> Vec<String> {
    let bytes = receipt.as_bytes();
    let mut found: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start + 64 <= bytes.len() {
        let candidate = &bytes[start..start + 64];
        let bounded_left = start == 0 || !bytes[start - 1].is_ascii_hexdigit();
        let bounded_right = start + 64 == bytes.len() || !bytes[start + 64].is_ascii_hexdigit();
        if bounded_left && bounded_right && candidate.iter().all(u8::is_ascii_hexdigit) {
            let value = String::from_utf8_lossy(candidate).to_ascii_lowercase();
            if !found.contains(&value) {
                found.push(value);
            }
            start += 64;
            continue;
        }
        start += 1;
    }
    found
}

/// Ask the RPC whether this hash is a real, successful transaction. A hash the
/// network has never seen is never a receipt.
async fn confirm_transaction(client: &reqwest::Client, rpc_url: &str, hash: &str) -> bool {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": { "hash": hash },
    });
    let response = match client.post(rpc_url).json(&body).send().await {
        Ok(response) => response,
        Err(_) => return false,
    };
    let value: serde_json::Value = match response.json().await {
        Ok(value) => value,
        Err(_) => return false,
    };
    matches!(
        value
            .pointer("/result/status")
            .and_then(|status| status.as_str()),
        Some("SUCCESS")
    )
}

/// The first hash in the output that the network confirms as a successful
/// transaction. Anything else is a number that merely looks like a hash.
async fn confirmed_transaction_hash(
    client: &reqwest::Client,
    rpc_url: &str,
    receipt: &str,
) -> Result<String, String> {
    let candidates = hash_candidates(receipt);
    if candidates.is_empty() {
        return Err("stellar CLI returned success without a transaction hash".to_string());
    }
    for candidate in &candidates {
        if confirm_transaction(client, rpc_url, candidate).await {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "stellar CLI reported success but none of the {} hash-shaped strings in its output is a confirmed transaction",
        candidates.len()
    ))
}

fn evidence_json(proof: &ProofResponse, relayer_address: &str) -> String {
    serde_json::json!({
        "adapter_id": proof.adapter_id,
        "evidence_version": proof.evidence_version,
        "network": proof.network,
        "payload": proof.payload_hex,
        "declared_height": proof.declared_height,
        "declared_root": proof.declared_root,
        "submitter": relayer_address,
    })
    .to_string()
}

async fn submit_bls(
    client: &reqwest::Client,
    rpc_url: &str,
    proof: &ProofResponse,
    registry_id: &str,
    network: &str,
    relayer_account: &str,
    relayer_address: &str,
    dry_run: bool,
) -> Result<(), String> {
    let evidence = evidence_json(proof, relayer_address);
    let args = vec![
        "contract".to_string(),
        "invoke".to_string(),
        "--id".to_string(),
        registry_id.to_string(),
        "--source".to_string(),
        relayer_account.to_string(),
        "--network".to_string(),
        network.to_string(),
        "--".to_string(),
        "submit_finality_evidence_bls".to_string(),
        "--evidence".to_string(),
        evidence,
    ];
    if dry_run {
        println!("    dry-run: stellar {}", args.join(" "));
        return Ok(());
    }
    let receipt = match run_stellar_cli(&args).await {
        Ok(receipt) => receipt,
        // Registry error #9 is EvidenceAlreadyProcessed: this height is already
        // anchored by an earlier run. That is the desired end state, and
        // refusing to continue would strand every message that was anchored
        // before a relayer restart, so it is not an error here.
        Err(error) if contract_error_is(&error, 9) => {
            println!("    registry BLS evidence for this height was already accepted, continuing");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let tx_hash = confirmed_transaction_hash(client, rpc_url, &receipt).await?;
    println!("    registry BLS transaction receipt: {tx_hash}");
    Ok(())
}

async fn submit_zk(
    client: &reqwest::Client,
    rpc_url: &str,
    proof: &ProofResponse,
    registry_id: &str,
    network: &str,
    relayer_account: &str,
    relayer_address: &str,
    dry_run: bool,
) -> Result<(), String> {
    let proof_hex = proof
        .proof_hex
        .as_deref()
        .ok_or_else(|| "ZK response did not contain a proof".to_string())?;
    let public_inputs = proof
        .public_inputs
        .as_ref()
        .ok_or_else(|| "ZK response did not contain public inputs".to_string())?;
    let evidence = evidence_json(proof, relayer_address);
    let args = vec![
        "contract".to_string(),
        "invoke".to_string(),
        "--id".to_string(),
        registry_id.to_string(),
        "--source".to_string(),
        relayer_account.to_string(),
        "--network".to_string(),
        network.to_string(),
        "--".to_string(),
        "submit_finality_evidence_zk".to_string(),
        "--evidence".to_string(),
        evidence,
        "--proof".to_string(),
        proof_hex.to_string(),
        "--public_inputs".to_string(),
        serde_json::to_string(public_inputs).unwrap(),
    ];
    if dry_run {
        println!("    dry-run: stellar {}", args.join(" "));
        return Ok(());
    }
    let receipt = run_stellar_cli(&args).await?;
    let tx_hash = confirmed_transaction_hash(client, rpc_url, &receipt).await?;
    println!("    registry ZK transaction receipt: {tx_hash}");
    Ok(())
}

async fn submit_gateway(
    client: &reqwest::Client,
    rpc_url: &str,
    event: &LockEvent,
    merkle_proof: &[String],
    domain_key: &str,
    target_domain: &str,
    gateway_id: &str,
    token_id: &str,
    network: &str,
    relayer_account: &str,
    relayer_address: &str,
    fee_amount: i128,
    dry_run: bool,
) -> Result<(), String> {
    let proof_bytes = merkle_proof.join("");
    // An empty proof is the correct proof for a single-event block: the leaf is
    // the root. The CLI cannot accept an empty `--merkle_proof` value, so the
    // empty case goes through the file form with a zero-byte file.
    let (proof_flag, proof_value) = if proof_bytes.is_empty() {
        let path = std::env::temp_dir().join("lumen-gate-empty-merkle-proof.hex");
        std::fs::write(&path, b"").map_err(|error| format!("cannot write {path:?}: {error}"))?;
        (
            "--merkle_proof-file-path".to_string(),
            path.to_string_lossy().to_string(),
        )
    } else {
        ("--merkle_proof".to_string(), proof_bytes)
    };
    // The relay arguments travel as the flat `InboundRelayArgs` struct. The
    // enum form (`finalize_inbound --message`) cannot be built by the current
    // CLI, which is why the gateway exposes `*_tooling` entrypoints carrying an
    // explicit `kind_code` instead: 1 = Lock, 2 = Mint.
    let relay_args = serde_json::json!({
        "message_id": event.message_id,
        "source_domain": domain_key,
        "target_domain": target_domain,
        "source_height": event.height,
        "event_index": event.event_index,
        "nonce": event.nonce,
        "sender": event.sender_on_source,
        "recipient": event.recipient_on_source,
        "payload_hash": event.payload_hash,
        "kind_code": 1,
        "expiry_height": event.expiry_height,
    })
    .to_string();
    let args = vec![
        "contract".to_string(),
        "invoke".to_string(),
        "--id".to_string(),
        gateway_id.to_string(),
        "--source".to_string(),
        relayer_account.to_string(),
        "--network".to_string(),
        network.to_string(),
        "--".to_string(),
        // Gasless lane: the relayer signs and pays the transaction fee, and
        // `fee_amount` is minted back to the relayer out of the transferred
        // amount. The recipient never needs XLM and never signs anything.
        "finalize_inbound_gasless_tooling".to_string(),
        "--relayer".to_string(),
        relayer_address.to_string(),
        "--args".to_string(),
        relay_args,
        proof_flag,
        proof_value,
        "--payload_asset".to_string(),
        token_id.to_string(),
        "--payload_amount".to_string(),
        event.amount.to_string(),
        "--payload_recipient".to_string(),
        event.recipient_on_source.clone(),
        "--fee_amount".to_string(),
        fee_amount.to_string(),
    ];
    if dry_run {
        println!("    dry-run: stellar {}", args.join(" "));
        return Ok(());
    }
    let receipt = match run_stellar_cli(&args).await {
        Ok(receipt) => receipt,
        // Gateway error #4 is AlreadyProcessed: the nonce high-water mark or the
        // message id says this message was already minted. Same reasoning as
        // above - report it and let the run finish.
        Err(error) if contract_error_is(&error, 4) => {
            println!("    this message was already minted on Stellar, nothing to do");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let tx_hash = confirmed_transaction_hash(client, rpc_url, &receipt).await?;
    println!("    gateway mint transaction receipt: {tx_hash}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let dry_run = args.iter().any(|arg| arg == "--dry-run")
        || std::env::var("RELAYER_DRY_RUN").as_deref() == Ok("1");
    let allow_development_zk = std::env::var("ALLOW_DEVELOPMENT_ZK_FIXTURE").as_deref() == Ok("1");
    let sim_url = option_after(&args, "--sim-url")
        .or_else(|| std::env::var("SIM_URL").ok())
        .unwrap_or_else(|| "http://localhost:3001".to_string());
    // The manifest is loaded first because it is configuration, and the
    // relayer's stated rule is that addresses come from `deployments/testnet.json`
    // when they are not explicitly overridden. Reading it before the endpoints
    // are resolved is what makes that rule true for the RPC and the fee
    // recipient, not only for the contract ids.
    let deployment: Option<Deployment> = std::fs::read_to_string("deployments/testnet.json")
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok());
    let network = std::env::var("STELLAR_NETWORK").unwrap_or_else(|_| "testnet".to_string());
    if !dry_run {
        if let Some(deployment) = &deployment {
            if deployment.network != network {
                return Err(std::io::Error::other(format!(
                    "the deployment manifest is network '{}' but STELLAR_NETWORK is '{network}'; refusing to sign testnet-shaped calls against another network's addresses",
                    deployment.network
                ))
                .into());
            }
        }
    }
    let rpc_url = option_after(&args, "--rpc")
        .or_else(|| std::env::var("RPC_URL").ok())
        .or_else(|| {
            deployment
                .as_ref()
                .map(|deployment| deployment.rpc_url.clone())
                .filter(|url| !url.is_empty())
        })
        .unwrap_or_else(|| "https://soroban-testnet.stellar.org".to_string());
    let relayer_account =
        std::env::var("STELLAR_SOURCE_ACCOUNT").unwrap_or_else(|_| "relayer".to_string());
    let relayer_address = std::env::var("STELLAR_RELAYER_ADDRESS")
        .ok()
        .or_else(|| {
            deployment
                .as_ref()
                .and_then(|deployment| deployment.account(&["relayer", "relayer_only"]))
        })
        .unwrap_or_else(|| "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".to_string());
    // Backfill support: the daemon normally follows the newest source block, but
    // a specific height can be pinned (for a replay, an audit, or a demo where
    // empty blocks keep arriving faster than a human can act). `--once` exits
    // after a single pass, which makes the run reproducible in CI.
    let pinned_height: Option<u64> = option_after(&args, "--height")
        .or_else(|| std::env::var("RELAYER_HEIGHT").ok())
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| std::io::Error::other("RELAYER_HEIGHT must be a block height"))
        })
        .transpose()?;
    let once = args.iter().any(|arg| arg == "--once")
        || std::env::var("RELAYER_ONCE").as_deref() == Ok("1");
    let fee_amount: i128 = std::env::var("RELAYER_FEE")
        .unwrap_or_else(|_| "0".to_string())
        .parse()
        .map_err(|_| std::io::Error::other("RELAYER_FEE must be a non-negative integer"))?;
    if fee_amount < 0 {
        return Err(std::io::Error::other("RELAYER_FEE must be non-negative").into());
    }

    println!("Lumen Gate relayer");
    println!("  simulator: {sim_url}");
    println!("  Soroban RPC: {rpc_url}");
    println!(
        "  mode: {}",
        if dry_run {
            "dry-run"
        } else {
            "live signed CLI"
        }
    );
    println!(
        "  development Groth16 fixture: {}",
        if allow_development_zk {
            "explicitly enabled"
        } else {
            "quarantined"
        }
    );

    let client = reqwest::Client::new();
    let rpc_latest_ledger = match check_rpc(&client, &rpc_url).await {
        Ok(latest) => Some(latest),
        Err(error) if dry_run => {
            println!("  dry-run RPC warning: {error}");
            None
        }
        Err(error) => return Err(std::io::Error::other(error).into()),
    };

    let registry_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contract(&["finality_registry", "registry"]))
        .or_else(|| std::env::var("REGISTRY_ID").ok())
        .ok_or_else(|| std::io::Error::other("REGISTRY_ID is required"))?;
    let gateway_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contract(&["settlement_gateway", "gateway"]))
        .or_else(|| std::env::var("GATEWAY_ID").ok())
        .ok_or_else(|| std::io::Error::other("GATEWAY_ID is required"))?;
    let token_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contract(&["wrapped_asset_sac", "token_sac", "token"]))
        .or_else(|| std::env::var("TOKEN_ID").ok())
        .ok_or_else(|| std::io::Error::other("TOKEN_ID is required"))?;
    let domain_key = deployment
        .as_ref()
        .and_then(|deployment| deployment.domain.as_ref())
        .and_then(|domain| domain.domain_key.clone())
        .or_else(|| std::env::var("DOMAIN_KEY").ok())
        .unwrap_or_else(|| "DOMAIN-KEY-PLACEHOLDER".to_string());
    let target_domain = deployment
        .as_ref()
        .and_then(|deployment| deployment.target_domain.clone())
        .or_else(|| std::env::var("TARGET_DOMAIN").ok())
        .unwrap_or_else(|| "TARGET-DOMAIN-PLACEHOLDER".to_string());

    if !dry_run
        && (is_placeholder(&registry_id)
            || is_placeholder(&gateway_id)
            || is_placeholder(&token_id)
            || is_placeholder(&domain_key)
            || is_placeholder(&target_domain))
    {
        return Err(std::io::Error::other(
            "deployment manifest still contains placeholder contract IDs",
        )
        .into());
    }
    if !dry_run && std::env::var("STELLAR_SOURCE_ACCOUNT").is_err() {
        return Err(std::io::Error::other(
            "STELLAR_SOURCE_ACCOUNT must name the funded relayer CLI account",
        )
        .into());
    }
    if !dry_run && std::env::var("STELLAR_RELAYER_ADDRESS").is_err() {
        return Err(std::io::Error::other(
            "STELLAR_RELAYER_ADDRESS must be the relayer account address",
        )
        .into());
    }
    if let Ok(response) = client.get(format!("{sim_url}/info")).send().await {
        if let Ok(info) = response.json::<serde_json::Value>().await {
            if !dry_run {
                if info.get("asset_id").and_then(|value| value.as_str()) != Some(token_id.as_str())
                {
                    return Err(std::io::Error::other(
                        "SOURCE_ASSET_ID does not match the deployed SAC token",
                    )
                    .into());
                }
                if info.get("target_domain").and_then(|value| value.as_str())
                    != Some(target_domain.as_str())
                {
                    return Err(std::io::Error::other(
                        "source simulator target domain does not match the gateway domain",
                    )
                    .into());
                }
            }
        } else if !dry_run {
            return Err(
                std::io::Error::other("source simulator /info returned invalid JSON").into(),
            );
        }
    } else if !dry_run {
        return Err(
            std::io::Error::other("source simulator /info is required in live mode").into(),
        );
    }

    let mut burn_cursor = std::env::var("BURN_START_LEDGER")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| rpc_latest_ledger.map(|ledger| ledger.saturating_sub(120)))
        .unwrap_or(1);
    let mut source_unlocks: HashSet<String> = HashSet::new();

    println!("  registry: {registry_id}");
    println!("  gateway: {gateway_id}");
    match pinned_height {
        Some(height) => println!("  pinned source height: {height}"),
        None => println!("  following the newest source block"),
    }
    println!("  burn event cursor: ledger {burn_cursor}");
    if let Some(deployment) = &deployment {
        println!("  deployment network: {}", deployment.network);
        if let Some(issuer) = &deployment.issuer {
            println!("  issuer: {issuer}");
        }
    }

    let mut submitted: HashSet<(u64, String)> = HashSet::new();
    let mut gateway_submitted: HashSet<String> = HashSet::new();
    loop {
        if !dry_run && !is_placeholder(&gateway_id) {
            match poll_burn_events(&client, &rpc_url, &gateway_id, &mut burn_cursor).await {
                Ok(burns) => {
                    for burn in burns {
                        if source_unlocks.contains(&burn.burn_message_id) {
                            continue;
                        }
                        match unlock_source_from_burn(&client, &sim_url, &burn).await {
                            Ok(()) => {
                                source_unlocks.insert(burn.burn_message_id);
                            }
                            Err(error) => eprintln!("  source unlock failed: {error}"),
                        }
                    }
                }
                Err(error) => eprintln!("  burn event polling failed: {error}"),
            }
        }

        let block_url = match pinned_height {
            Some(height) => format!("{sim_url}/blocks/{height}"),
            None => format!("{sim_url}/blocks/latest"),
        };
        let block = match client.get(block_url).send().await {
            Ok(response) => response.json::<Block>().await.ok(),
            Err(error) => {
                eprintln!("source simulator unavailable: {error}");
                None
            }
        };

        if let Some(block) = block {
            println!(
                "block {} state={} events={}",
                block.height, block.state_root, block.event_root
            );
            for kind in ["bls", "zk"] {
                if kind == "zk" && !allow_development_zk {
                    if block.height == 1 {
                        eprintln!("  zk evidence is quarantined: set ALLOW_DEVELOPMENT_ZK_FIXTURE=1 only for local fixture demonstrations");
                    }
                    continue;
                }
                let key = (block.height, kind.to_string());
                if submitted.contains(&key) && kind == "zk" {
                    continue;
                }
                let events: Vec<LockEvent> = if kind == "bls" {
                    match client
                        .get(format!("{sim_url}/events?height={}", block.height))
                        .send()
                        .await
                    {
                        Ok(response) => response.json().await.unwrap_or_default(),
                        Err(error) => {
                            eprintln!("events unavailable: {error}");
                            Vec::new()
                        }
                    }
                } else {
                    Vec::new()
                };
                let message_id = events.first().map(|event| event.message_id.clone());
                let url = match &message_id {
                    Some(message_id) => format!(
                        "{sim_url}/proof?height={}&kind={kind}&message_id={message_id}",
                        block.height
                    ),
                    None => format!("{sim_url}/proof?height={}&kind={kind}", block.height),
                };
                let proof = match client.get(url).send().await {
                    Ok(response) => match response.json::<ProofResponse>().await {
                        Ok(proof) => proof,
                        Err(error) => {
                            eprintln!("invalid {kind} proof response: {error}");
                            continue;
                        }
                    },
                    Err(error) => {
                        eprintln!("{kind} proof unavailable: {error}");
                        continue;
                    }
                };
                println!(
                    "  {kind} evidence height={} bytes={}",
                    proof.declared_height,
                    proof.payload_hex.len() / 2
                );
                println!("  source proof submitter: {}", proof.submitter);
                println!(
                    "  BLS payload signer_count={} required={} sig={} bytes pubkey={} bytes",
                    proof.payload.signer_count,
                    proof.payload.required,
                    proof.payload.sig_hex.len() / 2,
                    proof.payload.pubkey_hex.len() / 2,
                );
                if let Some(vk) = &proof.vk_hex {
                    println!("  ZK VK bytes={}", vk.len() / 2);
                }
                // Boundary rule, the same one the registry applies to declared
                // fields: nothing in a proof envelope is trusted. For the BLS
                // lane the payload carries the very roots the signature
                // covers, so the relayer requires them to equal the block it
                // fetched before it spends a transaction fee on submission.
                // The ZK lane is exempt because its payload commits to a
                // different relation (a Poseidon chain), not to these fields.
                if kind == "bls" {
                    let envelope_is_coherent = proof.payload.height == proof.declared_height
                        && proof.declared_height == block.height
                        && proof.payload.state_root == block.state_root
                        && proof.payload.event_root == block.event_root;
                    if !envelope_is_coherent {
                        eprintln!(
                            "  bls evidence refused before submission: the proof describes height {} (state {}\u{2026}, event {}\u{2026}) but the block is height {} (state {}\u{2026}, event {}\u{2026})",
                            proof.payload.height,
                            &proof.payload.state_root[..8.min(proof.payload.state_root.len())],
                            &proof.payload.event_root[..8.min(proof.payload.event_root.len())],
                            block.height,
                            &block.state_root[..8.min(block.state_root.len())],
                            &block.event_root[..8.min(block.event_root.len())],
                        );
                        continue;
                    }
                }
                let result = if submitted.contains(&key) {
                    Ok(())
                } else if kind == "bls" {
                    submit_bls(
                        &client,
                        &rpc_url,
                        &proof,
                        &registry_id,
                        &network,
                        &relayer_account,
                        &relayer_address,
                        dry_run,
                    )
                    .await
                } else {
                    submit_zk(
                        &client,
                        &rpc_url,
                        &proof,
                        &registry_id,
                        &network,
                        &relayer_account,
                        &relayer_address,
                        dry_run,
                    )
                    .await
                };
                match result {
                    Ok(()) => {
                        submitted.insert(key);
                        println!("  {kind} evidence submitted");
                        if kind == "bls" {
                            for event in &events {
                                if gateway_submitted.contains(&event.message_id) {
                                    continue;
                                }
                                let proof_siblings =
                                    if message_id.as_deref() == Some(event.message_id.as_str()) {
                                        proof.merkle_proof.clone().unwrap_or_default()
                                    } else {
                                        match client
                                            .get(format!(
                                                "{sim_url}/proof?height={}&kind=bls&message_id={}",
                                                block.height, event.message_id
                                            ))
                                            .send()
                                            .await
                                        {
                                            Ok(response) => response
                                                .json::<ProofResponse>()
                                                .await
                                                .ok()
                                                .and_then(|response| response.merkle_proof)
                                                .unwrap_or_default(),
                                            Err(error) => {
                                                eprintln!(
                                                    "  Merkle proof unavailable for {}: {error}",
                                                    event.message_id
                                                );
                                                continue;
                                            }
                                        }
                                    };
                                match submit_gateway(
                                    &client,
                                    &rpc_url,
                                    event,
                                    &proof_siblings,
                                    &domain_key,
                                    &target_domain,
                                    &gateway_id,
                                    &token_id,
                                    &network,
                                    &relayer_account,
                                    &relayer_address,
                                    fee_amount,
                                    dry_run,
                                )
                                .await
                                {
                                    Ok(()) => {
                                        gateway_submitted.insert(event.message_id.clone());
                                    }
                                    Err(error) => eprintln!("  gateway submission failed: {error}"),
                                }
                            }
                        }
                    }
                    Err(error) => eprintln!("  {kind} submission failed: {error}"),
                }
            }
        }
        if once {
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    if once {
        println!("single pass complete");
    }
    Ok(())
}

fn option_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
