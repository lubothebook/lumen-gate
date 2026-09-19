#!/bin/bash
set -e

# Lumen Gate - Testnet Deploy Script (hardened)
# Requires: stellar CLI (cargo install stellar-cli), funded testnet account

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
FRIENDBOT="https://friendbot.stellar.org"

echo "=== Lumen Gate Deploy (hardened) ==="
echo "Network: $NETWORK, RPC: $RPC_URL"
echo "Hardened: BLS aggregate + Merkle + HWM + Groth16 BN254 + SAC set_admin"

if ! command -v stellar &> /dev/null; then
  echo "stellar CLI not found; refusing to create a fake deployment manifest." >&2
  echo "Install with: cargo install stellar-cli --locked" >&2
  exit 1
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
REGISTRY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/finality_registry.wasm --source admin --network $NETWORK 2>&1 | tail -1)
echo "Registry: $REGISTRY_ID"

echo "Deploying settlement_gateway (hardened with Merkle proof, HWM, ProcessedMessage)..."
GATEWAY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/settlement_gateway.wasm --source admin --network $NETWORK 2>&1 | tail -1)
echo "Gateway: $GATEWAY_ID"

echo "Deploying SAC for wSRC..."
TOKEN_ID=$(stellar contract deploy --asset wSRC:$ISSUER_ADDR --source issuer --network $NETWORK 2>&1 | tail -1)
echo "Token SAC: $TOKEN_ID"

echo "Setting SAC admin to gateway (anchor does NOT run custodial bridge)..."
stellar contract invoke --id $TOKEN_ID --source issuer --network $NETWORK -- set_admin --new_admin $GATEWAY_ID

echo "Setting VK for ZK (768-byte development Groth16 BN254 VK)..."
VK_HEX=$(cat circuits/range_proof_vk.hex | tr -d '\n' | tr -d ' ')
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- set_vk --admin $ADMIN_ADDR --vk $VK_HEX

echo "Registering BLS and ZK source-testnet domains..."
ADAPTER_ID=$(printf "source-chain-bls-v1" | sha256sum | cut -d" " -f1)
ZK_ADAPTER_ID=$(printf "source-chain-zk-v1" | sha256sum | cut -d" " -f1)
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- register_domain --admin $ADMIN_ADDR --adapter_id $ADAPTER_ID --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- register_domain --admin $ADMIN_ADDR --adapter_id $ZK_ADAPTER_ID --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"

echo "Computing domain keys..."
DOMAIN_KEY=$(echo -n "${ADAPTER_ID}source-testnet" | python3 -c "import hashlib, sys; data=sys.stdin.read(); print(hashlib.sha256(bytes.fromhex('$ADAPTER_ID') + b'source-testnet').hexdigest())" 2>/dev/null || echo "domain-key-placeholder")
ZK_DOMAIN_KEY=$(echo -n "${ZK_ADAPTER_ID}source-testnet" | python3 -c "import hashlib, sys; data=sys.stdin.read(); print(hashlib.sha256(bytes.fromhex('$ZK_ADAPTER_ID') + b'source-testnet').hexdigest())" 2>/dev/null || echo "zk-domain-key-placeholder")
TARGET_DOMAIN=$(printf 'lumen-gate-stellar-testnet' | sha256sum | cut -d" " -f1)
echo "BLS domain key: $DOMAIN_KEY"
echo "ZK domain key: $ZK_DOMAIN_KEY"
echo "Target domain: $TARGET_DOMAIN"

BLS_PUBKEY_HEX=${BLS_PUBKEY_HEX:-}
if [ -z "$BLS_PUBKEY_HEX" ] || [ "${#BLS_PUBKEY_HEX}" -ne 384 ]; then
  echo "BLS_PUBKEY_HEX must be the 192-byte aggregate public key from the source simulator proof." >&2
  echo "Example: curl -s 'http://localhost:3001/proof?height=1&kind=bls' | jq -r .payload.pubkey_hex" >&2
  exit 1
fi

echo "Pinning domain BLS policy..."
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- set_bls_policy --admin $ADMIN_ADDR --domain $DOMAIN_KEY --aggregate_pubkey $BLS_PUBKEY_HEX --signer_count 3 --required 2 --slashable false
echo "Admitting BLS and ZK domains after policy setup..."
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- admit_domain --admin $ADMIN_ADDR --domain $DOMAIN_KEY
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- admit_domain --admin $ADMIN_ADDR --domain $ZK_DOMAIN_KEY

echo "Initializing gateway..."
stellar contract invoke --id $GATEWAY_ID --source admin --network $NETWORK -- initialize --admin $ADMIN_ADDR --registry $REGISTRY_ID --token $TOKEN_ID

echo "Renouncing registry and gateway admin after immutable setup..."
mkdir -p deployments
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- renounce_admin --admin $ADMIN_ADDR | tee deployments/admin-renounce.txt
stellar contract invoke --id $GATEWAY_ID --source admin --network $NETWORK -- renounce_admin --admin $ADMIN_ADDR | tee deployments/gateway-admin-renounce.txt

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
  "admin_renounced": true,
  "gateway_admin_renounced": true,
  "admin_renounce_receipt": "deployments/admin-renounce.txt",
  "gateway_admin_renounce_receipt": "deployments/gateway-admin-renounce.txt",
  "domain_key": "$DOMAIN_KEY",
  "zk_domain_key": "$ZK_DOMAIN_KEY",
  "target_domain": "$TARGET_DOMAIN",
  "bls_policy": {
    "aggregate_pubkey": "$BLS_PUBKEY_HEX",
    "signer_count": 3,
    "required": 2
  },
  "explorer": {
    "registry": "https://stellar.expert/explorer/testnet/contract/$REGISTRY_ID",
    "gateway": "https://stellar.expert/explorer/testnet/contract/$GATEWAY_ID",
    "token": "https://stellar.expert/explorer/testnet/contract/$TOKEN_ID"
  },
  "hardening": {
    "bls": "Real BLS aggregate, demo 2-of-3 validators",
    "merkle": "Binary Merkle tree",
    "hwm": "High-water-mark replay protection",
    "zk": "Groth16 BN254 development fixture; root binding must be validated before live mint"
  }
}
JSON

echo "Deploy complete (hardened). See deployments/testnet.json"
cat deployments/testnet.json
echo ""
echo "Next: run simulator, relayer, frontend"
echo "  SOURCE_ASSET_ID=$TOKEN_ID cargo run -p source_simulator -- --port 3001 &"
echo "  cargo run -p relayer -- --sim-url http://localhost:3001 --rpc $RPC_URL"
echo "  cd frontend && npm install && npm run dev"
echo "  cd anchor && PORT=8081 SIM_URL=http://localhost:3001 REGISTRY_ID=$REGISTRY_ID GATEWAY_ID=$GATEWAY_ID npm start"
