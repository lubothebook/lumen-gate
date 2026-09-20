'use strict';

// The operator facade: the one process that is allowed to spend an operator's
// XLM. api/relay.js forwards to it and never holds a key itself.
//
// A relayer pass is three steps:
//   1. read the finality evidence for a height from the source adapter,
//   2. anchor it in the finality registry on Stellar,
//   3. mint the locked events through the settlement gateway.
//
// Step 2 is where this facade stops, and the reason is worth stating plainly.
// finality_registry::submit_bls_hardened runs a full BLS12-381 pairing check.
// The source simulator does not hold the signer set's private keys — it emits
// deterministic digests shaped like an aggregate so the wire format and the
// console are exercisable. Those digests cannot satisfy a pairing check, and
// they should not: a registry that accepted them would not be a registry.
//
// So this facade does the real work it can do and refuses, loudly and
// specifically, the part it cannot. It reports which step it reached and why
// it stopped, instead of returning an empty receipt list that looks like a
// silent failure. Wiring a real signer set is a separate job with its own key
// custody; this file is the seam it will plug into.

const http = require('node:http');

const PORT = Number(process.env.FACADE_PORT || 8081);
const HOST = process.env.FACADE_HOST || '0.0.0.0';
// Where the evidence lives.
//
// There are two source simulators in this repo and they keep SEPARATE ledgers:
// the standalone one in tools/source-sim.js (SOURCE_URL is set, port 8080) and
// the in-process one in api/_sim.js that api/source.js falls back to when
// SOURCE_URL is unset. A lock only exists in whichever one served it.
//
// Reading evidence straight from 8080 therefore breaks the in-process mode:
// the lock is recorded inside the API process, 8080 has never heard of that
// height, and the relay fails with a 404 that looks like a bug in the relay.
//
// So the default is the API's own /api/source endpoint, which routes to
// whichever simulator actually handled the lock. SOURCE_URL still overrides it
// for anyone pointing at a real adapter.
const API_URL = (process.env.API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const SOURCE_URL = (process.env.SOURCE_URL || '').replace(/\/+$/, '');

/** Build the evidence URL for a height, through whichever source is in play. */
function proofUrl(height) {
  if (SOURCE_URL) return `${SOURCE_URL}/proof?height=${height}&kind=bls`;
  const path = encodeURIComponent(`/proof?height=${height}&kind=bls`);
  return `${API_URL}/api/source?path=${path}`;
}
const TOKEN = (process.env.OPERATOR_TOKEN || '').trim();

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
};

function authorized(req) {
  if (!TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const presented = header.replace(/^Bearer\s+/i, '').trim();
  return presented.length > 0 && presented === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health') {
    return json(res, 200, { ok: true, source: SOURCE_URL || `${API_URL}/api/source`, writes_enabled: Boolean(TOKEN) });
  }

  if (path !== '/relay') {
    return json(res, 404, { error: { code: 'not_found', message: `no route for ${path}` } });
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: { code: 'method_not_allowed', message: 'POST /relay' } });
  }
  if (!authorized(req)) {
    return json(res, 401, { error: { code: 'unauthorized', message: 'a valid operator token is required' } });
  }

  const height = url.searchParams.get('height');
  if (!height || !/^\d{1,9}$/.test(height)) {
    return json(res, 400, { error: { code: 'invalid_height', message: 'height must be a positive integer' } });
  }

  const steps = [];
  try {
    // Step 1 — read the evidence. This part is real.
    const r = await fetch(proofUrl(height));
    if (!r.ok) {
      steps.push(`read evidence for height ${height}: FAILED (${r.status})`);
      return json(res, 502, {
        receipts: [],
        steps,
        error: { code: 'evidence_unavailable', message: `the source adapter has no evidence at height ${height}` },
      });
    }
    const evidence = await r.json();
    const p = evidence.payload || {};
    steps.push(`read evidence for height ${height}: state_root ${String(evidence.declared_root).slice(0, 16)}…`);

    // The two simulators describe their evidence differently and the facade
    // must not paper over that. The standalone one emits a signer set and an
    // aggregate shaped like BLS; the in-process one emits a real Merkle root
    // and states plainly that it signs nothing. Reporting "undefined
    // signatures" for the second would be worse than saying what it is.
    if (typeof p.signer_count === 'number') {
      steps.push(`signer set: ${p.signer_count} signatures, policy requires ${p.required}`);
    } else {
      steps.push('signer set: none - this source produces a Merkle root but no signatures');
    }

    // Step 2 — anchor it. This is the part that cannot be faked.
    steps.push('anchor in finality_registry: REFUSED');
    return json(res, 503, {
      receipts: [],
      steps,
      note: 'the relayer read the evidence but did not anchor it, so nothing was minted',
      error: {
        code: 'unsigned_evidence',
        message:
          'finality_registry::submit_bls_hardened performs a real BLS12-381 pairing check. The source simulator '
          + 'emits deterministic digests, not signatures from the registered signer set, so the registry would '
          + 'reject them — as it should. Anchoring needs a real signer set with custody of its keys.',
        reached: 'evidence read and validated in shape; stopped before signing',
        next: 'provision the BLS signer set for this domain, then this facade can anchor and mint',
      },
      evidence: {
        declared_height: evidence.declared_height,
        declared_root: evidence.declared_root,
        event_root: p.event_root,
        signer_count: p.signer_count,
        required: p.required,
      },
    });
  } catch (error) {
    steps.push(`error: ${String(error && error.message ? error.message : error)}`);
    return json(res, 502, {
      receipts: [],
      steps,
      error: { code: 'facade_error', message: String(error && error.message ? error.message : error) },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`operator facade on http://${HOST}:${PORT}`);
  console.log(`  source: ${SOURCE_URL || `${API_URL}/api/source (follows whichever simulator served the lock)`}`);
  console.log(`  writes: ${TOKEN ? 'token set' : 'NO TOKEN — every relay is refused'}`);
  console.log('  routes: /health, POST /relay?height=N');
});
