use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use bls12_381::{
    hash_to_curve::{ExpandMsgXmd, HashToCurve},
    G1Affine, G1Projective, G2Affine, G2Projective, Scalar,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::cors::CorsLayer;

// Real BLS generators from spec (valid points)
const G1_GENERATOR_HEX: &str = "17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";
const G2_GENERATOR_HEX: &str = "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

// Checked-in development Groth16 range-proof artifacts (Apache-2.0 provenance)
const ZK_VK_HEX: &str = include_str!("../../../circuits/range_proof_vk.hex");
const ZK_PROOF_HEX: &str = include_str!("../../../circuits/range_proof_proof.hex");
const ZK_PUBLIC_INPUTS_JSON: &str = include_str!("../../../circuits/range_proof_public_inputs.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Block {
    height: u64,
    state_root: String,
    event_root: String,
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
    expiry_height: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SimulatorState {
    blocks: BTreeMap<u64, Block>,
    events: BTreeMap<u64, Vec<LockEvent>>,
    asset_id: String,
    unlocked_messages: BTreeMap<String, bool>,
    latest_height: u64,
    event_nonce: u64,
    // BLS validator set (deterministic for demo)
    bls_sks: Vec<[u8; 32]>, // scalar bytes
}

impl SimulatorState {
    fn new(asset_id: String) -> Self {
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
        // deterministic demo 3-validator set (2-of-3 policy): sk = 1,2,3
        let mut sks = Vec::new();
        for i in 1u8..=3 {
            let mut b = [0u8; 32];
            b[31] = i;
            sks.push(b);
        }
        Self {
            blocks,
            events: BTreeMap::new(),
            asset_id,
            unlocked_messages: BTreeMap::new(),
            latest_height: 0,
            event_nonce: 0,
            bls_sks: sks,
        }
    }

    fn compute_event_root(&self, height: u64) -> String {
        // Each block commits to its own event list. The proof endpoint builds
        // siblings from the same list, so the on-chain event root is complete.
        let events = match self.events.get(&height) {
            Some(events) if !events.is_empty() => events,
            _ => return hex::encode([0u8; 32]),
        };
        let mut level: Vec<Vec<u8>> = events
            .iter()
            .map(|event| {
                let mut hasher = Sha256::new();
                hasher.update(
                    hex::decode(&event.message_id)
                        .unwrap_or_else(|_| event.message_id.as_bytes().to_vec()),
                );
                hasher.update(
                    hex::decode(&event.payload_hash)
                        .unwrap_or_else(|_| event.payload_hash.as_bytes().to_vec()),
                );
                hasher.finalize().to_vec()
            })
            .collect();
        while level.len() > 1 {
            let mut next = Vec::new();
            let mut i = 0;
            while i < level.len() {
                let left = &level[i];
                let right = if i + 1 < level.len() { &level[i + 1] } else { left };
                let mut hasher = Sha256::new();
                if left <= right {
                    hasher.update(left);
                    hasher.update(right);
                } else {
                    hasher.update(right);
                    hasher.update(left);
                }
                next.push(hasher.finalize().to_vec());
                i += 2;
            }
            level = next;
        }
        hex::encode(&level[0])
    }

    fn produce_block(&mut self) {
        let prev = self.blocks.get(&self.latest_height).unwrap().clone();
        let new_height = self.latest_height + 1;
        let mut hasher = Sha256::new();
        hasher.update(hex::decode(&prev.state_root).unwrap());
        hasher.update(new_height.to_le_bytes());
        let state_root = hex::encode(hasher.finalize());

        let event_root = self.compute_event_root(new_height);

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
        let height = self.latest_height + 1;
        let event_index = self.events.get(&height).map(|v| v.len() as u32).unwrap_or(0);
        let expiry_height = height.saturating_add(100);

        // This byte layout mirrors settlement_gateway::compute_payload_hash_simple.
        let mut payload_hasher = Sha256::new();
        payload_hasher.update(self.asset_id.as_bytes());
        payload_hasher.update((amount as i128).to_le_bytes());
        payload_hasher.update(recipient.as_bytes());
        let payload_hash_bytes = payload_hasher.finalize();
        let payload_hash = hex::encode(&payload_hash_bytes);

        // The source adapter domain is deterministic and matches the deployment
        // script. target_domain is the gateway's pinned Stellar domain.
        let adapter_id = Sha256::digest(b"source-chain-bls-v1");
        let mut domain_buf = Vec::new();
        domain_buf.extend_from_slice(&adapter_id);
        domain_buf.extend_from_slice(b"source-testnet");
        let source_domain = Sha256::digest(&domain_buf);
        let target_domain = Sha256::digest(b"lumen-gate-stellar-testnet");

        // This is the same canonical envelope hashed by the gateway.
        let mut id_hasher = Sha256::new();
        id_hasher.update(source_domain);
        id_hasher.update(target_domain);
        id_hasher.update(height.to_le_bytes());
        id_hasher.update(event_index.to_le_bytes());
        id_hasher.update(nonce.to_le_bytes());
        id_hasher.update(&payload_hash_bytes);
        id_hasher.update(expiry_height.to_le_bytes());
        id_hasher.update([1u8]); // MessageKind::Lock
        id_hasher.update(sender.as_bytes());
        id_hasher.update(recipient.as_bytes());
        let message_id = hex::encode(id_hasher.finalize());

        let event = LockEvent {
            message_id,
            payload_hash,
            amount,
            recipient_on_source: recipient,
            sender_on_source: sender,
            height,
            event_index,
            nonce,
            expiry_height,
        };
        self.events.entry(height).or_default().push(event.clone());
        event
    }

    fn get_merkle_proof(&self, height: u64, message_id: &str) -> Option<Vec<String>> {
        let events = self.events.get(&height)?;
        let found_idx = events.iter().position(|e| e.message_id == message_id)?;
        // Build leaf hashes
        let leaves: Vec<Vec<u8>> = events
            .iter()
            .map(|e| {
                let mut h = Sha256::new();
                h.update(hex::decode(&e.message_id).unwrap_or_else(|_| e.message_id.as_bytes().to_vec()));
                h.update(hex::decode(&e.payload_hash).unwrap_or_else(|_| e.payload_hash.as_bytes().to_vec()));
                h.finalize().to_vec()
            })
            .collect();

        let mut proof = Vec::new();
        let mut idx = found_idx;
        let mut level = leaves;
        while level.len() > 1 {
            let sibling_idx = if idx % 2 == 0 {
                if idx + 1 < level.len() { idx + 1 } else { idx }
            } else {
                idx - 1
            };
            if sibling_idx < level.len() {
                // The tree duplicates an odd final node, so a self-sibling is
                // part of the proof whenever the node is carried upward.
                proof.push(hex::encode(&level[sibling_idx]));
            }
            // build next level
            let mut next = Vec::new();
            let mut i = 0;
            while i < level.len() {
                let left = &level[i];
                let right = if i + 1 < level.len() { &level[i + 1] } else { left };
                let mut hasher = Sha256::new();
                if left <= right {
                    hasher.update(left);
                    hasher.update(right);
                } else {
                    hasher.update(right);
                    hasher.update(left);
                }
                next.push(hasher.finalize().to_vec());
                i += 2;
            }
            idx /= 2;
            level = next;
        }
        Some(proof)
    }

    // Reverse settlement is intentionally idempotent: a source unlock can be
    // consumed once even if a relayer retries the same burn message.
    fn unlock_message(&mut self, message_id: &str) -> Result<LockEvent, String> {
        if self.unlocked_messages.contains_key(message_id) {
            return Err("message already unlocked".to_string());
        }
        let found = self
            .events
            .values()
            .find_map(|events| events.iter().find(|event| event.message_id == message_id).cloned());
        if let Some(event) = found {
            self.unlocked_messages.insert(message_id.to_string(), true);
            return Ok(event);
        }
        Err("lock message not found".to_string())
    }

    // Real BLS signing: H = hash_to_curve(height||state_root||event_root), sig = sk * H, agg sig, agg pubkey
    fn build_bls_payload(&self, height: u64) -> Option<(Vec<u8>, String, String, String, String)> {
        let block = self.blocks.get(&height)?;
        let state_root_bytes = hex::decode(&block.state_root).ok()?;
        let event_root_bytes = hex::decode(&block.event_root).ok()?;

        // The simulator uses the same RFC 9380 hash-to-curve inputs as the
        // Soroban host. This is deliberately not a hash-to-scalar shortcut:
        // the point produced here must be the point used by the pairing check.
        let mut msg = Vec::new();
        msg.extend_from_slice(&height.to_le_bytes());
        msg.extend_from_slice(&state_root_bytes);
        msg.extend_from_slice(&event_root_bytes);
        let g1_hash =
            <G1Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve(
                std::iter::once(msg.as_slice()),
                b"lumen-gate-finality-v1",
            );
        let g2_gen =
            <G2Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve(
                std::iter::once(&b"lumen-gate-g2-generator"[..]),
                b"lumen-gate-finality-v1",
            );

        // aggregate signatures - deterministic sk 1,2,3
        let mut agg_sig = G1Projective::identity();
        let mut agg_pubkey = G2Projective::identity();
        for (idx, _sk_bytes) in self.bls_sks.iter().enumerate() {
            let sk_scalar = Scalar::from((idx as u64) + 1);
            let sig = g1_hash * sk_scalar;
            agg_sig += sig;
            let pubkey = g2_gen * sk_scalar;
            agg_pubkey += pubkey;
        }

        let sig_affine = G1Affine::from(agg_sig);
        let pubkey_affine = G2Affine::from(agg_pubkey);

        let sig_uncompressed = sig_affine.to_uncompressed(); // 96
        let pubkey_uncompressed = pubkey_affine.to_uncompressed(); // 192

        // For compatibility with existing payload layout (96 + 192), we use uncompressed
        let mut payload = Vec::new();
        payload.extend_from_slice(&height.to_le_bytes());
        payload.extend_from_slice(&state_root_bytes);
        payload.extend_from_slice(&event_root_bytes);
        payload.extend_from_slice(&3u32.to_le_bytes());
        payload.extend_from_slice(&2u32.to_le_bytes());
        payload.extend_from_slice(&sig_uncompressed);
        payload.extend_from_slice(&pubkey_uncompressed);

        Some((
            payload,
            block.state_root.clone(),
            block.event_root.clone(),
            hex::encode(sig_uncompressed),
            hex::encode(pubkey_uncompressed),
        ))
    }

    fn build_zk_payload(&self, height: u64) -> Option<(Vec<u8>, String)> {
        let _block = self.blocks.get(&height)?;
        // This checked-in development proof is not a source-root proof yet. Keep
        // its public commitment explicit so the registry can reject a mismatch
        // instead of treating the fixture as universally valid.
        let public_inputs: Vec<String> = serde_json::from_str(ZK_PUBLIC_INPUTS_JSON).ok()?;
        let commitment = public_inputs.get(3)?.clone();
        let mut payload = Vec::new();
        payload.extend_from_slice(&height.to_le_bytes());
        let commitment_bytes = hex::decode(&commitment).ok()?;
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
struct UnlockRequest {
    message_id: String,
}

#[derive(Serialize)]
struct UnlockResponse {
    unlocked: bool,
    event: LockEvent,
}

#[derive(Deserialize)]
struct ProofQuery {
    height: u64,
    kind: Option<String>,
    message_id: Option<String>,
    tamper: Option<String>,
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
    proof_hex: Option<String>,
    public_inputs: Option<Vec<String>>,
    vk_hex: Option<String>,
    merkle_proof: Option<Vec<String>>,
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
    let recipient = req.recipient;
    let sender = req.sender.unwrap_or_else(|| recipient.clone());
    let event = s.add_lock_event(req.amount, recipient, sender);
    s.produce_block();
    let height = s.latest_height;
    Json(LockResponse {
        event,
        block_height: height,
    })
}

async fn post_unlock(
    State(state): State<SharedState>,
    Json(req): Json<UnlockRequest>,
) -> Result<Json<UnlockResponse>, (StatusCode, String)> {
    let mut s = state.lock().unwrap();
    s.unlock_message(&req.message_id)
        .map(|event| Json(UnlockResponse { unlocked: true, event }))
        .map_err(|error| {
            let status = if error == "lock message not found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::CONFLICT
            };
            (status, error)
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
        let (mut payload, state_root, event_root, sig_hex_real, pubkey_hex_real) = s
            .build_bls_payload(height)
            .ok_or((StatusCode::NOT_FOUND, "block not found".to_string()))?;

        let tamper_clone = q.tamper.clone();
        if let Some(t) = tamper_clone {
            match t.as_str() {
                "sig" => {
                    for i in 80..176 {
                        if i < payload.len() {
                            payload[i] = 0;
                        }
                    }
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
            event_root: event_root.clone(),
            signer_count: 3,
            required: 2,
            sig_hex: if q.tamper.as_deref() == Some("sig") {
                hex::encode(vec![0u8; 96])
            } else {
                sig_hex_real
            },
            pubkey_hex: pubkey_hex_real,
        };

        let merkle_proof = if let Some(mid) = &q.message_id {
            s.get_merkle_proof(height, mid)
        } else {
            None
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
            merkle_proof,
        }))
    } else {
        let (payload, commitment) = s
            .build_zk_payload(height)
            .ok_or((StatusCode::NOT_FOUND, "block not found".to_string()))?;

        let declared_root = if q.tamper.as_deref() == Some("root") {
            hex::encode([9u8; 32])
        } else {
            commitment.clone()
        };

        let payload_hex = hex::encode(&payload);
        let public_inputs: Vec<String> = serde_json::from_str(ZK_PUBLIC_INPUTS_JSON).unwrap();

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

        let merkle_proof = if let Some(mid) = &q.message_id {
            s.get_merkle_proof(height, mid)
        } else {
            None
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
            merkle_proof,
        }))
    }
}

async fn get_info(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let s = state.lock().unwrap();
    Json(serde_json::json!({
        "latest_height": s.latest_height,
        "blocks": s.blocks.len(),
        "total_events": s.events.values().map(|v| v.len()).sum::<usize>(),
        "unlocked_messages": s.unlocked_messages.len(),
        "asset_id": &s.asset_id,
        "target_domain": hex::encode(Sha256::digest(b"lumen-gate-stellar-testnet")),
        "bls_generator_g1": G1_GENERATOR_HEX,
        "bls_generator_g2": G2_GENERATOR_HEX,
        "zk_vk_len": ZK_VK_HEX.trim().len() / 2,
        "zk_proof_len": ZK_PROOF_HEX.trim().len() / 2,
        "zk_binding": "static fixture commitment; regenerate with a root-bound circuit before live submission",
        "domains": ["source-testnet", "source-testnet-zk"],
        "note": "Hardened simulator with real BLS aggregate (demo 2-of-3 validators, hash_to_curve DST lumen-gate-finality-v1) and binary Merkle tree for event_root. BLS sig = agg(sk_i * H(height||state_root||event_root))."
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

    let asset_id = std::env::var("SOURCE_ASSET_ID").unwrap_or_else(|_| "wSRC".to_string());
    let state = Arc::new(Mutex::new(SimulatorState::new(asset_id)));

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
        .route("/unlock", post(post_unlock))
        .route("/events", get(get_events))
        .route("/proof", get(get_proof))
        .route("/info", get(get_info))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    println!("Source simulator listening on 0.0.0.0:{}", port);
    axum::serve(listener, app).await.unwrap();
}
