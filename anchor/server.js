'use strict';

// ---------------------------------------------------------------------------
// The anchor facade.
//
// This process is the integration surface of the system: it is what another
// piece of software (a wallet, a SEP client, a judge with curl) talks to. Four
// rules follow from that and they are enforced here rather than documented:
//
//   1. Reading is public. Anything that only observes the system is served to
//      anyone, because a verifier that cannot be read is not a verifier.
//   2. Writing is never public. Mutating routes require either an operator
//      token (operations) or a SEP-10 session (a user acting on their own
//      record). Neither substitutes for the other.
//   3. Every input is validated before it reaches the relayer, Soroban RPC or
//      the filesystem, and every failure answers in one error shape:
//      {"error": {"code": ..., "message": ..., "details": ...}}.
//   4. Capabilities that are not configured report themselves as not
//      configured. A facade that half-works and says nothing is worse than one
//      that refuses and explains.
//
// Routes are canonical under /v1. The unversioned paths stay as aliases so that
// anything integrating today keeps working; new integrations should use /v1.
// ---------------------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');

const errors = require('./lib/errors');
const rateLimit = require('./lib/ratelimit');
const jwt = require('./lib/jwt');
const sep10 = require('./lib/sep10');
const sep6 = require('./lib/sep6');

const PORT = process.env.PORT || 8081;
const SIM_URL = process.env.SIM_URL || 'http://localhost:8080';
// The SEP-6 reconciliation reads the same source adapter, so it sees one URL.
process.env.SIM_URL = SIM_URL;
const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

// Extra origins allowed to call this facade from a browser. Same-origin is
// always allowed. A literal '*' is honoured only for the public read surface.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';

// The operator token guards every operational endpoint. No token means no writes.
const OPERATOR_TOKEN = (process.env.OPERATOR_TOKEN || '').trim();

// Cost controls on the one endpoint that spends money.
const RELAY_COOLDOWN_MS = Number(process.env.RELAY_COOLDOWN_MS || 30000);
let relayInFlight = false;
let lastRelayFinishedAt = 0;

const TX_HASH = /^[0-9a-f]{64}$/;

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deployments', 'testnet.json'), 'utf8'));
  } catch {
    return null;
  }
}

const MANIFEST = loadManifest();
const manifestContract = (name) => {
  const entry = MANIFEST && MANIFEST.contracts && MANIFEST.contracts[name];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.contract_id || null;
};
const manifestAccount = (name) => (MANIFEST && MANIFEST.accounts && MANIFEST.accounts[name]) || null;

const REGISTRY_ID = process.env.REGISTRY_ID || manifestContract('finality_registry') || 'CCXJDQMTJUGXKNFOQPC25IYVOAVWDMLJBNQYX75MAREHV7MZMU5OSEN4';
const GATEWAY_ID = process.env.GATEWAY_ID || manifestContract('settlement_gateway') || 'CBUKVNCPF5XRYJVAH2SRLTLUMZT6T677T5KAJADXZIQOQTCTSBITQVPA';
const TOKEN_ID = process.env.TOKEN_ID || manifestContract('wrapped_asset_sac') || 'CBPBDVLP7K436KEXOAJMPFFHEF5OXNN4KJIB2HDFDBRWOABQ6WBTURRV';
const ISSUER = process.env.ISSUER || (MANIFEST && MANIFEST.contracts && MANIFEST.contracts.wrapped_asset_sac && MANIFEST.contracts.wrapped_asset_sac.issuer) || 'GBYFDKP4KLQ575HTJRDTHF4HUIVXAQLJNEZMWYJ5HBY3C3GDSPX5H4FR';
const RPC_URL = process.env.RPC_URL || (MANIFEST && MANIFEST.rpc_url) || 'https://soroban-testnet.stellar.org';
const RELAYER_BIN = process.env.RELAYER_BIN || path.join(REPO_ROOT, 'target', 'debug', 'relayer');

const placeholders = [REGISTRY_ID, GATEWAY_ID, TOKEN_ID].some((value) => String(value).includes('PLACEHOLDER'));

// ---------------------------------------------------------------------------
// transport helpers
// ---------------------------------------------------------------------------

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const host = req.headers.host;
  if (PUBLIC_ORIGIN && origin === PUBLIC_ORIGIN) return origin;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return origin;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function cors(res, req) {
  const origin = allowedOrigin(req);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Lumen-Operator, X-Lumen-Session');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res, status, body, headers = {}) {
  securityHeaders(res);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body, null, 2));
}

function fail(res, status, code, message, details, headers = {}) {
  json(res, status, errors.errorBody(code, message, details), headers);
}

function text(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end(body);
}

/** Timing-safe comparison, so a wrong token does not leak its prefix. */
function tokenMatches(provided) {
  if (!OPERATOR_TOKEN || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(OPERATOR_TOKEN);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function isOperator(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const headerToken = req.headers['x-lumen-operator'] || '';
  return tokenMatches(bearer) || tokenMatches(String(headerToken));
}

/** Write guard 1: operational endpoints. Answers with the standard envelope. */
function requireOperator(req, res) {
  if (!OPERATOR_TOKEN) {
    fail(res, 503, 'writes_disabled', undefined, {
      fix: 'set OPERATOR_TOKEN and send it as Authorization: Bearer <token> to enable operator writes',
    });
    return false;
  }
  if (!isOperator(req)) {
    fail(res, 401, 'unauthorized', 'a valid operator token is required', {
      how: 'send Authorization: Bearer <OPERATOR_TOKEN>',
    });
    return false;
  }
  return true;
}

/**
 * Write guard 2: a user acting on their own record.
 *
 * The SEP-10 session names the account; the caller may only touch a record that
 * belongs to that account. An operator token is not accepted here, because an
 * operator is not the user.
 */
function requireSessionFor(req, res, account) {
  const token = jwt.fromRequest(req);
  if (!token) {
    json(res, 401, sep10.unauthenticated());
    return null;
  }
  const verified = jwt.verify(token);
  if (!verified.ok) {
    json(res, 401, sep10.unauthenticated(verified.reason === 'expired' ? 'unauthorized' : 'unauthorized'));
    return null;
  }
  if (account && verified.claims.sub !== account) {
    fail(res, 403, 'unauthorized', 'this session does not belong to the account on that record', {
      session_account: verified.claims.sub,
      record_account: account,
    });
    return null;
  }
  return verified.claims;
}

/**
 * Read guard for the user-facing SEP-6 surface.
 *
 * Opening a deposit or withdraw record, and reading a transaction history, all
 * name an account. The session proves which one: no token, no record; a token,
 * and only the account it was issued to. An anonymous caller cannot plant
 * pending records against somebody else's address, and cannot read someone
 * else's history by guessing an account id.
 */
function requireSession(req, res) {
  const token = jwt.fromRequest(req);
  if (!token) {
    json(res, 401, sep10.unauthenticated());
    return null;
  }
  const verified = jwt.verify(token);
  if (!verified.ok) {
    json(res, 401, sep10.unauthenticated());
    return null;
  }
  return verified.claims;
}

function sessionOwnsAccount(req, res, claims, requested) {
  if (requested && requested !== claims.sub) {
    fail(res, 403, 'unauthorized', 'a session acts for its own account only', {
      session_account: claims.sub,
      requested_account: requested,
    });
    return false;
  }
  return true;
}

/** Integers only, bounded, before anything is handed to the relayer. */
function parseHeight(value) {
  if (value === null || value === undefined || value === '') return {ok: true, height: null};
  if (!/^\d{1,9}$/.test(String(value))) return {ok: false};
  const height = Number(value);
  if (height < 1) return {ok: false};
  return {ok: true, height};
}

function capabilities() {
  return {
    reads: {status: 'enabled', note: 'the live deployment manifest, balances and the audit record are public'},
    relay: {
      enabled: Boolean(OPERATOR_TOKEN) && process.env.LUMEN_ALLOW_RELAY === '1',
      operator_token_required: Boolean(OPERATOR_TOKEN),
      requires: 'OPERATOR_TOKEN and LUMEN_ALLOW_RELAY=1',
      note: 'runs one relayer pass; it signs a transaction and spends fees',
    },
    sep10: sep10.status(),
    sep6: {
      deposit: true,
      withdraw: true,
      customer_information: false,
      note: 'SEP-12 is not implemented; the deposit and withdraw records are reconciled against live ledgers',
    },
    wallet_paths: {
      burn_and_relay: 'signed by the end user in the browser through Freighter',
      inbound_mint: 'signed by the relayer, never by the end user',
    },
    user_initiated: {
      lock: 'enabled: POST /v1/user/lock with a SEP-10 session; the recipient is forced to the session account',
      relay: process.env.LUMEN_ALLOW_USER_RELAY === '1'
        ? `enabled: POST /v1/user/relay with a SEP-10 session, ${Math.ceil(USER_RELAY_COOLDOWN_MS / 1000)}s cooldown per account`
        : 'disabled: set LUMEN_ALLOW_USER_RELAY=1 to let a session ask for a relay pass',
      operator_token_required: false,
      note: 'a session substitutes for the operator token for these two actions only; it grants no mint authority and cannot redirect a mint',
    },
    cashout: {
      anchor_home_domain: trAnchor.homeDomain(),
      routes: ['GET /v1/cashout/anchor', 'GET /v1/cashout/bridge', 'GET /v1/cashout/challenge', 'POST /v1/cashout/token', 'POST /v1/cashout/start', 'GET /v1/cashout/status'],
      note: 'an exit through an external SEP-6 anchor; this facade proxies and stores nothing',
    },
  };
}

// ---------------------------------------------------------------------------
// /deployment  - the address manifest the receipts were written against
// /relay       - run the relayer for one source height (opt-in, see below)
// ---------------------------------------------------------------------------

function runRelayer(height) {
  // The relayer signs and pays from a hot key, so this endpoint spends XLM.
  // It is therefore off unless an operator turns it on explicitly.
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SIM_URL,
      STELLAR_NETWORK: process.env.STELLAR_NETWORK || 'testnet',
      // The relayer refuses to run when the source simulator's asset id does not
      // match the SAC this deployment mints, so it is handed the id from the
      // same constant the rest of the facade reports. An operator can still
      // override it, but the default can no longer be wrong-by-omission.
      SOURCE_ASSET_ID: process.env.SOURCE_ASSET_ID || TOKEN_ID,
      STELLAR_SOURCE_ACCOUNT: process.env.STELLAR_SOURCE_ACCOUNT || 'lumen-relayer',
      STELLAR_RELAYER_ADDRESS: process.env.STELLAR_RELAYER_ADDRESS || '',
      RELAYER_FEE: process.env.RELAYER_FEE || '1000000',
      RELAYER_ONCE: '1',
    };
    if (height) env.RELAYER_HEIGHT = String(height);
    execFile(
      RELAYER_BIN,
      height ? ['--height', String(height), '--once'] : ['--once'],
      {cwd: REPO_ROOT, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024},
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`;
        const receipts = output
          .split('\n')
          .filter((line) => line.includes('transaction receipt:'))
          .map((line) => line.split('transaction receipt:').pop().trim());
        // A relayer that never started must not look like a relayer that ran and
        // found nothing to do. Those are different facts and an operator has to
        // be able to tell them apart from the response alone.
        const spawnError =
          error &&
          (error.code === 'ENOENT'
            ? `the relayer binary is missing at ${RELAYER_BIN}`
            : error.killed
              ? `the relayer was killed after ${error.signal || 'a timeout'}`
              : error.code || error.message || 'unknown error');
        resolve({
          ok: !error,
          height: height || null,
          error: spawnError || null,
          receipts,
          note: receipts.length > 0
            ? 'each receipt hash was confirmed through Soroban RPC getTransaction before it was reported'
            : spawnError
              ? `the relayer did not run: ${spawnError}`
              : 'the relayer ran and confirmed no transaction in this pass',
          output: output.slice(-4000),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// stellar.toml
// ---------------------------------------------------------------------------

/**
 * Serves the SEP-1 file with the deployment-specific values filled in.
 *
 * Two values cannot live in a checked-in file because they only exist once a
 * deployment does: the SEP-10 signing key and the public URL of this facade.
 * They are render tokens. When the environment does not define them the line is
 * dropped and replaced by a comment saying so, instead of shipping a
 * placeholder that looks like a real address.
 */
function renderStellarToml() {
  const signingKey = sep10.status().signing_key;
  const base = (process.env.PUBLIC_FACADE_URL || '').trim().replace(/\/+$/, '');
  const template = fs.readFileSync(path.join(__dirname, 'stellar.toml'), 'utf8');
  const lines = template.split('\n').filter((line) => {
    if (line.includes('__SEP10_SIGNING_KEY__') && !signingKey) return false;
    if (line.includes('__FACADE_BASE_URL__') && !base) return false;
    return true;
  });
  const rendered = lines
    .join('\n')
    .replace(/__SEP10_SIGNING_KEY__/g, signingKey || '')
    .replace(/__FACADE_BASE_URL__/g, base);
  const missing = [];
  if (!signingKey) missing.push('SIGNING_KEY (set SEP10_SIGNING_SECRET)');
  if (!base) missing.push('WEB_AUTH_ENDPOINT (set PUBLIC_FACADE_URL)');
  const header = missing.length
    ? `# Not renderable on this deployment yet: ${missing.join(', ')}.\n# The fields are omitted rather than filled with an address this service cannot use.\n`
    : '';
  return `${header}${rendered}`;
}

// ---------------------------------------------------------------------------
// payload readers
// ---------------------------------------------------------------------------

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limitBytes) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ok: false});
      if (!raw) return resolve({ok: true, body: {}});
      try {
        resolve({ok: true, body: JSON.parse(raw)});
      } catch {
        resolve({ok: false});
      }
    });
    req.on('error', () => resolve({ok: false}));
  });
}

// ---------------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------------

// The TRY exit client. It is a client of an external anchor, used only by the
// cash-out routes below; nothing else in the facade depends on it, and if the
// external anchor is unreachable those routes fail alone.
const trAnchor = require('./tr-anchor-client');

/** Per-account cooldown for user-initiated relay passes. A map, not a counter:
 *  one account hammering the endpoint must not slow down another account. */
const userRelayAt = new Map();
const USER_RELAY_COOLDOWN_MS = Number(process.env.USER_RELAY_COOLDOWN_MS || '60000');

const PUBLIC_READS = new Set([
  'GET /v1/health',
  'GET /v1/info',
  'GET /v1/capabilities',
  'GET /v1/deployment',
  'GET /v1/self-audit',
  'GET /v1/self-audit/history',
  'GET /v1/sep6/info',
  'GET /v1/deposit',
  'GET /v1/withdraw',
  'GET /v1/transactions',
  'GET /v1/sep10/auth',
  'GET /v1/sep12/customer',
  'GET /.well-known/stellar.toml',
  'GET /v1/cashout/anchor',
  'GET /v1/cashout/bridge',
  'GET /v1/cashout/challenge',
]);

const ROUTES = [
  'GET  /v1/health',
  'GET  /v1/info',
  'GET  /v1/capabilities',
  'GET  /v1/deployment',
  'GET  /v1/self-audit',
  'GET  /v1/self-audit/history',
  'GET  /v1/sep10/auth?account=G...',
  'POST /v1/sep10/auth {transaction}',
  'GET  /v1/sep6/info',
  'GET  /v1/deposit?asset_code=&amount=           (SEP-10 session; account = token subject)',
  'GET  /v1/withdraw?asset_code=&amount=&dest=    (SEP-10 session; account = token subject)',
  'GET  /v1/transactions[?id=]                    (SEP-10 session; history scoped to the token subject)',
  'POST /v1/transactions/{id}/burn {stellar_transaction_id}  (SEP-10 session of the record owner)',
  'GET  /v1/sep12/customer  (not implemented, answers 501)',
  'POST /v1/user/lock {amount,count}   (SEP-10 session; recipient forced to the session account)',
  'POST /v1/user/relay?height=N       (SEP-10 session; needs LUMEN_ALLOW_USER_RELAY=1)',
  'POST /v1/relay?height=N  (operator token)',
  'POST /v1/reconcile       (operator token)',
  'GET  /v1/cashout/anchor                       (external SEP-6 anchor, discovered live)',
  'GET  /v1/cashout/bridge[?source_asset=&amount=]  (is there a real market route to the anchor asset?)',
  'GET  /v1/cashout/challenge?account=G...        (SEP-10 challenge, proxied)',
  'POST /v1/cashout/token {transaction}           (signed challenge -> anchor JWT, proxied)',
  'POST /v1/cashout/start {amount,account}        (X-Anchor-Token; opens a real SEP-6 withdrawal)',
  'GET  /v1/cashout/status?id=                    (X-Anchor-Token; polls the anchor)',
  'GET  /v1/logo.png            (the asset ORG_LOGO names in stellar.toml)',
  'GET  /.well-known/stellar.toml',
];

/** Legacy aliases, kept so that existing integrations do not break silently. */
function canonicalPath(pathname) {
  if (pathname.startsWith('/v1/')) return pathname;
  const aliases = {
    '/': '/v1/info',
    '/info': '/v1/info',
    '/health': '/v1/health',
    '/capabilities': '/v1/capabilities',
    '/deployment': '/v1/deployment',
    '/self-audit': '/v1/self-audit',
    '/self-audit/history': '/v1/self-audit/history',
    '/sep10/auth': '/v1/sep10/auth',
    '/sep6/info': '/v1/sep6/info',
    '/deposit': '/v1/deposit',
    '/withdraw': '/v1/withdraw',
    '/transactions': '/v1/transactions',
    '/relay': '/v1/relay',
    '/reconcile': '/v1/reconcile',
    '/sep12/customer': '/v1/sep12/customer',
  };
  return aliases[pathname] || pathname;
}

async function handle(req, res, pathname, query) {
  const route = `${req.method} ${pathname}`;

  // ---- discovery ---------------------------------------------------------
  if (pathname === '/.well-known/stellar.toml' || pathname === '/stellar.toml') {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'stellar.toml is read-only');
    try {
      return text(res, 200, renderStellarToml());
    } catch (error) {
      return fail(res, 500, 'internal_error', `stellar.toml could not be rendered: ${error.message}`);
    }
  }

  // ---- the logo ORG_LOGO points at ---------------------------------------
  // SEP-1 asks for ORG_LOGO and other people's software renders it, so the URL
  // is served rather than pointed at a path that 404s. It is the same asset the
  // console embeds, read from disk on each request so a redeploy cannot leave a
  // stale copy behind.
  if (pathname === '/v1/logo.png') {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'the logo is read-only');
    try {
      const body = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'public', 'logo-mark.png'));
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(body);
    } catch (error) {
      return fail(res, 500, 'internal_error', `the logo asset is unreadable on this deployment: ${error.message}`);
    }
  }

  // ---- health and capability surface ------------------------------------
  if (route === 'GET /v1/health') {
    return json(res, 200, {
      status: placeholders ? 'configuration_required' : 'ok',
      network: sep10.networkName(),
      registry: REGISTRY_ID,
      gateway: GATEWAY_ID,
      token: TOKEN_ID,
      sep10: sep10.status().configured ? 'configured' : 'not_configured',
      writes: OPERATOR_TOKEN ? 'operator_token_required' : 'disabled',
      time: new Date().toISOString(),
    });
  }

  if (route === 'GET /v1/capabilities') {
    return json(res, 200, {...capabilities(), registry: REGISTRY_ID, gateway: GATEWAY_ID, token: TOKEN_ID, network: sep10.networkName()});
  }

  if (route === 'GET /v1/deployment') {
    if (!MANIFEST) return fail(res, 500, 'internal_error', 'deployments/testnet.json is unreadable in this deployment');
    return json(res, 200, MANIFEST);
  }

  // ---- the audit record, read-only ---------------------------------------
  if (route === 'GET /v1/self-audit' || route === 'GET /v1/self-audit/history') {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deployments', 'self-audit.json'), 'utf8'));
      if (route.endsWith('/history')) return json(res, 200, doc);
      const latest = doc.latest || null;
      return json(res, 200, {
        last_check: latest ? latest.finished_at : null,
        result: latest ? `${latest.checks_passed}/${latest.checks_total}` : 'no rounds yet',
        all_passed: latest ? latest.all_passed : null,
        rounds_completed: latest ? latest.round : 0,
        registry: latest ? latest.registry : null,
        detail: '/v1/self-audit/history',
      });
    } catch (error) {
      return fail(res, 503, 'upstream_unavailable', 'no audit record has been written yet', {
        hint: 'run: REGISTRY_ID=<id> node anchor/self-audit.js',
        cause: String(error.message || error),
      });
    }
  }

  // ---- SEP-10 ------------------------------------------------------------
  if (pathname === '/v1/sep10/auth' && req.method === 'GET') {
    const account = query.get('account');
    if (!account) {
      return fail(res, 400, 'invalid_request', 'account is required', {example: '/v1/sep10/auth?account=G...'});
    }
    const status = sep10.status();
    if (!status.configured) {
      return fail(res, 503, 'not_configured', 'SEP-10 is switched off on this deployment', {
        fix: 'set SEP10_SIGNING_SECRET to the anchor account secret so challenges can be signed and verified',
      });
    }
    try {
      const challenge = await sep10.buildChallenge({
        account,
        clientDomain: query.get('client_domain') || null,
        memo: query.get('memo') || null,
      });
      return json(res, 200, {
        ...challenge,
        signing_key: status.signing_key,
        how: 'sign this transaction envelope with your account key and POST the base64 XDR to /v1/sep10/auth',
      });
    } catch (error) {
      const code = errors.CODES[error.code] ? error.code : 'internal_error';
      return fail(res, code === 'internal_error' ? 500 : 400, code, error.message);
    }
  }

  if (pathname === '/v1/sep10/auth' && req.method === 'POST') {
    const parsed = await readBody(req);
    if (!parsed.ok) return fail(res, 400, 'invalid_request', 'the request body must be JSON');
    if (!parsed.body || typeof parsed.body.transaction !== 'string') {
      return fail(res, 400, 'invalid_request', 'the body must carry the signed challenge as {"transaction": "<base64 XDR>"}');
    }
    try {
      const verified = await sep10.verifyChallenge({transaction: parsed.body.transaction});
      const issued = jwt.issue(verified.account, {audience: 'sep6'});
      return json(res, 200, {
        token: issued.token,
        expires_at: issued.expires_at,
        expires_in: issued.expires_in,
        account: verified.account,
        matched_home_domain: verified.matched_home_domain,
        signers: verified.signers,
        verification: verified.verification,
        note: 'the challenge transaction was verified against this anchor account and is never submitted to the network',
      });
    } catch (error) {
      const status = error.code === 'unauthorized' ? 401 : error.code === 'not_configured' || error.code === 'upstream_unavailable' ? 503 : 400;
      return fail(res, status, error.code || 'invalid_transaction', error.message);
    }
  }

  // ---- SEP-6 -------------------------------------------------------------
  if (route === 'GET /v1/sep6/info') {
    return json(res, 200, sep6.info());
  }

  if (route === 'GET /v1/sep12/customer') {
    return json(res, 501, sep6.customerNotImplemented());
  }

  if (route === 'GET /v1/deposit') {
    const claims = requireSession(req, res);
    if (!claims) return undefined;
    if (!sessionOwnsAccount(req, res, claims, query.get('account'))) return undefined;
    const result = sep6.depositInstructions({
      account: claims.sub,
      assetCode: query.get('asset_code') || query.get('asset'),
      amount: query.get('amount') || null,
      sourceAddress: query.get('source_address') || null,
      email: query.get('email') || null,
    });
    if (result.error) {
      const code = result.error.error.code;
      const status = code === 'invalid_account' || code === 'invalid_amount' ? 400 : 400;
      return json(res, status, result.error);
    }
    return json(res, 200, result.body);
  }

  if (route === 'GET /v1/withdraw') {
    const claims = requireSession(req, res);
    if (!claims) return undefined;
    if (!sessionOwnsAccount(req, res, claims, query.get('account'))) return undefined;
    const result = sep6.withdrawInstructions({
      account: claims.sub,
      assetCode: query.get('asset_code') || query.get('asset'),
      amount: query.get('amount') || null,
      dest: query.get('dest') || query.get('dest_address') || null,
    });
    if (result.error) return json(res, 400, result.error);
    return json(res, 200, result.body);
  }

  if (route === 'GET /v1/transactions') {
    const claims = requireSession(req, res);
    if (!claims) return undefined;
    if (!sessionOwnsAccount(req, res, claims, query.get('account'))) return undefined;
    // History is scoped to the session's own account, whatever was asked for.
    query.set('account', claims.sub);
    return json(res, 200, sep6.transactions({query}));
  }

  // Report a burn transaction: verified against the network, never trusted.
  const burnMatch = pathname.match(/^\/v1\/transactions\/([0-9a-fA-F-]{36})\/burn$/);
  if (burnMatch) {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'reporting a burn is POST-only');
    const record = sep6.transactionById(burnMatch[1]);
    if (!record) return fail(res, 404, 'not_found', `no transaction record with id ${burnMatch[1]}`);
    const claims = requireSessionFor(req, res, record.from);
    if (!claims) return undefined;
    const parsed = await readBody(req);
    if (!parsed.ok) return fail(res, 400, 'invalid_request', 'the request body must be JSON');
    const hash = parsed.body.stellar_transaction_id || parsed.body.transaction_hash;
    if (!hash) {
      return fail(res, 400, 'invalid_request', 'the body must carry {"stellar_transaction_id": "<hash>"}');
    }
    const result = await sep6.recordBurn(record.id, hash);
    return json(res, result.status, result.body);
  }

  // ---- operator actions --------------------------------------------------
  if (pathname === '/v1/reconcile') {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'reconcile is POST-only');
    if (!requireOperator(req, res)) return undefined;
    const result = await sep6.reconcile();
    return json(res, 200, result);
  }

  if (pathname === '/v1/relay') {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'the relay endpoint is POST-only');
    if (process.env.LUMEN_ALLOW_RELAY !== '1') {
      return fail(res, 403, 'relay_disabled', undefined, {
        enable: 'LUMEN_ALLOW_RELAY=1 together with OPERATOR_TOKEN',
      });
    }
    if (!requireOperator(req, res)) return undefined;
    const parsed = parseHeight(query.get('height'));
    if (!parsed.ok) return fail(res, 400, 'invalid_request', 'height must be a positive integer');

    // One pass at a time, with a cooldown. Without this, a caller could start
    // many concurrent relayer runs and drain the operator account.
    if (relayInFlight) return fail(res, 429, 'relay_busy');
    const since = Date.now() - lastRelayFinishedAt;
    if (lastRelayFinishedAt && since < RELAY_COOLDOWN_MS) {
      return fail(res, 429, 'relay_cooldown', undefined, {
        retry_after_seconds: Math.ceil((RELAY_COOLDOWN_MS - since) / 1000),
      });
    }

    relayInFlight = true;
    try {
      const result = await runRelayer(parsed.height);
      // A completed pass is the moment the deposit records can advance.
      const reconciled = await sep6.reconcile().catch(() => null);
      return json(res, result.ok ? 200 : 500, {...result, reconciled});
    } finally {
      relayInFlight = false;
      lastRelayFinishedAt = Date.now();
    }
  }

  // ---- overview ----------------------------------------------------------
  if (route === 'GET /v1/info') {
    let simInfo = null;
    let latestBlock = null;
    try {
      const response = await fetch(`${SIM_URL}/info`);
      simInfo = await response.json();
      const blockResponse = await fetch(`${SIM_URL}/blocks/latest`);
      latestBlock = await blockResponse.json();
    } catch (error) {
      simInfo = {error: `source simulator not reachable at ${SIM_URL}: ${error.message}`};
    }

    return json(res, 200, {
      anchor: 'Lumen Gate Anchor',
      description: 'Anchor-attached settlement layer: neutral finality-proof infrastructure for source-chain settlement',
      network: sep10.networkName(),
      deployment_status: placeholders ? 'configuration_required' : 'configured; verify receipts',
      version: '0.4.0',
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
        code: sep6.currency().code,
        issuer: ISSUER,
        admin: GATEWAY_ID,
        note: 'the issuer creates the asset and hands the Stellar Asset Contract admin to the gateway; the gateway only mints after the registry verifies proof, so this anchor holds no bridge key',
      },
      finality: {
        lanes: [
          {
            id: 'bls12-381',
            status: 'live',
            security_backing: {kind: 'SignatureSet', signers: 3, required: 2, slashable: false},
            what_it_covers: 'height, state root and event root; the settlement Merkle proof is anchored here',
            host_functions: 'native CAP-0059 curve, subgroup and pairing checks',
          },
          {
            id: 'groth16-bn254',
            status: 'live',
            security_backing: {kind: 'ZkProof', system: 'groth16-bn254'},
            what_it_covers: 'a quorum of approvals and a root binding across one Poseidon relation',
            what_it_does_not_cover: 'it is not a signature proof, so no event root is persisted from this lane',
            host_functions: 'native bn254 multi-pairing check',
          },
        ],
        admin: MANIFEST && MANIFEST.admin_state ? MANIFEST.admin_state : null,
        note: 'verification happens inside the registry contract; the facade only reports what the contract decides',
      },
      seps: {
        sep1: '/.well-known/stellar.toml',
        sep10: sep10.status(),
        sep6: {info: '/v1/sep6/info', deposit: '/v1/deposit', withdraw: '/v1/withdraw', transactions: '/v1/transactions'},
        sep12: 'not_implemented',
      },
      assets: [
        {
          code: sep6.currency().code,
          issuer: ISSUER,
          sac_admin: GATEWAY_ID,
          is_asset_anchored: false,
          anchor_asset_type: 'crypto',
          status: placeholders ? 'not_deployed' : 'configured; verify receipts',
          fee_fixed: sep6.feeFixed(),
          min_amount: sep6.minAmount(),
          max_amount: sep6.maxAmount(),
        },
      ],
      domains: [
        {
          network: 'source-testnet',
          adapter_id: '3dcbf6f582455337083d5f6d36721f6d63d47af0bef870a043c02aca7850dac9',
          state: placeholders ? 'NotDeployed' : 'Configured; verify receipts',
          consensus_kind: 'deterministic-2-of-3-demo',
          security_backing: 'SignatureSet 2-of-3 or ZkProof groth16-bn254',
          required_depth: 2,
          last_finalized: MANIFEST && MANIFEST.finality ? MANIFEST.finality.last_finalized : null,
        },
      ],
      source_chain: {
        reachable: simInfo ? !(simInfo && simInfo.error) : false,
        info: simInfo,
        latest_block: latestBlock,
        note: 'the source side of this deployment is a deterministic simulator; when it is unreachable the facade says so instead of pretending',
      },
      endpoints: {
        stellar_toml: '/.well-known/stellar.toml',
        info: '/v1/info',
        health: '/v1/health',
        capabilities: '/v1/capabilities',
        deployment: '/v1/deployment',
        self_audit: '/v1/self-audit',
        sep10: '/v1/sep10/auth?account=G...',
        sep6_info: '/v1/sep6/info',
        deposit: '/v1/deposit?asset_code=wSRC&amount=10 (SEP-10 session; the record account is the token subject, never a caller-chosen one)',
        withdraw: '/v1/withdraw?asset_code=wSRC&amount=10&dest=... (SEP-10 session; same rule)',
        transactions: '/v1/transactions (SEP-10 session; history scoped to the token subject) or ?id= for one record',
        note: 'the unversioned paths (/info, /deposit, ...) remain as aliases of these /v1 routes; opening records and reading history are never anonymous, because a record names an account',
      },
      hardening: {
        bls: 'real aggregate signature: demo 2-of-3 validators, H = hash_to_g1(height||state_root||event_root), public key pinned in the domain policy',
        merkle: 'binary Merkle tree over event payloads, leaf = sha256(message_id || payload_hash)',
        hwm: 'high-water-mark replay protection keyed by (source_domain, target_domain, sender), plus a processed message-id set',
        fee: 'fixed fee chosen at submission time, paid by the relayer in XLM and repaid from the locked source amount; not market pricing',
        negative_tests: [
          'zeroed signature must refuse',
          'tampered signature must refuse',
          'declared root mismatch must refuse',
          'evidence version 99 must refuse',
          'replay of a processed nonce must refuse',
          'forged Groth16 proof with the right shape must refuse',
        ],
      },
    });
  }

  // ---- user-initiated lock and relay (SEP-10, no operator token) -----------
  //
  // The first two entrypoints on this facade were operator-only: a demo where a
  // user cannot start anything is a demo of an API, not of a system. These two
  // put the same two actions behind the *user's* own SEP-10 session instead of a
  // shared operator secret:
  //
  //   POST /v1/user/lock   a user opens a lock on the source chain for themselves
  //   POST /v1/user/relay  a user asks for one relayer pass, without holding the
  //                        operator token
  //
  // What that deliberately does NOT change:
  //
  //   * It grants no new authority. The relayer still signs and pays, the
  //     registry still decides whether anything is final, and the gateway still
  //     mints only against a verified Merkle proof. A user who can ask for a
  //     relay pass can ask for work the operator could already trigger.
  //   * It cannot redirect value. The lock's recipient is forced to the session
  //     subject, so a session cannot open a lock that mints to somebody else.
  //   * It is off by default (LUMEN_ALLOW_USER_RELAY=1) and per-account
  //     cooldown-limited, so a stranger with a session cannot use the relayer's
  //     XLM as a free faucet.

  if (pathname === '/v1/user/lock') {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'opening a lock is POST');
    const claims = requireSession(req, res);
    if (!claims) return undefined;
    const parsed = await readBody(req);
    if (parsed.error) return fail(res, 400, 'invalid_request', parsed.error);
    const body = parsed.body || {};
    const amount = String(body.amount === undefined ? '' : body.amount).trim();
    if (!/^\d{1,18}$/.test(amount) || Number(amount) <= 0) {
      return fail(res, 400, 'invalid_request', 'amount must be positive base units', {example: '{ "amount": "137000000", "count": 3 }'});
    }
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 5) {
      return fail(res, 400, 'invalid_request', 'count must be an integer between 1 and 5');
    }
    // The recipient is not a parameter. It is the session's own account, so a
    // session cannot lock funds that will be minted to somebody else.
    const recipient = claims.sub;
    const result = rateLimit.consume(req);
    for (const [key, value] of Object.entries(rateLimit.headers(result))) res.setHeader(key, value);
    if (!result.allowed) return fail(res, 429, 'rate_limited', undefined, {limit_per_minute: result.limit});
    try {
      const response = await fetch(`${SIM_URL}/lock`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        // The simulator takes base units as a number; the facade accepts a
        // string so that an 18-digit amount survives the trip through JSON
        // without being rounded by a float on the way in or out.
        body: JSON.stringify({amount: Number(amount), recipient, count}),
      });
      // The source simulator answers a refusal with a plain-text reason rather
      // than an envelope, and piping that through JSON.parse turned a clear
      // "that recipient is not a strkey" into "Unexpected token F".
      const raw = await response.text();
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = {reason: raw.slice(0, 400)};
      }
      if (!response.ok) {
        return fail(res, response.status === 400 ? 400 : 502, 'source_refused', 'the source chain refused to open the lock', payload);
      }
      return json(res, 200, {
        ...payload,
        opened_for: recipient,
        initiated_by: 'sep10 session',
        note: 'the recipient is forced to the session account; a session cannot open a lock that mints elsewhere',
      });
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the source chain is not reachable: ${error.message}`);
    }
  }

  if (pathname === '/v1/user/relay') {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'a relay pass is POST');
    if (process.env.LUMEN_ALLOW_USER_RELAY !== '1') {
      return fail(res, 403, 'relay_disabled', undefined, {
        enable: 'LUMEN_ALLOW_USER_RELAY=1 (the operator relay stays behind OPERATOR_TOKEN either way)',
      });
    }
    const claims = requireSession(req, res);
    if (!claims) return undefined;
    const parsed = parseHeight(query.get('height'));
    if (!parsed.ok) return fail(res, 400, 'invalid_request', 'height must be a positive integer');

    const since = Date.now() - (userRelayAt.get(claims.sub) || 0);
    if (since < USER_RELAY_COOLDOWN_MS) {
      return fail(res, 429, 'relay_cooldown', undefined, {
        retry_after_seconds: Math.ceil((USER_RELAY_COOLDOWN_MS - since) / 1000),
        per: 'account',
      });
    }
    if (relayInFlight) return fail(res, 429, 'relay_busy');
    relayInFlight = true;
    userRelayAt.set(claims.sub, Date.now());
    try {
      const result = await runRelayer(parsed.height);
      const reconciled = await sep6.reconcile().catch(() => null);
      return json(res, result.ok ? 200 : 500, {
        ...result,
        reconciled,
        initiated_by: 'sep10 session',
        account: claims.sub,
        note: 'the relayer signed and paid; the user asked for the pass and nothing more',
      });
    } finally {
      relayInFlight = false;
      lastRelayFinishedAt = Date.now();
    }
  }

  // ---- cash out to a local currency through an external SEP-6 anchor -------
  //
  // These routes are new, and they are additive: the existing SEP surface is
  // untouched. The reason they exist at all is that Lumen Gate is not an anchor
  // and does not intend to become one -- the exit into a bank account belongs to
  // a licensed counterparty, and the state of the art for plugging into one is
  // SEP-1 + SEP-10 + SEP-6. Everything here is a thin, transparent proxy: the
  // user's own authorisation travels to the anchor, the anchor's answers travel
  // back unedited, and the facade stores nothing.

  if (route === 'GET /v1/cashout/anchor') {
    try {
      const discovered = await trAnchor.discover();
      const rateNote = await trAnchor.info(null, discovered).then(
        (info) => (info.withdraw && info.withdraw.USDC ? 'withdraw enabled' : 'withdraw not offered'),
        () => 'info endpoint requires authentication'
      );
      return json(res, 200, {
        anchor: discovered,
        withdraw: rateNote,
        note: "read live from the anchor's stellar.toml; the facade adds nothing and caches nothing",
      });
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the cash-out anchor could not be read: ${error.message}`, {
        anchor_home_domain: trAnchor.homeDomain(),
        code: error.code || null,
      });
    }
  }

  if (route === 'GET /v1/cashout/bridge') {
    // Is there a real market route from our wrapped asset into the asset the
    // anchor exits? The answer is read from Horizon, not assumed, and when there
    // is no route this endpoint says so instead of quoting a made-up price.
    try {
      const source = query.get('source_asset') || process.env.CASHOUT_SOURCE_ASSET || TOKEN_ID || '';
      const amount = /^\d+(\.\d{1,7})?$/.test(String(query.get('amount') || '1')) ? query.get('amount') || '1' : '1';
      const discovered = await trAnchor.discover();
      const usdc = discovered.usdc || {code: 'USDC', issuer: trAnchor.USDC_ISSUER_FALLBACK};
      const [code, issuer] = String(source).split(':');
      if (!issuer) {
        return json(res, 200, {
          route: 'unknown',
          simplification: true,
          detail: 'no wrapped-asset issuer is configured on this deployment, so no market route can be looked up',
          configured_source_asset: source || null,
          usdc,
        });
      }
      const path = await trAnchor.findBridgePath({
        sourceAsset: {code, issuer},
        amount,
        destinationAsset: {code: usdc.code, issuer: usdc.issuer},
      });
      if (path && path.kind === 'order_book') {
        return json(res, 200, {
          route: 'order_book',
          simplification: false,
          detail: `a path payment route exists for ${amount} ${code}: the swap can be executed as a real DEX trade`,
          path,
        });
      }
      return json(res, 200, {
        route: 'none',
        simplification: true,
        detail:
          'no order book route from the wrapped asset to the anchor asset exists on this network, so the swap is a counterparty exchange at a configured rate, not a market trade',
        lookup: path,
        configured: {
          counterparty: process.env.TR_SWAP_SECRET ? 'configured' : 'not configured',
          rate: Number(process.env.TR_SWAP_RATE || '1'),
        },
      });
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the bridge route could not be read: ${error.message}`);
    }
  }

  if (route === 'GET /v1/cashout/challenge') {
    const account = query.get('account');
    if (!account || !/^G[A-Z0-9]{55}$/.test(account)) {
      return fail(res, 400, 'invalid_request', 'a Stellar account is required', {example: '/v1/cashout/challenge?account=G...'});
    }
    try {
      const discovery = await trAnchor.discover();
      const response = await fetch(`${discovery.web_auth_endpoint}?account=${encodeURIComponent(account)}`);
      const body = await response.text();
      if (!response.ok) {
        return fail(res, 502, 'upstream_unavailable', `the anchor refused to issue a challenge (${response.status})`, {
          anchor: discovery.home_domain,
        });
      }
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(body);
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the cash-out anchor is unreachable: ${error.message}`);
    }
  }

  if (route === 'POST /v1/cashout/token') {
    // The challenge comes back signed by the user's own key. The facade forwards
    // it and returns the anchor's token; it does not mint one, cannot forge one,
    // and does not keep a copy.
    const parsed = await readBody(req);
    if (parsed.error) return fail(res, 400, 'invalid_request', parsed.error);
    const transaction = parsed.body && parsed.body.transaction;
    if (!transaction || typeof transaction !== 'string') {
      return fail(res, 400, 'invalid_request', 'the signed challenge transaction is required', {
        expect: '{ "transaction": "<base64 XDR>" }',
      });
    }
    try {
      const discovery = await trAnchor.discover();
      const response = await fetch(discovery.web_auth_endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({transaction}),
      });
      const body = await response.text();
      if (!response.ok) {
        let anchorMessage = body;
        try {
          const parsedBody = JSON.parse(body);
          anchorMessage = parsedBody.error || parsedBody.detail || body;
        } catch {
          // keep the raw text
        }
        return fail(res, 401, 'unauthorized', `the anchor rejected the signed challenge: ${anchorMessage}`, {
          anchor: discovery.home_domain,
        });
      }
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(body);
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the cash-out anchor is unreachable: ${error.message}`);
    }
  }

  if (route === 'POST /v1/cashout/start') {
    // Starts a real SEP-6 withdrawal. The anchor's own token is required, sent as
    // X-Anchor-Token: it is the user's credential for the external anchor, not
    // this facade's operator token, and conflating the two would let an operator
    // open withdrawals on somebody else's behalf.
    const anchorToken = String(req.headers['x-anchor-token'] || '').trim();
    if (!anchorToken) {
      return fail(res, 401, 'unauthorized', 'the anchor session token is required', {
        how: 'send X-Anchor-Token: <token minted by POST /v1/cashout/token>',
      });
    }
    const parsed = await readBody(req);
    if (parsed.error) return fail(res, 400, 'invalid_request', parsed.error);
    const body = parsed.body || {};
    const amount = String(body.amount || '').trim();
    const account = String(body.account || '').trim();
    if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
      return fail(res, 400, 'invalid_request', 'amount must be a positive decimal with at most 7 places', {
        example: '{ "amount": "25", "account": "G..." }',
      });
    }
    if (!/^G[A-Z0-9]{55}$/.test(account)) {
      return fail(res, 400, 'invalid_request', 'account must be the Stellar account that owns the anchor session');
    }
    try {
      const discovery = await trAnchor.discover();
      const instructions = await trAnchor.startWithdraw({
        amount,
        account,
        assetCode: 'USDC',
        token: anchorToken,
        discovered: discovery,
      });
      return json(res, 200, {
        transaction_id: instructions.transaction_id,
        treasury: instructions.treasury,
        memo: instructions.memo,
        memo_type: instructions.memo_type,
        amount,
        asset_code: 'USDC',
        asset_issuer: discovery.usdc ? discovery.usdc.issuer : trAnchor.USDC_ISSUER_FALLBACK,
        eta: instructions.eta,
        fee_percent: instructions.fee_percent,
        extra_info: instructions.extra_info,
        note: 'pay the asset to the treasury with the memo attached; the anchor identifies the deposit by the memo alone',
      });
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the anchor did not open a withdrawal: ${error.message}`, {
        code: error.code || null,
      });
    }
  }

  if (route === 'GET /v1/cashout/status') {
    const anchorToken = String(req.headers['x-anchor-token'] || '').trim();
    if (!anchorToken) {
      return fail(res, 401, 'unauthorized', 'the anchor session token is required', {
        how: 'send X-Anchor-Token: <token minted by POST /v1/cashout/token>',
      });
    }
    const id = String(query.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
      return fail(res, 400, 'invalid_request', 'id must be the transaction id the anchor returned');
    }
    try {
      const discovery = await trAnchor.discover();
      const current = await trAnchor.transaction({id, token: anchorToken, discovered: discovery});
      return json(res, 200, {
        id,
        status: current.status,
        amount_in: current.amount_in,
        amount_out: current.amount_out,
        amount_fee: current.amount_fee,
        external_transaction_id: current.external_transaction_id,
        stellar_transaction_id: current.stellar_transaction_id,
        message: current.message || null,
      });
    } catch (error) {
      return fail(res, 502, 'upstream_unavailable', `the anchor did not answer for ${id}: ${error.message}`);
    }
  }

  if (req.method === 'GET') {
    return fail(res, 404, 'not_found', `no route for ${pathname}`, {routes: ROUTES});
  }
  return fail(res, 404, 'not_found', `no route for ${req.method} ${pathname}`, {routes: ROUTES});
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lumen-Operator, X-Lumen-Session',
    });
    res.end();
    return;
  }

  securityHeaders(res);
  cors(res, req);

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = canonicalPath(url.pathname.replace(/\/+$/, '') || '/');

  if (method !== 'GET' && method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', `${method} is not accepted on this facade`, {
      allowed: ['GET', 'POST', 'OPTIONS'],
    });
  }

  // Public reads are rate limited; writes are already gated by a credential.
  if (method === 'GET' && PUBLIC_READS.has(`${method} ${pathname}`)) {
    const result = rateLimit.consume(req);
    for (const [key, value] of Object.entries(rateLimit.headers(result))) res.setHeader(key, value);
    if (!result.allowed) {
      return fail(res, 429, 'rate_limited', undefined, {
        limit_per_minute: result.limit,
        address: rateLimit.address(req),
      }, rateLimit.headers(result));
    }
  }

  const forwarded = new Proxy(req, {
    get(target, property) {
      if (property === 'method') return method;
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  try {
    // Handlers answer the response themselves; a handler that returns without
    // answering is a bug, not something to paper over with an empty 200.
    await handle(forwarded, res, pathname, url.searchParams);
    if (!res.writableEnded) {
      fail(res, 500, 'internal_error', `no answer was produced for ${method} ${pathname}`);
    }
  } catch (error) {
    if (!res.writableEnded) {
      fail(res, 500, 'internal_error', 'the facade failed while handling the request', {
        cause: String((error && error.message) || error),
      });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const status = sep10.status();
  console.log(`Anchor facade listening on 0.0.0.0:${PORT}`);
  console.log(`  discovery:   /.well-known/stellar.toml`);
  console.log(`  info:        /v1/info            (aliases: /info, /)`);
  console.log(`  sep-10:      /v1/sep10/auth      ${status.configured ? `signing as ${status.signing_key}` : 'NOT CONFIGURED (set SEP10_SIGNING_SECRET)'}`);
  console.log(`  sep-6:       /v1/sep6/info, /v1/deposit, /v1/withdraw, /v1/transactions`);
  console.log(`  audit:       /v1/self-audit`);
  console.log(`  registry:    ${REGISTRY_ID}`);
  console.log(`  gateway:     ${GATEWAY_ID}`);
  console.log(`  source:      ${SIM_URL}`);
  console.log(`  writes:      ${OPERATOR_TOKEN ? 'operator token required' : 'DISABLED (no OPERATOR_TOKEN)'}`);
  console.log(`  relay:       ${process.env.LUMEN_ALLOW_RELAY === '1' ? `enabled, ${RELAY_COOLDOWN_MS}ms cooldown` : 'disabled'}`);
  console.log(`  rate limit:  ${process.env.RATE_LIMIT_DISABLED === '1' ? 'disabled' : `${process.env.RATE_LIMIT_PER_MIN || 60} requests/minute per address`}`);
});

module.exports = {server, canonicalPath, renderStellarToml};
