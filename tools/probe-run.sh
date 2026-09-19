#!/usr/bin/env bash
# Start the facade, run the conformance probe against it, tear it down.
# One foreground command, no leftover processes: this is how the checks in
# tools/sep-conformance.js are meant to be exercised end to end.
set -u
cd "$(dirname "$0")/.."

PORT="${PROBE_PORT:-8125}"
SECRET_FILE="${PROBE_SECRET_FILE:-/tmp/lumen-probe-secret}"
if [ ! -s "$SECRET_FILE" ]; then
  node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())" > "$SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

SEP10_SIGNING_SECRET="$SECRET" SEP10_HOME_DOMAIN="${PROBE_HOME_DOMAIN:-lumengate.local}" \
PORT="$PORT" RATE_LIMIT_PER_MIN="${PROBE_RATE_LIMIT:-60}" \
nohup node anchor/server.js > /tmp/probe-facade-$PORT.log 2>&1 &
PID=$!

for _ in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1; then break; fi
  sleep 0.25
done

FACADE_URL="http://127.0.0.1:$PORT" SEP10_SIGNING_SECRET="$SECRET" node tools/sep-conformance.js
STATUS=$?

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
exit $STATUS
