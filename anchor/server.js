const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 8081;
const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
const REGISTRY_ID =
  process.env.REGISTRY_ID ||
  'CCXJDQMTJUGXKNFOQPC25IYVOAVWDMLJBNQYX75MAREHV7MZMU5OSEN4'; // testnet
const GATEWAY_ID =
  process.env.GATEWAY_ID ||
  'CBUKVNCPF5XRYJVAH2SRLTLUMZT6T677T5KAJADXZIQOQTCTSBITQVPA'; // testnet
// Stellar Asset Contract for wSRC. Its admin is the gateway, so mint and burn
// are authorised by the gateway's own invocation rather than by a key we hold.
const TOKEN_ID =
  process.env.TOKEN_ID ||
  'CBPBDVLP7K436KEXOAJMPFFHEF5OXNN4KJIB2HDFDBRWOABQ6WBTURRV'; // testnet
const ISSUER =
  process.env.ISSUER ||
  'GBYFDKP4KLQ575HTJRDTHF4HUIVXAQLJNEZMWYJ5HBY3C3GDSPX5H4FR'; // testnet
const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';

function jsonResponse(res, obj, status=200) {
  res.writeHead(status, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type'});
  res.end(JSON.stringify(obj, null, 2));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}


// ---------------------------------------------------------------------------
// /deployment  - the address manifest the receipts were written against
// /relay       - run the relayer for one source height (opt-in, see below)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..');
const RELAYER_BIN = process.env.RELAYER_BIN || path.join(REPO_ROOT, 'target', 'debug', 'relayer');

function runRelayer(height) {
  // The relayer signs and pays from a hot key, so this endpoint spends XLM.
  // It is therefore off unless an operator turns it on explicitly.
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SIM_URL,
      STELLAR_NETWORK: process.env.STELLAR_NETWORK || 'testnet',
      STELLAR_SOURCE_ACCOUNT: process.env.STELLAR_SOURCE_ACCOUNT || 'lumen-relayer',
      STELLAR_RELAYER_ADDRESS: process.env.STELLAR_RELAYER_ADDRESS || '',
      RELAYER_FEE: process.env.RELAYER_FEE || '1000000',
      RELAYER_ONCE: '1',
    };
    if (height) env.RELAYER_HEIGHT = String(height);
    execFile(
      RELAYER_BIN,
      height ? ['--height', String(height), '--once'] : ['--once'],
      { cwd: REPO_ROOT, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`;
        const receipts = output
          .split('\n')
          .filter((line) => line.includes('transaction receipt:'))
          .map((line) => line.split('transaction receipt:').pop().trim());
        resolve({
          ok: !error,
          height: height || null,
          receipts,
          note: receipts.length > 0
            ? 'each receipt hash was confirmed through Soroban RPC getTransaction before it was reported'
            : 'no transaction was confirmed in this pass',
          output: output.slice(-4000),
        });
      }
    );
  });
}

const server = http.createServer(async (req, res) => {
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

  if (req.url === '/self-audit' || req.url === '/self-audit/history') {
    // Read-only surface over the record the self-audit loop writes.
    // It holds no authority: it observes and reports, nothing else.
    try {
      const raw = fs.readFileSync(
        path.join(__dirname, '..', 'deployments', 'self-audit.json'),
        'utf8'
      );
      const doc = JSON.parse(raw);
      const body =
        req.url === '/self-audit'
          ? {
              last_check: doc.latest ? doc.latest.finished_at : null,
              result: doc.latest
                ? `${doc.latest.checks_passed}/${doc.latest.checks_total}`
                : 'no rounds yet',
              all_passed: doc.latest ? doc.latest.all_passed : null,
              rounds_completed: doc.latest ? doc.latest.round : 0,
              registry: doc.latest ? doc.latest.registry : null,
              detail: '/self-audit/history',
            }
          : doc;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'no audit record yet',
          hint: 'run: REGISTRY_ID=<id> node anchor/self-audit.js',
          error: String(e.message || e),
        })
      );
      return;
    }
  }
  if (req.url === '/deployment') {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'deployments', 'testnet.json'), 'utf8')
      );
      jsonResponse(res, manifest);
    } catch (error) {
      jsonResponse(res, { error: `deployments/testnet.json unreadable: ${error.message}` }, 500);
    }
    return;
  }

  if (req.url.startsWith('/relay')) {
    if (process.env.LUMEN_ALLOW_RELAY !== '1') {
      jsonResponse(res, {
        error: 'relay endpoint disabled',
        why: 'this endpoint makes the relayer sign a transaction and spend XLM, so it is opt-in',
        enable: 'LUMEN_ALLOW_RELAY=1 with the relayer binary built at target/debug/relayer',
      }, 403);
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const height = url.searchParams.get('height');
    const result = await runRelayer(height ? Number(height) : null);
    jsonResponse(res, result, result.ok ? 200 : 500);
    return;
  }

  if (req.url === '/health') {
    jsonResponse(res, {status: (REGISTRY_ID.includes('PLACEHOLDER') || GATEWAY_ID.includes('PLACEHOLDER') || TOKEN_ID.includes('PLACEHOLDER')) ? 'configuration_required' : 'ok', port: PORT, sim_url: SIM_URL, registry: REGISTRY_ID, gateway: GATEWAY_ID, time: new Date().toISOString()});
    return;
  }

  if (req.url === '/info' || req.url === '/') {
    let simInfo = null;
    let latestBlock = null;
    try {
      const r = await fetch(`${SIM_URL}/info`);
      simInfo = await r.json();
      const r2 = await fetch(`${SIM_URL}/blocks/latest`);
      latestBlock = await r2.json();
    } catch (e) {
      simInfo = { error: `simulator not reachable at ${SIM_URL}: ${e.message}` };
    }

    // Try to fetch profile from registry if real ID
    let profile = null;
    if (!REGISTRY_ID.includes('PLACEHOLDER')) {
      profile = {
        note: "Registry profile is queried by the relayer; this facade reports the configured domain until a read-only RPC account is supplied.",
        domain: "source-testnet",
        rpc: RPC_URL,
      };
    }

    jsonResponse(res, {
      anchor: "Lumen Gate Anchor",
      description: "Anchor-attached settlement layer — neutral finality-proof infrastructure for source-chain settlement",
      network: "testnet",
      deployment_status: (REGISTRY_ID.includes('PLACEHOLDER') || GATEWAY_ID.includes('PLACEHOLDER') || TOKEN_ID.includes('PLACEHOLDER')) ? "configuration_required" : "configured; verify receipts",
      version: "0.3.0",
      contracts: {
        registry: REGISTRY_ID,
        gateway: GATEWAY_ID,
        token: TOKEN_ID,
        issuer: ISSUER,
        explorer_registry: `https://stellar.expert/explorer/testnet/contract/${REGISTRY_ID}`,
        explorer_gateway: `https://stellar.expert/explorer/testnet/contract/${GATEWAY_ID}`,
        rpc_url: RPC_URL,
      },
      sac: {
        code: "wSRC",
        issuer: ISSUER,
        admin: GATEWAY_ID,
        note: "Issuer creates asset, deploys SAC, calls StellarAssetClient.set_admin(gateway). Gateway only mints after finality_registry verifies BLS/ZK proof via native host functions. Anchor does NOT hold bridge keys."
      },
      currencies: [
        {
          code: "wSRC",
          issuer: ISSUER,
          desc: "Wrapped Source Chain, minted only after BLS12-381 aggregate or Groth16 BN254 finality proof",
          sac_admin: GATEWAY_ID,
          trust_model: "DemoOnly { set_size: 3, threshold: 2 } for BLS; proof-based path pending root-bound circuit fixture",
          finality_kind: "EconomicFinality (BLS) / Proven only after root-bound ZK fixture",
          required_depth: 2,
          status: (REGISTRY_ID.includes('PLACEHOLDER') || GATEWAY_ID.includes('PLACEHOLDER') || TOKEN_ID.includes('PLACEHOLDER')) ? "not_deployed" : "configured; verify receipts",
          is_asset_anchored: false,
          anchor_asset_type: "crypto",
        }
      ],
      domains: [
        {
          network: "source-testnet",
          adapter_id: "3dcbf6f582455337083d5f6d36721f6d63d47af0bef870a043c02aca7850dac9",
          state: (REGISTRY_ID.includes('PLACEHOLDER') || GATEWAY_ID.includes('PLACEHOLDER')) ? "NotDeployed" : "Configured; verify receipts",
          consensus_kind: "deterministic-2-of-3-demo",
          finality_kind: "EconomicFinality (demo BLS)",
          trust_model: "DemoOnly(3; threshold 2)",
          last_finalized: null,
          simulator_latest: latestBlock,
          security_backing: "SignatureSet 2-of-3 or ZkProof groth16-bn254",
          required_depth: 2,
          profile: profile,
        }
      ],
      simulator: {
        info: simInfo,
        latest_block: latestBlock,
        endpoints: {
          info: `${SIM_URL}/info`,
          latest_block: `${SIM_URL}/blocks/latest`,
          lock: `${SIM_URL}/lock`,
          proof_bls: `${SIM_URL}/proof?height={height}&kind=bls`,
          proof_zk: `${SIM_URL}/proof?height={height}&kind=zk`,
          events: `${SIM_URL}/events?height={height}`,
        }
      },
      endpoints: {
        stellar_toml: "/.well-known/stellar.toml",
        info: "/info",
        health: "/health",
        transactions: "/transactions?id=",
        deposit: "/deposit?asset=wSRC&account=G...",
        withdraw: "/withdraw?asset=wSRC&account=G...",
        sep6_info: "/sep6/info",
        note: "This anchor does NOT run source chain validators. It relies on cryptographic finality proofs verified on Soroban via native BLS12-381 (bls12_381_g1_is_in_subgroup, hash_to_g1, pairing_check) and BN254 (bn254_multi_pairing_check) host functions."
      },
      hardening: {
        bls: "Real BLS aggregate: demo 2-of-3 validators, sk=1,2,3, H=RFC 9380 hash_to_g1(height||state_root||event_root), sig=agg(sk_i*H), pubkey pinned in the domain policy. On-chain checks: on_curve, in_subgroup and full pairing.",
        merkle: "Binary Merkle tree for event_root, proof verification with sorted hashing, leaf=sha256(message_id||payload_hash)",
        hwm: "High-water-mark replay protection (source_domain,target_domain,sender)->highest_nonce, plus message_id processed set",
        zk: "BN254 verifier uses native multi-pairing; the checked-in range-proof fixture remains a development artifact until its public root is bound.",
        sac: "SAC set_admin to gateway, mint only after finality proof, no custodial bridge",
        negative_tests: ["zeroed sig must refuse", "declared_root mismatch must refuse", "version 99 must refuse", "replay same nonce must refuse"]
      }
    });
    return;
  }

  if (req.url.startsWith('/transactions')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id') || 'unknown';
    jsonResponse(res, {
      id,
      status: "metadata_only; inspect the linked explorer transaction for the signed receipt",
      stellar_explorer: `https://stellar.expert/explorer/testnet/tx/${id}`,
      registry: REGISTRY_ID,
      gateway: GATEWAY_ID,
      note: "In real anchor, this would mirror off-chain transaction status and show proof verification. For demo, it links to Explorer and shows hardened checks."
    });
    return;
  }

  if (req.url.startsWith('/sep6/info')) {
    jsonResponse(res, {
      deposit: {
        wSRC: {
          enabled: false,
          authentication_required: false,
          min_amount: 1,
          max_amount: 1000000,
          fee_fixed: 0,
          fee_percent: 0,
        }
      },
      withdraw: {
        wSRC: {
          enabled: false,
          authentication_required: false,
          min_amount: 1,
          max_amount: 1000000,
        }
      },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
      note: "SEP-6 operations remain disabled until a real authenticated anchor backend is connected."
    });
    return;
  }

  if (req.url.startsWith('/deposit')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = url.searchParams.get('asset') || 'wSRC';
    const account = url.searchParams.get('account') || 'G...';
    jsonResponse(res, {
      asset,
      account,
      how: "1. Lock on source chain via POST /lock on simulator, 2. Relayer submits finality proof to Soroban (real BLS aggregate + Merkle), 3. Gateway mints wSRC to your Stellar account after HWM and payload_hash re-derive checks",
      steps: [
        `POST ${SIM_URL}/lock {amount, recipient: "${account}", sender: "${account}"}`,
        `GET ${SIM_URL}/proof?height=latest&kind=bls (real BLS aggregate, demo 2-of-3 keys)`,
        `Submit to finality_registry.submit_finality_evidence_bls (on_curve, in_subgroup, hash_to_g1)`,
        `Optional hardened: submit_bls_hardened with full pairing e(sig,G2_gen)*e(-H,pubkey)==1`,
        `Call settlement_gateway.finalize_inbound with CrossDomainMessage, Merkle proof, asset, amount, recipient (HWM check, payload_hash re-derive, Merkle verification)`,
        `Check Freighter for wSRC balance, Horizon https://horizon-testnet.stellar.org/accounts/${account}`,
      ],
      sac_admin: GATEWAY_ID,
      registry: REGISTRY_ID,
      gateway: GATEWAY_ID,
      rpc_url: RPC_URL,
      explorer: `https://stellar.expert/explorer/testnet/contract/${GATEWAY_ID}`,
      note: "Anchor does not custody bridge keys. Mint authority is in gateway contract. BLS uses the real aggregate path when deployed; the checked-in ZK fixture remains development-only until its source root is bound. This checkout is not live until contract IDs and receipts are configured."
    });
    return;
  }

  if (req.url.startsWith('/withdraw')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = url.searchParams.get('asset') || 'wSRC';
    const account = url.searchParams.get('account') || 'G...';
    jsonResponse(res, {
      asset,
      account,
      how: "Burn on Stellar then unlock on source",
      steps: [
        `Call settlement_gateway.burn_and_relay(from, amount, recipient_on_source, target_domain, expiry) via Freighter`,
        `Gateway burns wSRC, emits Burn event with message_id derived from content (source_domain,target_domain,nonce,payload_hash)`,
        `Relayer watches the live Burn event Bytes payload through Soroban RPC and submits it to the source simulator (POST /burn-unlock)`,
        `Source chain releases locked asset`,
      ],
      gateway: GATEWAY_ID,
      registry: REGISTRY_ID,
      status: "requires a running live relayer; it consumes gateway burn events through Soroban RPC and posts one-time /burn-unlock to the source simulator",
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain', 'Access-Control-Allow-Origin':'*'});
  res.end('Not found. Try /info, /health, /.well-known/stellar.toml, /transactions?id=, /deposit, /withdraw, /sep6/info');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Anchor facade (hardened) listening on 0.0.0.0:${PORT}`);
  console.log(`  stellar.toml: http://localhost:${PORT}/.well-known/stellar.toml`);
  console.log(`  info: http://localhost:${PORT}/info`);
  console.log(`  health: http://localhost:${PORT}/health`);
  console.log(`  simulator: ${SIM_URL}`);
  console.log(`  registry: ${REGISTRY_ID}`);
  console.log(`  gateway: ${GATEWAY_ID}`);
  console.log(`  Hardened: real BLS aggregate, Merkle tree, HWM, Groth16 bn254, SAC set_admin`);
});
