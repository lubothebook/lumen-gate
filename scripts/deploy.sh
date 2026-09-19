#!/bin/bash
set -e

# Migrate to Stellar - Testnet Deploy Script
# Requires: stellar CLI (cargo install stellar-cli), funded testnet account

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
FRIENDBOT="https://friendbot.stellar.org"

echo "=== Migrate to Stellar Deploy ==="
echo "Network: $NETWORK, RPC: $RPC_URL"

if ! command -v stellar &> /dev/null; then
  echo "stellar CLI not found. Install with: cargo install stellar-cli --locked"
  echo "For this hackathon demo, we will show what the script WOULD do and create placeholder deployment file."
  echo "To actually deploy, run this script after installing stellar CLI."
  
  mkdir -p deployments
  cat > deployments/testnet.json <<'JSON'
{
  "network": "testnet",
  "rpc_url": "https://soroban-testnet.stellar.org",
  "note": "Placeholder - replace with real contract IDs after stellar CLI deploy",
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
      "domain_key": "sha256(adapter_id || network)"
    }
  },
  "vk": {
    "source": "circuits/range_proof_vk.hex (768 bytes, real Groth16 BN254 VK)",
    "note": "Apache-2.0 from stellar-zkstream"
  }
}
JSON
  echo "Created deployments/testnet.json placeholder"
  echo "Next steps (with stellar CLI):"
  cat <<'NEXT'
  stellar keys generate admin --network testnet --fund
  stellar keys generate issuer --network testnet --fund
  stellar contract build
  stellar contract deploy --wasm target/wasm32-unknown-unknown/release/finality_registry.wasm --source admin --network testnet -- --admin <admin_address>
  stellar contract deploy --wasm target/wasm32-unknown-unknown/release/settlement_gateway.wasm --source admin --network testnet
  stellar contract deploy --asset wSRC:ISSUER --source issuer --network testnet  # SAC
  stellar contract invoke --id <sac_id> --source issuer --network testnet -- set_admin --new_admin <gateway_id>
  stellar contract invoke --id <registry_id> --source admin --network testnet -- set_vk --admin <admin> --vk <vk_hex>
  stellar contract invoke --id <registry_id> --source admin --network testnet -- register_domain --adapter_id <32bytes> --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"
NEXT
  exit 0
fi

echo "Stellar CLI found: $(stellar --version)"

# Generate keys if not exist
if ! stellar keys ls | grep -q admin; then
  echo "Generating admin key..."
  stellar keys generate admin --network $NETWORK
  stellar keys fund admin --network $NETWORK || curl -s "$FRIENDBOT?addr=$(stellar keys public-key admin)" > /dev/null
fi

if ! stellar keys ls | grep -q issuer; then
  echo "Generating issuer key..."
  stellar keys generate issuer --network $NETWORK
  stellar keys fund issuer --network $NETWORK || curl -s "$FRIENDBOT?addr=$(stellar keys public-key issuer)" > /dev/null
fi

ADMIN_ADDR=$(stellar keys public-key admin)
ISSUER_ADDR=$(stellar keys public-key issuer)

echo "Admin: $ADMIN_ADDR"
echo "Issuer: $ISSUER_ADDR"

echo "Building contracts..."
stellar contract build

echo "Deploying finality_registry..."
REGISTRY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/finality_registry.wasm --source admin --network $NETWORK -- --admin $ADMIN_ADDR 2>&1 | tail -1)
echo "Registry: $REGISTRY_ID"

echo "Deploying settlement_gateway..."
GATEWAY_ID=$(stellar contract deploy --wasm target/wasm32-unknown-unknown/release/settlement_gateway.wasm --source admin --network $NETWORK 2>&1 | tail -1)
echo "Gateway: $GATEWAY_ID"

echo "Deploying SAC for wSRC..."
TOKEN_ID=$(stellar contract deploy --asset wSRC:$ISSUER_ADDR --source issuer --network $NETWORK 2>&1 | tail -1)
echo "Token SAC: $TOKEN_ID"

echo "Setting SAC admin to gateway..."
stellar contract invoke --id $TOKEN_ID --source issuer --network $NETWORK -- set_admin --new_admin $GATEWAY_ID

echo "Setting VK for ZK..."
VK_HEX=$(cat circuits/range_proof_vk.hex)
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- set_vk --admin $ADMIN_ADDR --vk $VK_HEX

echo "Registering domain..."
ADAPTER_ID_BLS=$(echo -n "source-chain-bls-v1" | sha256sum | cut -d' ' -f1 | xxd -r -p | sha256sum | cut -d' ' -f1)
# For simplicity, use 32 bytes of 0x02 for adapter_id in demo
ADAPTER_ID="0202020202020202020202020202020202020202020202020202020202020202"
stellar contract invoke --id $REGISTRY_ID --source admin --network $NETWORK -- register_domain --adapter_id $ADAPTER_ID --network source-testnet --required_depth 2 --adapter_version 1 --accepted_versions "[1]"

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
  "explorer": {
    "registry": "https://stellar.expert/explorer/testnet/contract/$REGISTRY_ID",
    "gateway": "https://stellar.expert/explorer/testnet/contract/$GATEWAY_ID",
    "token": "https://stellar.expert/explorer/testnet/contract/$TOKEN_ID"
  }
}
JSON

echo "Deploy complete. See deployments/testnet.json"
cat deployments/testnet.json

