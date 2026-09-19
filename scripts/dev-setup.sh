#!/usr/bin/env bash
#
# Restore the toolchain this repository is verified against.
#
# Written because a session that starts from a bare machine otherwise spends its
# first half hour rediscovering which Rust version the contracts build with and
# where the Stellar CLI comes from. Everything is installed under $HOME/.local,
# which is outside the repository on purpose: toolchains are not source code and
# do not belong in a commit.
#
# Usage: scripts/dev-setup.sh [install-root]
# Default install root: $HOME/.local

set -euo pipefail

ROOT="${1:-$HOME/.local}"
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/rust/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/rust/cargo}"
export PATH="$CARGO_HOME/bin:$ROOT/bin:$PATH"

TOOLCHAIN="1.98.1"
STELLAR_CLI_VERSION="28.0.0"

echo "install root: $ROOT"

mkdir -p "$ROOT/bin"

if ! command -v rustc >/dev/null 2>&1; then
  echo "installing rustup (minimal profile, $TOOLCHAIN)"
  curl -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
  sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain "$TOOLCHAIN" \
    --target wasm32-unknown-unknown --target wasm32v1-none --no-modify-path
else
  echo "rustc present: $(rustc --version)"
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "installing the Stellar CLI ($STELLAR_CLI_VERSION, x86_64 linux)"
  archive="/tmp/stellar-cli.tar.gz"
  curl -sSL -o "$archive" \
    "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  tar xzf "$archive" -C "$ROOT/bin"
  chmod +x "$ROOT/bin/stellar"
  rm -f "$archive"
else
  echo "stellar present: $(stellar --version | head -1)"
fi

echo
echo "toolchain ready:"
rustc --version
cargo --version
stellar --version | head -1
echo
echo "next:"
echo "  cargo test --workspace          # ${HOME:+}$(dirname "$0")/../README.md has the counts"
echo "  cargo build --workspace         # builds the simulator, the relayer and the adapter CLI"
cat <<'NOTE'

for the anchor facade and the audit loop, two more things are needed:

  1. a SEP-10 signing account (any funded testnet account works; the challenge
     transaction itself is never submitted anywhere):
       stellar keys generate sep10-anchor --network testnet
       stellar keys fund sep10-anchor --network testnet
       export SEP10_SIGNING_SECRET=$(stellar keys secret sep10-anchor)

  2. an identity for the audit loop's live probes, which submit real evidence:
       stellar keys generate audit-probe --network testnet
       stellar keys fund audit-probe --network testnet

  Neither secret belongs in this repository; the repository gate fails the build
  if a Stellar secret key ever appears in a tracked file.
NOTE
