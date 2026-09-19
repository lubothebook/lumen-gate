const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8081;
const SIM_URL = process.env.SIM_URL || 'http://localhost:3001';
const REGISTRY_ID = process.env.REGISTRY_ID || 'CD-REGISTRY-PLACEHOLDER';
const GATEWAY_ID = process.env.GATEWAY_ID || 'CD-GATEWAY-PLACEHOLDER';

function jsonResponse(res, obj, status=200) {
  res.writeHead(status, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type'
    });
    res.end();
    return;
  }

  if (req.url === '/.well-known/stellar.toml' || req.url === '/stellar.toml') {
    const toml = fs.readFileSync(path.join(__dirname, 'stellar.toml'), 'utf8');
    res.writeHead(200, {'Content-Type':'text/plain', 'Access-Control-Allow-Origin':'*'});
    res.end(toml);
    return;
  }

  if (req.url === '/info' || req.url === '/') {
    // Try to fetch simulator info
    let simInfo = null;
    try {
      const r = await fetch(`${SIM_URL}/info`);
      simInfo = await r.json();
    } catch (e) {
      simInfo = { error: `simulator not reachable at ${SIM_URL}: ${e.message}` };
    }

    jsonResponse(res, {
      anchor: "Migrate to Stellar Anchor",
      description: "Anchor-attached settlement layer — neutral finality-proof infra",
      network: "testnet",
      contracts: {
        registry: REGISTRY_ID,
        gateway: GATEWAY_ID,
        sac: "wSRC:ISSUER (admin=gateway)",
        explorer_registry: `https://stellar.expert/explorer/testnet/contract/${REGISTRY_ID}`,
        explorer_gateway: `https://stellar.expert/explorer/testnet/contract/${GATEWAY_ID}`
      },
      currencies: [
        {
          code: "wSRC",
          issuer: "GCEXAMPLEISSUER",
          desc: "Wrapped Source Chain, minted only after BLS/ZK finality proof",
          sac_admin: GATEWAY_ID,
          trust_model: "HonestMajority { set_size: 5 } for BLS, Trustless for ZK (Groth16 BN254)",
          finality_kind: "EconomicFinality (BLS) / Proven (ZK)",
          required_depth: 2
        }
      ],
      domains: [
        {
          network: "source-testnet",
          adapter_id: "hash(source-chain-bls-v1)",
          state: "Active",
          last_finalized: simInfo?.latest_height || null,
          security_backing: "SignatureSet 3-of-5 or ZkProof groth16-bn254"
        }
      ],
      simulator: simInfo,
      endpoints: {
        stellar_toml: "/.well-known/stellar.toml",
        info: "/info",
        transactions: "/transactions?id=",
        deposit: "/deposit?asset=wSRC&account=G...",
        note: "This anchor does NOT run source chain validators. It relies on cryptographic finality proofs verified on Soroban via native BLS12-381 and BN254 host functions."
      }
    });
    return;
  }

  if (req.url.startsWith('/transactions')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id') || 'unknown';
    jsonResponse(res, {
      id,
      status: "pending -> completed after finality proof",
      stellar_explorer: `https://stellar.expert/explorer/testnet/tx/${id}`,
      note: "In real anchor, this would mirror off-chain transaction status. For demo, it links to Explorer."
    });
    return;
  }

  if (req.url.startsWith('/deposit')) {
    jsonResponse(res, {
      how: "1. Lock on source chain via POST /lock on simulator, 2. Relayer submits finality proof to Soroban, 3. Gateway mints wSRC to your Stellar account",
      steps: [
        "POST http://localhost:3001/lock {amount, recipient}",
        "GET http://localhost:3001/proof?height=latest&kind=bls",
        "Submit to finality_registry.submit_finality_evidence_bls",
        "Call settlement_gateway.finalize_inbound with CrossDomainMessage",
        "Check Freighter for wSRC balance"
      ],
      sac_admin: GATEWAY_ID,
      note: "Anchor does not custody bridge keys. Mint authority is in gateway contract."
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain'});
  res.end('Not found. Try /info, /.well-known/stellar.toml, /transactions?id=, /deposit');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Anchor facade listening on 0.0.0.0:${PORT}`);
  console.log(`  stellar.toml: http://localhost:${PORT}/.well-known/stellar.toml`);
  console.log(`  info: http://localhost:${PORT}/info`);
  console.log(`  simulator: ${SIM_URL}`);
});
