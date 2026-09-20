#!/usr/bin/env bash
# Gate 1.0'in inbound lane'ini yerelde ucdan uca ayaga kaldirir.
#
# Bu dort surec olmadan lock/settle dugmeleri kapali kalir - kod bozuk oldugu
# icin degil, konusacak bir kaynak zinciri olmadigi icin.
#
#   8080  source-sim        deterministik kaynak zinciri
#   8081  operator-facade   relayer gecisi (imzalamada durur, asagiya bak)
#   3001  api-dev-server    /api/* handler'lari
#   5175  vite              1.0 konsolu
#
# Not: facade kasitli olarak ZINCIRE YAZMAZ. source-sim gercek BLS anahtarlari
# tutmadigi icin urettigi ozetler submit_bls_hardened'in pairing kontrolunu
# gecemez - gecmemeli de. Gercek imzaci seti saglanana kadar settle,
# 'unsigned_evidence' ile reddedilir.
set -euo pipefail
cd "$(dirname "$0")/.."

export OPERATOR_TOKEN="${OPERATOR_TOKEN:-devtoken}"
export SOURCE_URL="${SOURCE_URL:-http://127.0.0.1:8080}"
export OPERATOR_URL="${OPERATOR_URL:-http://127.0.0.1:8081}"

node tools/source-sim.js &
node tools/operator-facade.js &
node tools/api-dev-server.js &
( cd frontend && npx vite --host 0.0.0.0 --port 5175 ) &

echo "stack up: sim 8080, facade 8081, api 3001, console http://127.0.0.1:5175/"
echo "operator token: $OPERATOR_TOKEN"
wait
