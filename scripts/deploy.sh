#!/bin/bash
set -e

# Migrate to Stellar - Testnet Deploy Script (hardened)
# Requires: stellar CLI (cargo install stellar-cli), funded testnet account

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
FRIENDBOT="https://friendbot.stellar.org"

echo "=== Migrate to Stellar Deploy (hardened) ==="
echo "Network: $NETWORK, RPC: $RPC_URL"
echo "Hardened: BLS aggregate + Merkle + HWM + Groth16 BN254 + SAC set_admin"

if ! command -v stellar &> /dev/null; then
  echo "stellar CLI not found. Install with: cargo install stellar-cli --locked"
  echo "For this hackathon demo, creating placeholder deployment file with hardened notes."
  
  mkdir -p deployments
  cat > deployments/testnet.json <<'JSON'
{
  "network": "testnet",
  "rpc_url": "https://soroban-testnet.stellar.org",
  "note": "Placeholder - replace with real contract IDs after stellar CLI deploy. Hardened version includes real BLS aggregate, Merkle tree, HWM, Groth16 BN254",
  "contracts": {
    "finality_registry": "CD-REGISTRY-PLACEHOLDER-REPLACE-ME",
    "settlement_gateway": "CD-GATEWAY-PLACEHOLDER-REPLACE-ME",
    "token_sac": "CD-TOKEN-PLACEHOLDER-REPLACE-ME"
  },
  "issuer": "GC-ISSUER-PLACEHOLDER",
  "admin": "GC-ADMIN-PLACEHOLDER",
  "domains": {
    "source-testnet": {
      "adapter_id": "hash(source-chain-bls-v1)",
      "network": "source-testnet",
      "domain_key": "sha256(adapter_id || network)",
      "consensus_kind": "bft-like-3-of-5",
      "finality_kind": "Economic",
      "trust_model": "HonestMajority(5)",
      "required_depth": 2
    }
  },
  "vk": {
    "source": "circuits/range_proof_vk.hex (768 bytes, real Groth16 BN254 VK, Apache-2.0 from stellar-zkstream)",
    "proof": "circuits/range_proof_proof.hex (256 bytes)",
    "public_inputs": "circuits/range_proof_public_inputs.json (4 x 32 bytes)",
    "note": "VK length 768 = G1 64 + 3*G2 128 + (4+1)*G1 64 = 64+384+320=768, matches groth16 verifier expected"
  },
  "hardening": {
    "bls": "Real BLS aggregate: 3 validators, sk=1,2,3, H=hash(height||state_root||event_root) via G1 generator * hash_scalar, sig=agg(sk_i*H), pubkey=agg(sk_i*G2). On-chain: g1_is_on_curve, g1_is_in_subgroup, g2_is_on_curve, g2_is_in_subgroup, hash_to_g1 DST migrate-to-stellar-v1, optional full pairing e(sig,G2_gen)*e(-H,pubkey)==1 in submit_bls_hardened",
    "merkle": "Binary Merkle tree for event_root, leaf=sha256(message_id||payload_hash), sorted hashing, proof verification in gateway finalize_inbound",
    "hwm": "High-water-mark (source_domain,target_domain,sender)->highest_nonce, plus ProcessedMessage(message_id) set to prevent replay",
    "gateway": "lock_and_relay: transfer token to gateway, payload_hash=sha256(asset||amount||recipient_on_source), nonce from OutboundNonceFull, message_id=sha256(source_domain||target_domain||height||event_index||nonce||payload_hash||expiry||kind||sender||recipient)",
    "zk": "Groth16 BN254 verifier via native bn254_multi_pairing_check, 4 pairings e(A,B)*e(-alpha,beta)*e(-vk_x,gamma)*e(-C,delta)==1",
    "sac": "SAC set_admin to gateway, gateway only mints after finality proof, no custodial bridge",
    "anchor": "stellar.toml with wSRC, issuer sets SAC admin to gateway, anchor server provides /info, /health, /deposit, /withdraw, /sep6/info, no validator keys"
  }
}
JSON
  echo "Created deployments/testnet.json placeholder (hardened)"
  echo "Next steps (with stellar CLI):"
  cat <<'NEXT'
  stellar keys generate admin --network testnet --fund
  stellar keys generate issuer --network testnet --fund
  stellar contract build
  # Deploy finality_registry with admin
  stellar contract deploy --wasm target/wasm32-unknown-unknown/release/finality_registry.wasm --source admin --network testnet -- --admin <admin_address>
  # Deploy settlement_gateway
  stellar contract deploy --wasm target/wasm32-unknown-unknown/release/settlement_gateway.wasm --source admin --network testnet
  # Deploy SAC for wSRC
  stellar contract deploy --asset wSRC:ISSUER --source issuer --network testnet
  # Set SAC admin to gateway (anchor does NOT custody)
  stellar contract invoke --id <sac_id> --source issuer --network testnet -- set_admin --new_admin <gateway_id>
  # Set VK for ZK (768-byte real Groth16 VK)
  stellar contract invoke --id <registry_id> --source admin --network testnet -- set_vk --admin <admin> --vk <vk_hex>
  # Register domain
  stellar contract invoke --id <registry_id> --source admin --network testnet -- register_domain --adapter_id <32bytes> --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"
  # Admit domain after selftest
  stellar contract invoke --id <registry_id> --source admin --network testnet -- admit_domain --domain <domain_key>
  # Initialize gateway
  stellar contract invoke --id <gateway_id> --source admin --network testnet -- initialize --admin <admin> --registry <registry_id> --token <sac_id>
  # Test BLS happy path
  cargo run -p source_simulator -- --port 3001 &
  curl -X POST http://localhost:3001/lock -H "Content-Type: application/json" -d '{"amount":100,"recipient":"G..."}'
  curl http://localhost:3001/proof?height=1&kind=bls
  # Submit via relayer
  REGISTRY_ID=<id> GATEWAY_ID=<id> cargo run -p relayer -- --sim-url http://localhost:3001 --rpc https://soroban-testnet.stellar.org
NEXT
  exit 0
fi

echo "Stellar CLI found: $(stellar --version)"

# Generate keys if not exist
if ! stellar keys ls 2>&1 | grep -q admin; then
  echo "Generating admin key..."
  stellar keys generate admin --network $NETWORK
  stellar keys fund admin --network $NETWORK || curl -s "$FRIENDBOT?addr=$(stellar keys public-key admin)" > /dev/null || true
fi

if ! stellar keys ls 2>&1 | grep -q issuer; then
  echo "Generating issuer key..."
  stellar keys generate issuer --network $NETWORK
  stellar keys fund issuer --network $NETWORK || curl -s "$FRIENDBOT?addr=$(stellar keys public-key issuer)" > /dev/null || true
fi

ADMIN_ADDR=$(stellar keys public-key admin)
ISSUER_ADDR=$(stellar keys public-key issuer)

echo "Admin: $ADMIN_ADDR"
echo "Issuer: $ISSUER_ADDR"

echo "Building contracts..."
stellar contract build

echo "Deploying finality_registry (hardened with FinalizedRecord, DomainProfile, submit_bls_hardened)..."
REGISTRY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/finality_registry.wasm --source admin --network $NETWORK -- --admin $ADMIN_ADDR 2>&1 | tail -1)
echo "Registry: $REGISTRY_ID"

echo "Deploying settlement_gateway (hardened with Merkle proof, HWM, ProcessedMessage)..."
GATEWAY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/settlement_gateway.wasm --source admin --network $NETWORK 2>&1 | tail -1)
echo "Gateway: $GATEWAY_ID"

echo "Deploying SAC for wSRC..."
TOKEN_ID=$(stellar contract deploy --asset wSRC:$ISSUER_ADDR --source issuer --network $NETWORK 2>&1 | tail -1)
echo "Token SAC: $TOKEN_ID"

echo "Setting SAC admin to gateway (anchor does NOT run custodial bridge)..."
stellar contract invoke --id $TOKEN_ID --source issuer --network $NETWORK -- set_admin --new_admin $GATEWAY_ID

echo "Setting VK for ZK (768-byte real Groth16 BN254 VK)..."
VK_HEX=$(cat circuits/range_proof_vk.hex | tr -d '\n' | tr -d ' ')
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- set_vk --admin $ADMIN_ADDR --vk $VK_HEX

echo "Registering domain source-testnet..."
ADAPTER_ID="0202020202020202020202020202020202020202020202020202020202020202"
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- register_domain --adapter_id $ADAPTER_ID --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"

echo "Computing domain key..."
DOMAIN_KEY=$(echo -n "${ADAPTER_ID}source-testnet" | python3 -c "import hashlib, sys; data=sys.stdin.read(); print(hashlib.sha256(bytes.fromhex('$ADAPTER_ID') + b'source-testnet').hexdigest())" 2>/dev/null || echo "domain-key-placeholder")
echo "Domain key: $DOMAIN_KEY"

echo "Initializing gateway..."
stellar contract invoke --id $GATEWAY_ID --source admin --network $NETWORK -- initialize --admin $ADMIN_ADDR --registry $REGISTRY_ID --token $TOKEN_ID

mkdir -p deployments
cat > deployments/testnet.json <<JSON
{
  "network": "testnet",
  "rpc_url": "$RPC_URL",
  "contracts": {
    "finality_registry": "$REGISTRY_ID",
    "settlement_gateway": "$GATEWAY_ID",
    "token_sac": "$TOKEN_ID"
  },
  "issuer": "$ISSUER_ADDR",
  "admin": "$ADMIN_ADDR",
  "domain_key": "$DOMAIN_KEY",
  "explorer": {
    "registry": "https://stellar.expert/explorer/testnet/contract/$REGISTRY_ID",
    "gateway": "https://stellar.expert/explorer/testnet/contract/$GATEWAY_ID",
    "token": "https://stellar.expert/explorer/testnet/contract/$TOKEN_ID"
  },
  "hardening": {
    "bls": "Real BLS aggregate 3 validators",
    "merkle": "Binary Merkle tree",
    "hwm": "High-water-mark replay protection",
    "zk": "Groth16 BN254"
  }
}
JSON

echo "Deploy complete (hardened). See deployments/testnet.json"
cat deployments/testnet.json
echo ""
echo "Next: run simulator, relayer, frontend"
echo "  cargo run -p source_simulator -- --port 3001 &"
echo "  cargo run -p relayer -- --sim-url http://localhost:3001 --rpc $RPC_URL"
echo "  cd frontend && npm install && npm run dev"
echo "  cd anchor && PORT=8081 SIM_URL=http://localhost:3001 REGISTRY_ID=$REGISTRY_ID GATEWAY_ID=$GATEWAY_ID npm start"
