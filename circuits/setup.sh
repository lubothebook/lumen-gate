#!/usr/bin/env bash
#
# Trusted setup and proving pipeline for a circuit in this directory.
#
# Groth16 needs a structured reference string. The ceremony here is generated
# locally with a single contribution and is explicitly NOT a production
# ceremony: whoever ran it could, in principle, know the toxic waste. That is
# acceptable for a testnet demonstration and is stated as a limitation in the
# README; it is not acceptable for value-bearing deployment, where the powers of
# tau come from a multi-party ceremony nobody can reproduce.
#
# Usage:
#   circuits/setup.sh step_chain_statement            # setup + honest proof
#   circuits/setup.sh step_chain_statement --verify    # then verify the proof
#
# Outputs into build/:
#   <circuit>_js/<circuit>.wasm     witness generator
#   <circuit>.zkey                  proving key
#   <circuit>_vk.json               verification key (converted to Soroban bytes
#                                   by circuits/convert_to_soroban.py)
#   <circuit>_proof.json, <circuit>_public.json

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUILD="${BUILD_DIR:-$ROOT/build}"
POWER="${PTAU_POWER:-13}"           # 2^13 = 8192 >= the circuit's constraint count
SNARKJS="${SNARKJS:-$ROOT/node_modules/.bin/snarkjs}"
CIRCUIT="${1:?usage: circuits/setup.sh <circuit-name>}"
INPUT="${2:-$BUILD/${CIRCUIT}_input.json}"

if [ ! -x "$SNARKJS" ]; then
  echo "snarkjs not found at $SNARKJS. Run: npm install --no-audit --no-fund" >&2
  exit 1
fi

mkdir -p "$BUILD"

echo "== 1. circuit =="
./circuits/build.sh "$CIRCUIT"

echo
echo "== 2. powers of tau (local ceremony, 2^$POWER) =="
if [ ! -f "$BUILD/pot${POWER}_final.ptau" ]; then
  "$SNARKJS" powersoftau new bn128 "$POWER" "$BUILD/pot${POWER}_0000.ptau" -v 2>&1 | tail -2
  "$SNARKJS" powersoftau contribute "$BUILD/pot${POWER}_0000.ptau" "$BUILD/pot${POWER}_0001.ptau" \
    --name="lumen-gate local ceremony, not a production ceremony" -e="lumen-gate local entropy" 2>&1 | tail -2
  "$SNARKJS" powersoftau prepare phase2 "$BUILD/pot${POWER}_0001.ptau" "$BUILD/pot${POWER}_final.ptau" -v 2>&1 | tail -2
else
  echo "reusing $BUILD/pot${POWER}_final.ptau"
fi

echo
echo "== 3. groth16 setup =="
"$SNARKJS" groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$BUILD/pot${POWER}_final.ptau" "$BUILD/${CIRCUIT}_0000.zkey" 2>&1 | tail -2
"$SNARKJS" zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}.zkey" \
  --name="lumen-gate local contribution" -e="lumen-gate local entropy" 2>&1 | tail -2
"$SNARKJS" zkey export verificationkey "$BUILD/${CIRCUIT}.zkey" "$BUILD/${CIRCUIT}_vk.json" 2>&1 | tail -2

echo
echo "== 4. honest witness and proof =="
if [ ! -f "$INPUT" ]; then
  echo "input file $INPUT is missing; generate it first (tools/step-chain-input.mjs)" >&2
  exit 1
fi
"$SNARKJS" wtns calculate "$BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm" "$INPUT" "$BUILD/${CIRCUIT}.wtns" 2>&1 | tail -2
"$SNARKJS" groth16 prove "$BUILD/${CIRCUIT}.zkey" "$BUILD/${CIRCUIT}.wtns" \
  "$BUILD/${CIRCUIT}_proof.json" "$BUILD/${CIRCUIT}_public.json" 2>&1 | tail -2

echo
echo "== 5. verify =="
"$SNARKJS" groth16 verify "$BUILD/${CIRCUIT}_vk.json" "$BUILD/${CIRCUIT}_public.json" "$BUILD/${CIRCUIT}_proof.json"

cat <<EOF

artifacts:
  $BUILD/${CIRCUIT}.zkey
  $BUILD/${CIRCUIT}_vk.json
  $BUILD/${CIRCUIT}_proof.json
  $BUILD/${CIRCUIT}_public.json

next:
  python3 circuits/convert_to_soroban.py $BUILD/${CIRCUIT}_vk.json $BUILD/${CIRCUIT}_proof.json \\
      $BUILD/${CIRCUIT}_public.json $BUILD/${CIRCUIT}
EOF
