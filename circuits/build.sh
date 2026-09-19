#!/usr/bin/env bash
#
# Compile the circuits and produce the artifacts the verifier contract consumes.
#
# Two circuits live here and both are built by this script:
#
#   settlement_statement_fixture.circom  the earlier single-statement fixture
#   finality_statement.circom            the single-statement finality circuit
#   step_chain_statement.circom          the multi-step chained circuit
#   execution_trace.circom               the execution lane's trace circuit
#   gate_vm.circom                       the gate-vm lane: a register machine
#                                        whose program is committed, not published
#   gate_vm32.circom                       the same core at 32 lines / 32 rows
#   signature_gadget_probe.circom          measured cost of a verify-signature
#                                          gadget (feasibility only; not a lane)
#   sha256_block_probe.circom              measured cost of one SHA-256
#                                          compression block (feasibility only)
#   poseidon_probe.circom                Poseidon calibration circuit; see
#                                        gen_poseidon_probe.py — not a proof lane
#
# The include path is assembled at build time instead of being vendored into the
# repository: circomlib is already a pinned dependency in package.json, and a
# second checked-in copy of it would be a version that silently drifts away from
# the pinned one.
#
# Usage:
#   circuits/build.sh                 # compile every circuit, write r1cs+wasm to build/
#
# The trace circuit is the largest of the four (about ten and a half thousand
# constraints); its setup needs a 2^14 powers-of-tau file, which is why
# circuits/setup.sh defaults to that size.
#   circuits/build.sh step_chain_statement   # compile one
#
# Requires: circom 2.2.3 on PATH (or CIRCOM=/path/to/circom), npm install done.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUILD="${BUILD_DIR:-$ROOT/build}"
CIRCOM="${CIRCOM:-circom}"

if ! command -v "$CIRCOM" >/dev/null 2>&1; then
  echo "circom not found. Install 2.2.3 (the version the artifacts were produced with):" >&2
  echo "  curl -sSL -o ~/.local/bin/circom https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64" >&2
  echo "  chmod +x ~/.local/bin/circom" >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules/circomlib/circuits" ]; then
  echo "circomlib is missing. Run: npm install --no-audit --no-fund" >&2
  exit 1
fi

echo "circom: $("$CIRCOM" --version)"
mkdir -p "$BUILD"
mkdir -p "$BUILD/include"

# circom resolves `include "circomlib/x.circom"` against the -l paths, so the
# path handed to -l is the one *containing* the circomlib directory.
if [ ! -e "$BUILD/include/circomlib" ]; then
  ln -s "$ROOT/node_modules/circomlib/circuits" "$BUILD/include/circomlib"
fi

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(settlement_statement_fixture finality_statement step_chain_statement execution_trace gate_vm gate_vm32 poseidon_probe signature_gadget_probe sha256_block_probe)
fi

for name in "${targets[@]}"; do
  source_file="$ROOT/circuits/$name.circom"
  if [ ! -f "$source_file" ]; then
    echo "no such circuit: $source_file" >&2
    exit 1
  fi
  echo
  echo "== $name =="
  "$CIRCOM" "$source_file" --r1cs --wasm --sym -o "$BUILD" -l "$BUILD/include"
  r1cs="$BUILD/$name.r1cs"
  if [ -f "$r1cs" ]; then
    echo "  constraints: $("$CIRCOM" "$source_file" --r1cs --wasm -o "$BUILD" -l "$BUILD/include" 2>&1 | grep -E 'non-linear constraints|linear constraints' | tr '\n' ' ')"
    ls -l "$r1cs" | awk '{print "  r1cs bytes: "$5}'
  fi
done

echo
echo "artifacts in $BUILD"
