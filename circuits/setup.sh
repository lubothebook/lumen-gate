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
# The powers-of-tau size is derived from the circuit that is being set up: the
# smallest power of two that fits its constraint count. Four circuits of very
# different sizes share this script, and a hard-coded size either fails for the
# largest one or silently tells the ceremony less than it needs. The floor is
# 2^13: the three smaller circuits were set up at that size, and their
# verification keys are the ones frozen into deployments, so deriving a smaller
# ceremony for them would produce keys that do not match what is deployed.
# PTAU_POWER overrides the derivation when a specific ceremony is wanted.
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
POWER="${PTAU_POWER:-auto}"
POWER_FLOOR=13                      # the size the three earlier circuits were set up at
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

if [ "$POWER" = "auto" ]; then
  # The constraint count is read from the r1cs that step 1 just wrote, so the
  # number comes from the circuit rather than from a comment that can go stale.
  CONSTRAINT_COUNT=$("$SNARKJS" r1cs info "$BUILD/${CIRCUIT}.r1cs" \
    | sed -n 's/.*# of Constraints: *\([0-9]*\).*/\1/p' | tail -1)
  if [ -z "$CONSTRAINT_COUNT" ]; then
    echo "could not read the constraint count of $BUILD/${CIRCUIT}.r1cs" >&2
    exit 1
  fi
  POWER=$POWER_FLOOR
  SIZE=$((2 ** POWER))
  # the margin is for the public inputs and the domain the setup adds on top
  while [ "$SIZE" -lt "$((CONSTRAINT_COUNT + 1024))" ]; do
    POWER=$((POWER + 1))
    SIZE=$((SIZE * 2))
  done
  echo "circuit $CIRCUIT: $CONSTRAINT_COUNT constraints -> powers of tau 2^$POWER"
fi

echo
# The phase-1 source is a policy switch, not a convenience. `local` mints a
# fresh BN254 identity on this machine: everything downstream is sound but the
# toxic waste was never destroyed by anyone, and no third party can compare
# our verifier key against theirs. `phase1` takes the published Hermez
# ceremony output for this power, verifies its full contribution chain with
# `powersoftau verify`, and checks its sha256 against the pin recorded in
# circuits/PTAU_SHA256 — a first fetch records the pin after the chain
# verifies, and every later fetch must match it, so swapping a bucket object
# is a hard stop rather than a silent new key. `file:<path>` runs the same
# two checks on a locally supplied transcript, for setups that cannot reach
# the network. The zkey step is byte-identical under either source.
PTAU_SOURCE="${PTAU_SOURCE:-local}"
HEZ_BUCKET="${HEZ_BUCKET:-https://hermez.s3-eu-west-1.amazonaws.com}"
PTAU_DIR="$ROOT/circuits/ptau"
PINS="$ROOT/circuits/PTAU_SHA256"

phase1_verify_and_pin() { # $1 = file, $2 = label for messages
  local f="$1" label="$2" sha
  sha=$(sha256sum "$f" | awk '{print $1}')
  local pinned="" base
  base=$(basename "$f")
  if [ -f "$PINS" ]; then
    # keyed by filename, not by power: a transcript supplied as file:<path>
    # pins under its own name and can never shadow (or be shadowed by) the
    # entry a future download of the same power would check against
    pinned=$(awk -v n="$base" '$(NF) == n {print $1; exit}' "$PINS" || true)
  fi
  if [ -n "$pinned" ] && [ "$pinned" != "$sha" ]; then
    echo "$label: sha256 $sha does not match the pinned $pinned for 2^$POWER — refusing to build on it" >&2
    exit 1
  fi
  if [ ! -f "$f.verified" ]; then
    echo "verifying the contribution chain of $label (one-time, scales with the ceremony transcript)"
    "$SNARKJS" powersoftau verify "$f" 2>&1 | tail -2
    touch "$f.verified"
  else
    echo "contribution chain of $label was verified in an earlier run (marker: $f.verified)"
  fi
  if [ -z "$pinned" ]; then
    mkdir -p "$PTAU_DIR"
    echo "$sha  $base  # recorded $(date -u +%F) by circuits/setup.sh, after powersoftau verify passed on this exact file; a pin is where a chain verified locally agrees with the ceremony's published attestations only after someone checks it against them — for downloads, that audit is still owed" >> "$PINS"
    echo "pinned $base to sha256 $sha in circuits/PTAU_SHA256"
  fi
}

if [ "$PTAU_SOURCE" = "phase1" ]; then
  mkdir -p "$PTAU_DIR"
  PHASE2="$PTAU_DIR/powersOfTau28_hez_final_${POWER}.ptau"
  if [ ! -f "$PHASE2" ]; then
    echo "== 2. powers of tau: downloading the published 2^$POWER ceremony =="
    curl --fail --location --output "$PHASE2.part" "$HEZ_BUCKET/powersOfTau28_hez_final_${POWER}.ptau"
    mv "$PHASE2.part" "$PHASE2"
  else
    echo "== 2. powers of tau: using the downloaded 2^$POWER ceremony at $PHASE2 =="
  fi
  phase1_verify_and_pin "$PHASE2" "hermez 2^$POWER"
elif [ "${PTAU_SOURCE#file:}" != "$PTAU_SOURCE" ]; then
  PHASE2="${PTAU_SOURCE#file:}"
  [ -f "$PHASE2" ] || { echo "PTAU_SOURCE=$PTAU_SOURCE does not exist" >&2; exit 1; }
  echo "== 2. powers of tau: verifying the locally supplied transcript $PHASE2 =="
  phase1_verify_and_pin "$PHASE2" "supplied transcript"
else
  echo "== 2. powers of tau (LOCAL ceremony, 2^$POWER: real cryptography, nobody's entropy but ours) =="
  PHASE2="$BUILD/pot${POWER}_final.ptau"
  if [ ! -f "$PHASE2" ]; then
    "$SNARKJS" powersoftau new bn128 "$POWER" "$BUILD/pot${POWER}_0000.ptau" -v 2>&1 | tail -2
    "$SNARKJS" powersoftau contribute "$BUILD/pot${POWER}_0000.ptau" "$BUILD/pot${POWER}_0001.ptau" \
      --name="lumen-gate local ceremony, not a production ceremony" -e="${ENTROPY:-lumen-gate local entropy}" 2>&1 | tail -2
    "$SNARKJS" powersoftau prepare phase2 "$BUILD/pot${POWER}_0001.ptau" "$PHASE2" -v 2>&1 | tail -2
  else
    echo "reusing $PHASE2"
  fi
fi

echo
echo "== 3. groth16 setup =="
"$SNARKJS" groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$PHASE2" "$BUILD/${CIRCUIT}_0000.zkey" 2>&1 | tail -2
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
