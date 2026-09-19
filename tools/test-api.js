'use strict';

// Exercise the serverless handlers without Vercel.
//
// The functions are ordinary (req, res) handlers, so a forty-line shim is
// enough to run them here and see real output: a hosted console that has never
// been executed locally is a guess, not a deliverable.

const path = require('path');

function mockRes() {
  const headers = {};
  return {
    statusCode: 0,
    body: '',
    setHeader: (k, v) => {
      headers[k.toLowerCase()] = v;
    },
    end: (chunk) => {
      if (chunk) this.body += chunk;
    },
    _headers: headers,
    _text() {
      return this.body;
    },
  };
}

function makeRes() {
  const state = { statusCode: 0, body: '', headers: {} };
  return {
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      if (chunk) state.body += chunk;
      state.statusCode = state.statusCode || 200;
    },
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = value;
    },
    state,
  };
}

async function call(file, { method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const handler = require(path.join(__dirname, '..', 'api', file));
  const res = makeRes();
  await handler({ method, url, headers: { host: 'localhost:3000', ...headers }, body }, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.state.body);
  } catch {
    parsed = res.state.body.slice(0, 200);
  }
  return { status: res.state.statusCode, body: parsed, headers: res.state.headers };
}

async function main() {
  const results = [];

  const status = await call('status.js', { url: '/api/status' });
  results.push(['GET /api/status', status.status, {
    registry: status.body.contracts?.registry,
    manifest_network: status.body.network,
    latest_ledger: status.body.chain?.latest_ledger,
    audit: status.body.audit,
    capability_relay: status.body.capabilities?.operator_relay?.enabled,
  }]);

  const audit = await call('audit.js', { url: '/api/audit' });
  results.push(['GET /api/audit', audit.status, {
    rounds: audit.body.history?.length,
    latest: audit.body.latest?.checks_passed,
    cache: audit.headers['cache-control'],
  }]);

  const finality = await call('finality.js', { url: '/api/finality' });
  results.push(['GET /api/finality', finality.status, {
    found: finality.body.found,
    query: finality.body.query,
    record: finality.body.record && {
      last_height: finality.body.record.last_height,
      state: finality.body.record.state,
      last_security: finality.body.record.last_security,
      last_root: String(finality.body.record.last_root || '').slice(0, 16) + '…',
    },
    error: finality.body.error,
    detail: finality.body.detail,
  }]);

  const badHeight = await call('finality.js', { url: '/api/finality?height=abc' });
  results.push(['GET /api/finality?height=abc', badHeight.status, badHeight.body]);

  const relayNoToken = await call('relay.js', { method: 'POST', url: '/api/relay' });
  results.push(['POST /api/relay (no token)', relayNoToken.status, relayNoToken.body]);

  const relayBadMethod = await call('relay.js', { method: 'GET', url: '/api/relay' });
  results.push(['GET /api/relay', relayBadMethod.status, relayBadMethod.body]);

  for (const [name, status, body] of results) {
    console.log(`\n${name} -> ${status}`);
    console.log(JSON.stringify(body, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
