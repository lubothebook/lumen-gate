#!/bin/bash
set -e
echo "=== Migrate to Stellar Demo ==="
echo "This script demos the full flow without needing Freighter"

SIM_URL=${SIM_URL:-http://localhost:3001}
echo "Simulator URL: $SIM_URL"

echo ""
echo "[1] Simulator info (real HTTP)"
curl -s $SIM_URL/info | head -20

echo ""
echo "[2] Latest block"
curl -s $SIM_URL/blocks/latest | jq .

echo ""
echo "[3] Lock on source (100 wSRC)"
LOCK_RES=$(curl -s -X POST $SIM_URL/lock -H "Content-Type: application/json" -d '{"amount":100,"recipient":"G-TEST-RECIPIENT","sender":"demo"}')
echo $LOCK_RES | jq .
HEIGHT=$(echo $LOCK_RES | jq -r .block_height)
echo "New height: $HEIGHT"

echo ""
echo "[4] Get BLS proof for height $HEIGHT"
curl -s "$SIM_URL/proof?height=$HEIGHT&kind=bls" | jq . | head -40

echo ""
echo "[5] Get ZK proof for height $HEIGHT (real Groth16)"
curl -s "$SIM_URL/proof?height=$HEIGHT&kind=zk" | jq . | head -40

echo ""
echo "[6] Negative tests"
echo "  - Bad sig (zeroed)"
curl -s "$SIM_URL/proof?height=$HEIGHT&kind=bls&tamper=sig" | jq .payload | head -5
echo "  Should be rejected with InvalidSignature in contract"

echo "  - Bad root (mismatch)"
curl -s "$SIM_URL/proof?height=$HEIGHT&kind=bls&tamper=root" | jq .declared_root
echo "  Should be rejected with DeclaredMismatch"

echo ""
echo "[7] Soroban testnet RPC check (real Stellar connection)"
curl -s -X POST https://soroban-testnet.stellar.org -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' | head -20

echo ""
echo "Demo complete. For full UI, run frontend: cd frontend && npm install && npm run dev"
