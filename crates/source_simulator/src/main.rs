use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::cors::CorsLayer;

const G1_GENERATOR_HEX: &str = "17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";
const G2_GENERATOR_HEX: &str = "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

// Hardcoded real Groth16 artifacts from stellar-zkstream range proof (Apache-2.0)
const ZK_VK_HEX: &str = include_str!("../../../circuits/range_proof_vk.hex");
const ZK_PROOF_HEX: &str = include_str!("../../../circuits/range_proof_proof.hex");
const ZK_PUBLIC_INPUTS_JSON: &str = include_str!("../../../circuits/range_proof_public_inputs.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Block {
    height: u64,
    state_root: String, // hex 32 bytes
    event_root: String, // hex 32 bytes
    timestamp_ms: u128,
    tx_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LockEvent {
    message_id: String,
    payload_hash: String,
    amount: u64,
    recipient_on_source: String,
    sender_on_source: String,
    height: u64,
    event_index: u32,
    nonce: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SimulatorState {
    blocks: BTreeMap<u64, Block>,
    events: BTreeMap<u64, Vec<LockEvent>>, // height -> events
    latest_height: u64,
    event_nonce: u64,
}

impl SimulatorState {
    fn new() -> Self {
        let genesis_root = hex::encode([0u8; 32]);
        let mut blocks = BTreeMap::new();
        blocks.insert(
            0,
            Block {
                height: 0,
                state_root: genesis_root.clone(),
                event_root: genesis_root.clone(),
                timestamp_ms: now_ms(),
                tx_count: 0,
            },
        );
        Self {
            blocks,
            events: BTreeMap::new(),
            latest_height: 0,
            event_nonce: 0,
        }
    }

    fn produce_block(&mut self) {
        let prev = self.blocks.get(&self.latest_height).unwrap().clone();
        let new_height = self.latest_height + 1;
        // state_root = sha256(prev_state_root || height)
        let mut hasher = Sha256::new();
        hasher.update(hex::decode(&prev.state_root).unwrap());
        hasher.update(new_height.to_le_bytes());
        let state_root = hex::encode(hasher.finalize());

        // event_root = Merkle root of events up to this height (simplified: sha256 of all event message_ids)
        let mut event_hasher = Sha256::new();
        for (_h, evts) in &self.events {
            for e in evts {
                event_hasher.update(e.message_id.as_bytes());
                event_hasher.update(e.payload_hash.as_bytes());
            }
        }
        let event_root = hex::encode(event_hasher.finalize());

        let block = Block {
            height: new_height,
            state_root,
            event_root,
            timestamp_ms: now_ms(),
            tx_count: self.events.get(&new_height).map(|v| v.len() as u64).unwrap_or(0),
        };
        self.blocks.insert(new_height, block);
        self.latest_height = new_height;
    }

    fn add_lock_event(&mut self, amount: u64, recipient: String, sender: String) -> LockEvent {
        let nonce = self.event_nonce;
        self.event_nonce += 1;
        // payload_hash = sha256(asset || amount || recipient) simplified
        let mut hasher = Sha256::new();
        hasher.update(b"wSRC");
        hasher.update(amount.to_le_bytes());
        hasher.update(recipient.as_bytes());
        let payload_hash = hex::encode(hasher.finalize());

        // message_id = sha256(source_domain || target_domain || height || nonce || payload_hash)
        let height = self.latest_height + 1; // will be in next block
        let mut id_hasher = Sha256::new();
        id_hasher.update(b"source-domain");
        id_hasher.update(b"stellar-domain");
        id_hasher.update(height.to_le_bytes());
        id_hasher.update(nonce.to_le_bytes());
        id_hasher.update(payload_hash.as_bytes());
        let message_id = hex::encode(id_hasher.finalize());

        let event = LockEvent {
            message_id,
            payload_hash,
            amount,
            recipient_on_source: recipient,
            sender_on_source: sender,
            height,
            event_index: self.events.get(&height).map(|v| v.len() as u32).unwrap_or(0),
            nonce,
        };
        self.events.entry(height).or_default().push(event.clone());
        event
    }

    fn get_merkle_proof(&self, height: u64, message_id: &str) -> Option<Vec<String>> {
        // Simplified: return empty siblings + leaf hash, root is event_root
        // For MVP, we return leaf hash and root, gateway will do simplified check
        let events = self.events.get(&height)?;
        let found = events.iter().find(|e| e.message_id == message_id)?;
        let leaf = {
            let mut h = Sha256::new();
            h.update(found.message_id.as_bytes());
            h.update(found.payload_hash.as_bytes());
            hex::encode(h.finalize())
        };
        Some(vec![leaf])
    }

    fn build_bls_payload(&self, height: u64) -> Option<(Vec<u8>, String, String)> {
        let block = self.blocks.get(&height)?;
        let state_root_bytes = hex::decode(&block.state_root).ok()?;
        let event_root_bytes = hex::decode(&block.event_root).ok()?;

        let mut payload = Vec::new();
        payload.extend_from_slice(&height.to_le_bytes());
        payload.extend_from_slice(&state_root_bytes);
        payload.extend_from_slice(&event_root_bytes);
        payload.extend_from_slice(&3u32.to_le_bytes()); // signer_count
        payload.extend_from_slice(&2u32.to_le_bytes()); // required
        // sig G1 96 bytes
        payload.extend_from_slice(&hex::decode(G1_GENERATOR_HEX).unwrap());
        // pubkey G2 192 bytes
        payload.extend_from_slice(&hex::decode(G2_GENERATOR_HEX).unwrap());

        Some((payload, block.state_root.clone(), block.event_root.clone()))
    }

    fn build_zk_payload(&self, height: u64) -> Option<(Vec<u8>, String)> {
        let block = self.blocks.get(&height)?;
        // For ZK, we use the hardcoded public input that is a commitment
        // public_inputs[3] = 2a50431f... is used as state_root for demo binding
        let public_inputs: Vec<String> = serde_json::from_str(ZK_PUBLIC_INPUTS_JSON).ok()?;
        let commitment = public_inputs.get(3)?.clone(); // this will be our state_root for ZK demo
        // payload = height (8) + state_root (32) where state_root = commitment bytes
        let mut payload = Vec::new();
        payload.extend_from_slice(&height.to_le_bytes());
        let commitment_bytes = hex::decode(&commitment).ok()?;
        // commitment is 32 bytes already hex
        payload.extend_from_slice(&commitment_bytes);

        Some((payload, commitment))
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

type SharedState = Arc<Mutex<SimulatorState>>;

#[derive(Deserialize)]
struct LockRequest {
    amount: u64,
    recipient: String,
    sender: Option<String>,
}

#[derive(Serialize)]
struct LockResponse {
    event: LockEvent,
    block_height: u64,
}

#[derive(Deserialize)]
struct ProofQuery {
    height: u64,
    kind: Option<String>, // bls or zk
    message_id: Option<String>,
    tamper: Option<String>, // sig, root, version
}

#[derive(Serialize)]
struct ProofResponse {
    adapter_id: String,
    network: String,
    evidence_version: u32,
    declared_height: u64,
    declared_root: String,
    payload_hex: String,
    payload: BlsPayloadDecoded,
    submitter: String,
    // for ZK
    proof_hex: Option<String>,
    public_inputs: Option<Vec<String>>,
    vk_hex: Option<String>,
}

#[derive(Serialize)]
struct BlsPayloadDecoded {
    height: u64,
    state_root: String,
    event_root: String,
    signer_count: u32,
    required: u32,
    sig_hex: String,
    pubkey_hex: String,
}

#[derive(Deserialize)]
struct EventsQuery {
    height: Option<u64>,
}

async fn get_latest_block(State(state): State<SharedState>) -> Json<Block> {
    let s = state.lock().unwrap();
    let block = s.blocks.get(&s.latest_height).unwrap().clone();
    Json(block)
}

async fn get_block(
    Path(height): Path<u64>,
    State(state): State<SharedState>,
) -> Result<Json<Block>, (StatusCode, String)> {
    let s = state.lock().unwrap();
    if let Some(b) = s.blocks.get(&height) {
        Ok(Json(b.clone()))
    } else {
        Err((StatusCode::NOT_FOUND, "block not found".to_string()))
    }
}

async fn post_lock(
    State(state): State<SharedState>,
    Json(req): Json<LockRequest>,
) -> Json<LockResponse> {
    let mut s = state.lock().unwrap();
    let sender = req.sender.unwrap_or_else(|| "source-user-1".to_string());
    let event = s.add_lock_event(req.amount, req.recipient, sender);
    // auto produce block after lock for demo
    s.produce_block();
    let height = s.latest_height;
    Json(LockResponse {
        event,
        block_height: height,
    })
}

async fn get_events(
    Query(q): Query<EventsQuery>,
    State(state): State<SharedState>,
) -> Json<Vec<LockEvent>> {
    let s = state.lock().unwrap();
    if let Some(h) = q.height {
        Json(s.events.get(&h).cloned().unwrap_or_default())
    } else {
        let mut all = Vec::new();
        for (_h, evts) in &s.events {
            all.extend(evts.clone());
        }
        Json(all)
    }
}

async fn get_proof(
    Query(q): Query<ProofQuery>,
    State(state): State<SharedState>,
) -> Result<Json<ProofResponse>, (StatusCode, String)> {
    let s = state.lock().unwrap();
    let height = q.height;
    let kind = q.kind.unwrap_or_else(|| "bls".to_string());

    let adapter_id = hex::encode(Sha256::digest(b"source-chain-bls-v1"));
    let network = "source-testnet".to_string();
    let submitter = "G-source-relayer".to_string();

    if kind == "bls" {
        let (mut payload, state_root, event_root) = s
            .build_bls_payload(height)
            .ok_or((StatusCode::NOT_FOUND, "block not found".to_string()))?;

        // tamper handling for negative tests
        let tamper_clone = q.tamper.clone();
        if let Some(t) = tamper_clone {
            match t.as_str() {
                "sig" => {
                    // zero out sig
                    for i in 80..176 {
                        if i < payload.len() {
                            payload[i] = 0;
                        }
                    }
                }
                "root" => {
                    // change declared root vs payload mismatch will be handled via declared_root param
                }
                "version" => {
                    // handled via evidence_version
                }
                _ => {}
            }
        }

        let declared_root = if q.tamper.as_deref() == Some("root") {
            hex::encode([9u8; 32])
        } else {
            state_root.clone()
        };

        let payload_hex = hex::encode(&payload);
        let decoded = BlsPayloadDecoded {
            height,
            state_root: state_root.clone(),
            event_root,
            signer_count: 3,
            required: 2,
            sig_hex: G1_GENERATOR_HEX.to_string(),
            pubkey_hex: G2_GENERATOR_HEX.to_string(),
        };

        Ok(Json(ProofResponse {
            adapter_id,
            network,
            evidence_version: if q.tamper.as_deref() == Some("version") { 99 } else { 1 },
            declared_height: height,
            declared_root,
            payload_hex,
            payload: decoded,
            submitter,
            proof_hex: None,
            public_inputs: None,
            vk_hex: None,
        }))
    } else {
        // zk
        let (payload, commitment) = s
            .build_zk_payload(height)
            .ok_or((StatusCode::NOT_FOUND, "block not found".to_string()))?;

        let declared_root = if q.tamper.as_deref() == Some("root") {
            hex::encode([9u8; 32])
        } else {
            commitment.clone()
        };

        let payload_hex = hex::encode(&payload);
        let public_inputs: Vec<String> =
            serde_json::from_str(ZK_PUBLIC_INPUTS_JSON).unwrap();

        // tamper proof for negative test
        let proof_hex = if q.tamper.as_deref() == Some("sig") {
            hex::encode(vec![0u8; 256])
        } else {
            ZK_PROOF_HEX.trim().to_string()
        };

        let decoded = BlsPayloadDecoded {
            height,
            state_root: commitment.clone(),
            event_root: hex::encode([0u8; 32]),
            signer_count: 0,
            required: 0,
            sig_hex: "".to_string(),
            pubkey_hex: "".to_string(),
        };

        Ok(Json(ProofResponse {
            adapter_id: hex::encode(Sha256::digest(b"source-chain-zk-v1")),
            network,
            evidence_version: if q.tamper.as_deref() == Some("version") { 99 } else { 1 },
            declared_height: height,
            declared_root,
            payload_hex,
            payload: decoded,
            submitter,
            proof_hex: Some(proof_hex),
            public_inputs: Some(public_inputs),
            vk_hex: Some(ZK_VK_HEX.trim().to_string()),
        }))
    }
}

async fn get_info(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let s = state.lock().unwrap();
    Json(serde_json::json!({
        "latest_height": s.latest_height,
        "blocks": s.blocks.len(),
        "total_events": s.events.values().map(|v| v.len()).sum::<usize>(),
        "bls_generator_g1": G1_GENERATOR_HEX,
        "bls_generator_g2": G2_GENERATOR_HEX,
        "zk_vk_len": ZK_VK_HEX.trim().len() / 2,
        "zk_proof_len": ZK_PROOF_HEX.trim().len() / 2,
        "domains": ["source-testnet"],
        "note": "Anchor-attached settlement layer simulator. BLS uses G1/G2 generator as valid points (on-curve check). ZK uses real Groth16 range proof from stellar-zkstream."
    }))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = if args.len() > 2 && args[1] == "--port" {
        args[2].parse::<u16>().unwrap_or(3001)
    } else {
        3001
    };

    let state = Arc::new(Mutex::new(SimulatorState::new()));

    // background block producer every 5s
    let state_clone = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            let mut s = state_clone.lock().unwrap();
            s.produce_block();
            println!("Produced block height {}", s.latest_height);
        }
    });

    let app = Router::new()
        .route("/blocks/latest", get(get_latest_block))
        .route("/blocks/:height", get(get_block))
        .route("/lock", post(post_lock))
        .route("/events", get(get_events))
        .route("/proof", get(get_proof))
        .route("/info", get(get_info))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    println!("Source simulator listening on 0.0.0.0:{}", port);
    println!("Try: curl http://localhost:{}/info", port);
    axum::serve(listener, app).await.unwrap();
}
