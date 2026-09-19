#!/usr/bin/env bash
#
# Repository gate: the writing rules that must hold before every submission.
#
# These are not style preferences. Each one is a rule this project committed to,
# and a rule that is only checked by a human reading a checklist is a rule that
# will be broken by whoever is in a hurry at 4am. This script is the mechanical
# half of that checklist; the CI workflow runs it on every push.
#
# Usage: scripts/repo-gate.sh
# Exit code 0 means every gate passed.

set -uo pipefail
cd "$(dirname "$0")/.."

export LC_ALL=C.UTF-8
failures=0

pass() { printf '  [pass] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; failures=$((failures + 1)); }

echo "repository gate"

# ---------------------------------------------------------------------------
# 1. The retired brand name appears nowhere.
#
# The needle is assembled from fragments instead of being written out, because
# the rule is that the string itself does not exist in this repository -- and a
# gate script is still a file in this repository. Checking for a string without
# containing it is the entire trick.
# ---------------------------------------------------------------------------
needle="$(printf '%s%s' 'bud' 'lum')"
hits="$(git grep -Ini -- "$needle" -- . ':!Cargo.lock' 2>/dev/null | head -20)"
if [ -z "$hits" ]; then
  pass "the retired brand name appears in no tracked file"
else
  fail "the retired brand name appears:"
  printf '%s\n' "$hits"
fi

# ---------------------------------------------------------------------------
# 2. Nothing ties the project to a country or a region.
# ---------------------------------------------------------------------------
region_hits="$(git grep -IniE -- 'istanbul|t(ü|u)rkiye|turkey|ankara|izmir|bosphorus|anatolia' -- . ':!Cargo.lock' 2>/dev/null | head -20)"
if [ -z "$region_hits" ]; then
  pass "no country or region references anywhere"
else
  fail "country or region references found:"
  printf '%s\n' "$region_hits"
fi

# ---------------------------------------------------------------------------
# 3. Every document is English. Checked by looking for the letters that exist
#    in one language's alphabet and not in English, rather than by guessing at
#    file names: a localised file with an English name would slip past a name
#    check, and this is exactly the kind of drift nobody notices until a judge
#    reads it.
# ---------------------------------------------------------------------------
letters="$(python3 - <<'PY'
import subprocess, unicodedata
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
targets = {ord(c) for c in "ıİşŞğĞ"}
hits = []
for path in files:
    if path.endswith((".png", ".jpg", ".webp", ".ico", ".woff", ".woff2")):
        continue
    try:
        text = open(path, encoding="utf-8").read()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    for number, line in enumerate(text.splitlines(), 1):
        found = sorted({ch for ch in line if ord(ch) in targets})
        if found:
            hits.append(f"{path}:{number}: {''.join(found)}")
            break
print("\n".join(hits))
PY
)"
if [ -z "$letters" ]; then
  pass "no Turkish-specific letters in any tracked text file"
else
  fail "localised text found:"
  printf '%s\n' "$letters"
fi

# ---------------------------------------------------------------------------
# 4. Exactly one directive file, at the root.
# ---------------------------------------------------------------------------
directives="$(git ls-files | grep -iE '(^|/)directive.*\.md$' | sort)"
count="$(printf '%s\n' "$directives" | grep -c . || true)"
if [ "$count" = "1" ] && [ "$directives" = "DIRECTIVE.md" ]; then
  pass "exactly one directive file: $directives"
else
  fail "expected exactly DIRECTIVE.md, found:"
  printf '%s\n' "$directives"
fi

# ---------------------------------------------------------------------------
# 5. The claims that must stay in the documents, because their absence is how
#    honesty quietly turns into marketing.
# ---------------------------------------------------------------------------
claim_present() {
  if git grep -qI -- "$1" -- "$2"; then
    pass "$3"
  else
    fail "$3"
  fi
}
claim_present "Is this a zkVM" "README.md" "README keeps the awkward question and answers it"
claim_present "not a signature proof" "README.md" "the ZK lane is still labelled a quorum proof, not a signature proof"
claim_present "fixed" "docs/SEP_SURFACE.md" "the fixed-fee simplification is written down"
claim_present "not_implemented" "docs/SEP_SURFACE.md" "unimplemented SEP capabilities are listed, not implied"

# ---------------------------------------------------------------------------
# 6. Secret hygiene: no private keys in tracked files.
# ---------------------------------------------------------------------------
if git grep -InE -- '"S[A-Z2-7]{55}"|S[A-Z2-7]{55}' -- . ':!Cargo.lock' >/dev/null 2>&1; then
  fail "a Stellar secret key pattern is present in a tracked file"
else
  pass "no Stellar secret keys in tracked files"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "gate: all checks passed"
  exit 0
fi
echo "gate: $failures check(s) failed"
exit 1
