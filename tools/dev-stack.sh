#!/usr/bin/env bash
# Gate 1.0'in lane'lerini yerelde ucdan uca ayaga kaldirir.
#
#   8080  source-sim        harici deterministik kaynak zinciri (istege bagli)
#   8081  operator-facade   relayer gecisi (imzalamada durur, asagiya bak)
#   8082  anchor-facade     GERCEK testnet anchor'ina SEP-10/SEP-6 gecisi
#   3001  api-dev-server    /api/* handler'lari
#   5175  vite              1.0 konsolu
#
# Iki kaynak simulatoru var ve AYRI defter tutuyorlar:
#   - SOURCE_URL ayarliysa harici olan (tools/source-sim.js, 8080)
#   - ayarli degilse api/_sim.js surec icinde devreye giriyor
# operator-facade kanidi varsayilan olarak /api/source uzerinden okur, boylece
# lock hangisine gittiyse onu takip eder. SOURCE_URL=... verirsen dogrudan ona
# bakar.
#
# Not: facade kasitli olarak ZINCIRE YAZMAZ. Hicbir simulator gercek BLS
# imzalari uretmedigi icin submit_bls_hardened'in pairing kontrolunu gecemez -
# gecmemeli de. Gercek imzaci seti saglanana kadar settle reddedilir.
#
# anchor-facade gercek bir anchor'a bakar ve hicbir anahtar tutmaz. Cekim
# adresini anchor kendi formu tamamlanana kadar vermez; uydurulmaz.
set -euo pipefail
cd "$(dirname "$0")/.."

export OPERATOR_TOKEN="${OPERATOR_TOKEN:-devtoken}"
export OPERATOR_URL="${OPERATOR_URL:-http://127.0.0.1:8081}"
export FACADE_URL="${FACADE_URL:-http://127.0.0.1:8082}"
export WRAPPED_ASSET_CODE="${WRAPPED_ASSET_CODE:-wSRC}"
export WRAPPED_ASSET_ISSUER="${WRAPPED_ASSET_ISSUER:-GBYFDKP4KLQ575HTJRDTHF4HUIVXAQLJNEZMWYJ5HBY3C3GDSPX5H4FR}"

# SOURCE_URL'i kasitli olarak set ETMIYORUZ: varsayilan in-process simulator.
# Harici olani istersen: SOURCE_URL=http://127.0.0.1:8080 tools/dev-stack.sh
if [ -n "${SOURCE_URL:-}" ]; then
  echo "harici kaynak simulatoru: $SOURCE_URL"
  node tools/source-sim.js &
fi

node tools/operator-facade.js &
node tools/anchor-facade.js &
node tools/api-dev-server.js &
( cd frontend && npx vite --host 0.0.0.0 --port 5175 ) &

echo "stack up: facade 8081, anchor 8082, api 3001, console http://127.0.0.1:5175/"
echo "operator token: $OPERATOR_TOKEN"
wait
