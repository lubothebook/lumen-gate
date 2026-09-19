use serde::{Deserialize, Serialize};
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

#[derive(Deserialize, Debug)]
struct Deployment {
    network: String,
    rpc_url: String,
    contracts: HashMap<String, String>,
    issuer: Option<String>,
    domain_key: Option<String>,
    target_domain: Option<String>,
}

fn is_placeholder(value: &str) -> bool {
    value.contains("PLACEHOLDER") || value.contains("REPLACE-ME") || value.starts_with("CD-")
}

async fn check_rpc(client: &reqwest::Client, rpc_url: &str) -> Result<(), String> {
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
    println!("  Soroban RPC getLatestLedger OK");
    Ok(())
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
    let receipt = run_stellar_cli(&args).await?;
    println!("    registry BLS receipt: {}", receipt.trim());
    Ok(())
}

async fn submit_zk(
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
    println!("    registry ZK receipt: {}", receipt.trim());
    Ok(())
}

async fn submit_gateway(
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
    let message = serde_json::json!({
        "message_id": event.message_id,
        "source_domain": domain_key,
        "target_domain": target_domain,
        "source_height": event.height,
        "event_index": event.event_index,
        "nonce": event.nonce,
        "sender": event.sender_on_source,
        "recipient": event.recipient_on_source,
        "payload_hash": event.payload_hash,
        // Stellar CLI JSON uses the Soroban enum spec form: a vec containing
        // the unit-variant symbol, not a Rust/Serde tagged object.
        "kind": ["Lock"],
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
        "finalize_inbound_gasless".to_string(),
        "--relayer".to_string(),
        relayer_address.to_string(),
        "--message".to_string(),
        message,
        "--merkle_proof".to_string(),
        proof_bytes,
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
    let receipt = run_stellar_cli(&args).await?;
    println!("    gateway mint receipt: {}", receipt.trim());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let dry_run = args.iter().any(|arg| arg == "--dry-run")
        || std::env::var("RELAYER_DRY_RUN").as_deref() == Ok("1");
    let sim_url = option_after(&args, "--sim-url")
        .or_else(|| std::env::var("SIM_URL").ok())
        .unwrap_or_else(|| "http://localhost:3001".to_string());
    let rpc_url = option_after(&args, "--rpc")
        .or_else(|| std::env::var("RPC_URL").ok())
        .unwrap_or_else(|| "https://soroban-testnet.stellar.org".to_string());
    let network = std::env::var("STELLAR_NETWORK").unwrap_or_else(|_| "testnet".to_string());
    let relayer_account = std::env::var("STELLAR_SOURCE_ACCOUNT")
        .unwrap_or_else(|_| "relayer".to_string());
    let relayer_address = std::env::var("STELLAR_RELAYER_ADDRESS")
        .unwrap_or_else(|_| "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".to_string());
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
    println!("  mode: {}", if dry_run { "dry-run" } else { "live signed CLI" });

    let client = reqwest::Client::new();
    if let Err(error) = check_rpc(&client, &rpc_url).await {
        if !dry_run {
            return Err(std::io::Error::other(error).into());
        }
        println!("  dry-run RPC warning: {error}");
    }

    let deployment: Option<Deployment> = std::fs::read_to_string("deployments/testnet.json")
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok());
    let registry_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contracts.get("finality_registry"))
        .cloned()
        .or_else(|| std::env::var("REGISTRY_ID").ok())
        .ok_or_else(|| std::io::Error::other("REGISTRY_ID is required"))?;
    let gateway_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contracts.get("settlement_gateway"))
        .cloned()
        .or_else(|| std::env::var("GATEWAY_ID").ok())
        .ok_or_else(|| std::io::Error::other("GATEWAY_ID is required"))?;
    let token_id = deployment
        .as_ref()
        .and_then(|deployment| deployment.contracts.get("token_sac"))
        .cloned()
        .or_else(|| std::env::var("TOKEN_ID").ok())
        .ok_or_else(|| std::io::Error::other("TOKEN_ID is required"))?;
    let domain_key = deployment
        .as_ref()
        .and_then(|deployment| deployment.domain_key.clone())
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
        return Err(std::io::Error::other("deployment manifest still contains placeholder contract IDs").into());
    }
    if !dry_run && std::env::var("STELLAR_SOURCE_ACCOUNT").is_err() {
        return Err(std::io::Error::other("STELLAR_SOURCE_ACCOUNT must name the funded relayer CLI account").into());
    }
    if !dry_run && std::env::var("STELLAR_RELAYER_ADDRESS").is_err() {
        return Err(std::io::Error::other("STELLAR_RELAYER_ADDRESS must be the relayer account address").into());
    }
    if let Ok(response) = client.get(format!("{sim_url}/info")).send().await {
        if let Ok(info) = response.json::<serde_json::Value>().await {
            if !dry_run {
                if info.get("asset_id").and_then(|value| value.as_str()) != Some(token_id.as_str()) {
                    return Err(std::io::Error::other("SOURCE_ASSET_ID does not match the deployed SAC token").into());
                }
                if info.get("target_domain").and_then(|value| value.as_str()) != Some(target_domain.as_str()) {
                    return Err(std::io::Error::other("source simulator target domain does not match the gateway domain").into());
                }
            }
        } else if !dry_run {
            return Err(std::io::Error::other("source simulator /info returned invalid JSON").into());
        }
    } else if !dry_run {
        return Err(std::io::Error::other("source simulator /info is required in live mode").into());
    }

    println!("  registry: {registry_id}");
    println!("  gateway: {gateway_id}");
    if let Some(deployment) = &deployment {
        println!("  deployment network: {}", deployment.network);
        if let Some(issuer) = &deployment.issuer {
            println!("  issuer: {issuer}");
        }
    }

    let mut submitted: HashSet<(u64, String)> = HashSet::new();
    let mut gateway_submitted: HashSet<String> = HashSet::new();
    loop {
        let block = match client
            .get(format!("{sim_url}/blocks/latest"))
            .send()
            .await
        {
            Ok(response) => response.json::<Block>().await.ok(),
            Err(error) => {
                eprintln!("source simulator unavailable: {error}");
                None
            }
        };

        if let Some(block) = block {
            println!("block {} state={} events={}", block.height, block.state_root, block.event_root);
            for kind in ["bls", "zk"] {
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
                    Some(message_id) => format!("{sim_url}/proof?height={}&kind={kind}&message_id={message_id}", block.height),
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
                println!("  {kind} evidence height={} bytes={}", proof.declared_height, proof.payload_hex.len() / 2);
                println!("  source proof submitter: {}", proof.submitter);
                println!("  BLS payload signer_count={} required={} sig={} bytes pubkey={} bytes",
                    proof.payload.signer_count,
                    proof.payload.required,
                    proof.payload.sig_hex.len() / 2,
                    proof.payload.pubkey_hex.len() / 2,
                );
                if let Some(vk) = &proof.vk_hex {
                    println!("  ZK VK bytes={}", vk.len() / 2);
                }
                let result = if submitted.contains(&key) {
                    Ok(())
                } else if kind == "bls" {
                    submit_bls(&proof, &registry_id, &network, &relayer_account, &relayer_address, dry_run).await
                } else {
                    submit_zk(&proof, &registry_id, &network, &relayer_account, &relayer_address, dry_run).await
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
                                let proof_siblings = if message_id.as_deref() == Some(event.message_id.as_str()) {
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
                                            eprintln!("  Merkle proof unavailable for {}: {error}", event.message_id);
                                            continue;
                                        }
                                    }
                                };
                                match submit_gateway(
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
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

fn option_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
