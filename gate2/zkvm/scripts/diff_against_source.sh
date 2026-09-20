#!/usr/bin/env bash
# diff_against_source.sh - list every difference between this workspace and the
# upstream source it was copied from.
#
# DIRECTIVE 2.0-ZKVM rule 5 (fidelity to source): every deviation must appear in
# PROVENANCE.md under patches[]. This script is how that claim is checked rather
# than asserted. Output that is not covered by patches[] is a finding.
#
# The imported files were renamed on the way in (bud-* -> zk-*, .bud -> .zkl,
# and the source project's name was scrubbed - see PROVENANCE.md, deliberate
# and recorded). Comparing raw bytes would therefore report every single file as
# different and tell us nothing. So the comparison normalises exactly that
# rename, and nothing else: anything still differing after normalisation is a
# real content change.
#
# Usage:
#   scripts/diff_against_source.sh [path-to-source-checkout]
#
# The source checkout is the budlum monorepo; the tree compared is its
# budzero/ workspace. If no path is given the script looks in a few usual
# places and otherwise explains how to get one.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SOURCE_SHA="d8423b773d54b12e84b256dba1570b9b20c0465c"
SOURCE_URL="https://github.com/budlum-xyz/budlum"

SRC_ROOT="${1:-}"
if [[ -z "$SRC_ROOT" ]]; then
  for candidate in "$HERE/../../../src/budlum" "$HOME/src/budlum" "/tmp/budlum"; do
    if [[ -d "$candidate/budzero" ]]; then SRC_ROOT="$candidate"; break; fi
  done
fi

if [[ -z "$SRC_ROOT" || ! -d "$SRC_ROOT/budzero" ]]; then
  cat <<EOF
No source checkout found.

  git clone $SOURCE_URL /tmp/budlum
  git -C /tmp/budlum checkout $SOURCE_SHA
  $0 /tmp/budlum

Pinned source: $SOURCE_URL @ $SOURCE_SHA
EOF
  exit 2
fi

SRC="$SRC_ROOT/budzero"

if command -v git >/dev/null 2>&1 && [[ -d "$SRC_ROOT/.git" ]]; then
  actual_sha="$(git -C "$SRC_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ "$actual_sha" != "$SOURCE_SHA" ]]; then
    echo "WARNING: source checkout is at $actual_sha, pinned SHA is $SOURCE_SHA" >&2
    echo "         Differences below may be upstream drift rather than local patches." >&2
    echo >&2
  fi
fi

# Normalise the recorded rename, and only that.
normalise() {
  sed -e 's/zk_isa/bud_isa/g' \
      -e 's/zk_vm/bud_vm/g' \
      -e 's/zk_compiler/bud_compiler/g' \
      -e 's/zk_proof/bud_proof/g' \
      -e 's/zk_state/bud_state/g' \
      -e 's/zk-isa/bud-isa/g' \
      -e 's/zk-vm/bud-vm/g' \
      -e 's/zk-compiler/bud-compiler/g' \
      -e 's/zk-proof/bud-proof/g' \
      -e 's/zk-state/bud-state/g' \
      -e 's/zk-cli/bud-cli/g' \
      -e 's/zk_stark/bud_stark/g' \
      -e 's/zkzero/budzero/g' \
      -e 's/ZkLang/BudL/g' \
      -e 's/zkl/bud/g' \
      "$1"
}

# crate dir here -> crate dir in source
PAIRS=(
  "zk-isa:bud-isa"
  "zk-vm:bud-vm"
  "zk-compiler:bud-compiler"
  "zk-proof:bud-proof"
  "zk-state:bud-state"
  "verifier-registry:verifier-registry"
)

differing=0
missing=0
local_only=0

echo "Comparing $HERE"
echo "     with $SRC"
echo "   pinned $SOURCE_SHA"
echo

for pair in "${PAIRS[@]}"; do
  here_dir="${pair%%:*}"
  src_dir="${pair##*:}"
  [[ -d "$HERE/$here_dir" ]] || continue

  while IFS= read -r f; do
    rel="${f#"$HERE/$here_dir/"}"
    # The one directory that was renamed as well as its contents.
    src_rel="${rel//zk_stark/bud_stark}"
    src_file="$SRC/$src_dir/$src_rel"
    if [[ ! -f "$src_file" ]]; then
      echo "LOCAL-ONLY  $here_dir/$rel"
      local_only=$((local_only + 1))
      continue
    fi
    if ! diff -q <(normalise "$f") "$src_file" >/dev/null 2>&1; then
      n=$(diff <(normalise "$f") "$src_file" | grep -c '^[<>]')
      echo "DIFFERS     $here_dir/$rel  ($n changed lines)"
      differing=$((differing + 1))
    fi
  done < <(find "$HERE/$here_dir" -type f \( -name '*.rs' -o -name '*.toml' \) -not -path '*/target/*' | sort)

  while IFS= read -r f; do
    rel="${f#"$SRC/$src_dir/"}"
    here_rel="${rel//bud_stark/zk_stark}"
    [[ -f "$HERE/$here_dir/$here_rel" ]] || { echo "NOT-COPIED  $src_dir/$rel"; missing=$((missing + 1)); }
  done < <(find "$SRC/$src_dir" -type f \( -name '*.rs' -o -name '*.toml' \) -not -path '*/target/*' | sort)
done

echo
echo "Crates present here but not compared (Gate-authored, no upstream twin):"
for d in parity note-packing; do
  [[ -d "$HERE/$d" ]] && echo "  $d"
done

echo
echo "summary: $differing differing, $local_only local-only, $missing not-copied"
echo
echo "Every DIFFERS / LOCAL-ONLY line above must have an entry in PROVENANCE.md"
echo "under patches[]. NOT-COPIED lines are expected for crates left behind on"
echo "purpose; the excluded set is listed in evidence.json."
