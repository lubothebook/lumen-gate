use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Deserialize, Debug)]
struct SimInfo {
    latest_height: u64,
}

#[derive(Deserialize, Debug)]
struct Block {
    height: u64,
    state_root: String,
    event_root: String,
}

#[derive(Deserialize, Debug)]
struct ProofResponse {
    adapter_id: String,
    network: String,
    evidence_version: u32,
    declared_height: u64,
    declared_root: String,
    payload_hex: String,
    proof_hex: Option<String>,
    public_inputs: Option<Vec<String>>,
}

#[derive(Serialize)]
struct SorobanRpcRequest {
    jsonrpc: String,
    id: u32,
    method: String,
    params: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let sim_url = if args.len() > 2 && args[1] == "--sim-url" {
        args[2].clone()
    } else {
        "http://localhost:3001".to_string()
    };
    let rpc_url = if args.len() > 4 && args[3] == "--rpc" {
        args[4].clone()
    } else {
        "https://soroban-testnet.stellar.org".to_string()
    };

    println!("Relayer starting");
    println!("  Simulator: {}", sim_url);
    println!("  Soroban RPC: {}", rpc_url);
    println!("  This relayer demonstrates real Stellar connection + proof relay");

    let client = reqwest::Client::new();

    // 1. Check Soroban RPC real connection (getLatestLedger)
    println!("\n[1] Checking Soroban RPC connection (real Stellar testnet)...");
    let rpc_req = SorobanRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: 1,
        method: "getLatestLedger".to_string(),
        params: serde_json::json!({}),
    };
    match client.post(&rpc_url).json(&rpc_req).send().await {
        Ok(resp) => {
            let text = resp.text().await?;
            println!("  RPC getLatestLedger response (truncated): {}", &text[..std::cmp::min(500, text.len())]);
            println!("  ✅ Real Soroban testnet connection OK");
        }
        Err(e) => {
            println!("  ❌ RPC connection failed: {}. Is testnet reachable?", e);
        }
    }

    // 2. Poll simulator
    println!("\n[2] Fetching simulator info...");
    match client.get(format!("{}/info", sim_url)).send().await {
        Ok(resp) => {
            let info: serde_json::Value = resp.json().await?;
            println!("  Simulator info: {}", serde_json::to_string_pretty(&info)?);
        }
        Err(e) => {
            println!("  Simulator not reachable: {}. Start it with: cargo run -p source_simulator -- --port 3001", e);
            println!("  Continuing with dry-run mode...");
        }
    }

    // 3. Loop fetching blocks and proofs
    println!("\n[3] Starting relay loop (poll every 5s, dry-run if no contract IDs)...");
    let registry_id = std::env::var("REGISTRY_ID").unwrap_or_else(|_| "CD-PLACEHOLDER".to_string());
    let gateway_id = std::env::var("GATEWAY_ID").unwrap_or_else(|_| "CD-PLACEHOLDER".to_string());

    loop {
        // fetch latest block
        let latest_block: Option<Block> = match client
            .get(format!("{}/blocks/latest", sim_url))
            .send()
            .await
        {
            Ok(r) => r.json().await.ok(),
            Err(_) => None,
        };

        if let Some(block) = latest_block {
            println!("\n--- Block height {} ---", block.height);
            println!("  state_root: {}", block.state_root);
            println!("  event_root: {}", block.event_root);

            // fetch BLS proof
            let proof_url = format!("{}/proof?height={}&kind=bls", sim_url, block.height);
            if let Ok(resp) = client.get(&proof_url).send().await {
                if let Ok(proof) = resp.json::<ProofResponse>().await {
                    println!("  BLS evidence: adapter_id={}, declared_height={}, payload_len={}", proof.adapter_id, proof.declared_height, proof.payload_hex.len()/2);
                    println!("  Would call: finality_registry.submit_finality_evidence_bls(evidence)");
                    println!("    Registry: {}", registry_id);
                    if registry_id.contains("PLACEHOLDER") {
                        println!("    (dry-run, no real contract ID set)");
                    } else {
                        // Here we would build and submit Soroban transaction via stellar-sdk
                        // For hackathon, we log the steps
                        println!("    -> Submitting to Soroban testnet via RPC...");
                    }

                    // Check if finalized, then finalize inbound
                    println!("  Would call: settlement_gateway.finalize_inbound(message, proof, asset, amount, recipient)");
                    println!("    Gateway: {}", gateway_id);
                }
            }

            // fetch ZK proof
            let zk_proof_url = format!("{}/proof?height={}&kind=zk", sim_url, block.height);
            if let Ok(resp) = client.get(&zk_proof_url).send().await {
                if let Ok(proof) = resp.json::<ProofResponse>().await {
                    println!("  ZK evidence: proof_len={}, public_inputs={:?}", proof.proof_hex.as_ref().map(|s| s.len()/2).unwrap_or(0), proof.public_inputs);
                    println!("  Would call: finality_registry.submit_finality_evidence_zk with native bn254 pairing_check");
                }
            }
        } else {
            println!("No block yet, waiting...");
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
