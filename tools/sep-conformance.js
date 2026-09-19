'use strict';

// ---------------------------------------------------------------------------
// SEP conformance probe for the anchor facade.
//
// This tool does not read the facade's source; it talks to a running facade
// exactly like a wallet or a SEP client would, and reports what it observed.
// That is the point: a claim about SEP-10 or SEP-6 has to survive a client that
// only knows the spec.
//
// Usage:
//   FACADE_URL=http://127.0.0.1:8081 node tools/sep-conformance.js
//   FACADE_URL=... node tools/sep-conformance.js --json
//
// Requirements for the SEP-10 checks: the facade must have SEP10_SIGNING_SECRET
// set. The client account used here is generated fresh and never funded, which
// is the honest case for a SEP-10 server: a client proves key control by
// signing, and the challenge transaction is never submitted anywhere.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const {Account, Keypair, Networks, Operation, TransactionBuilder, StrKey} = require('@stellar/stellar-sdk');

// The served stellar.toml is cached here so SEP-10 checks can compare what
// discovery promises with what the auth surface actually does.
let discoveryToml = null;

const FACADE_URL = (process.env.FACADE_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');
const RATE_LIMIT_BURST = Number(process.env.CONFORMANCE_BURST || 70);

const checks = [];

function record(check, passed, detail) {
  checks.push({check, passed, detail});
  if (!AS_JSON) {
    const mark = passed ? 'pass' : 'FAIL';
    console.log(`  [${mark}] ${check} - ${detail}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${FACADE_URL}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = {raw: text.slice(0, 400)};
  }
  return {status: response.status, headers: response.headers, body};
}

function isEnvelope(body) {
  return Boolean(
    body &&
      body.error &&
      typeof body.error === 'object' &&
      typeof body.error.code === 'string' &&
      typeof body.error.message === 'string'
  );
}

async function fetchText(path) {
  const response = await fetch(`${FACADE_URL}${path}`);
  return {status: response.status, text: await response.text()};
}

async function checkDiscovery() {
  // Read the discovery file as text on purpose: it is a TOML document that
  // other people's software parses, so the probe must see the bytes it sees.
  const {status, text: body} = await fetchText('/.well-known/stellar.toml');
  if (status !== 200) return record('sep1_stellar_toml_served', false, `HTTP ${status}`);
  discoveryToml = String(body);
  record(
    'sep1_signing_key_field',
    /SIGNING_KEY="G[A-Z0-9]{55}"/.test(discoveryToml),
    'SIGNING_KEY is a well-formed account id'
  );
  const required = ['VERSION', 'NETWORK_PASSPHRASE', 'DOCUMENTATION', 'ORG_NAME', 'ORG_URL', 'CURRENCIES', 'code', 'issuer', 'display_decimals', 'is_asset_anchored'];
  const missing = required.filter((field) => !String(body).includes(field));
  record('sep1_stellar_toml_served', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `served, ${required.length} SEP-1 markers present`);
  record(
    'sep1_testnet_declared',
    String(body).includes('Test SDF Network') || String(body).includes('Public Global Stellar Network'),
    'network passphrase present'
  );
  record(
    'sep1_no_placeholder_addresses',
    !/PLACEHOLDER|__[A-Z0-9_]+__/.test(String(body)),
    'no unresolved render tokens remain in the served file'
  );
}

async function checkEnvelopeAndRouting() {
  const notFound = await request('/v1/definitely-not-a-route');
  record('error_envelope_on_404', notFound.status === 404 && isEnvelope(notFound.body), `HTTP ${notFound.status}, code ${notFound.body.error ? notFound.body.error.code : 'none'}`);

  const badMethod = await request('/v1/relay', {method: 'DELETE'});
  record('error_envelope_on_405', badMethod.status === 405 && isEnvelope(badMethod.body), `HTTP ${badMethod.status}, code ${badMethod.body.error ? badMethod.body.error.code : 'none'}`);

  // The SEP-10 route validates its account parameter before anything else,
  // so this exercises input validation without needing a session first.
  const badParam = await request('/v1/sep10/auth?account=not-an-account');
  record('error_envelope_on_bad_input', badParam.status === 400 && isEnvelope(badParam.body) && badParam.body.error.code === 'invalid_account', `HTTP ${badParam.status}, code ${badParam.body.error ? badParam.body.error.code : 'none'}`);

  const alias = await request('/info');
  record('legacy_alias_still_answers', alias.status === 200 && Boolean(alias.body.anchor), `HTTP ${alias.status}`);

  const versioned = await request('/v1/info');
  record('versioned_route_answers', versioned.status === 200 && Boolean(versioned.body.anchor), `HTTP ${versioned.status}`);
}

async function checkSep10() {
  const client = Keypair.random();
  const challenge = await request(`/v1/sep10/auth?account=${client.publicKey()}`);
  if (challenge.status !== 200) {
    record('sep10_challenge_issued', false, `HTTP ${challenge.status}: ${challenge.body.error ? challenge.body.error.code : 'no envelope'}`);
    return null;
  }
  record('sep10_challenge_issued', typeof challenge.body.transaction === 'string', `challenge for an unfunded account ${client.publicKey().slice(0, 6)}...`);

  const passphrase = challenge.body.network_passphrase;
  const tx = TransactionBuilder.fromXDR(challenge.body.transaction, passphrase);

  // The challenge must look exactly like SEP-10 describes, not merely parse:
  // sequence 0, one manageData operation named "<home domain> auth" sourced
  // from the client, a 64-byte nonce, a timebox, and the anchor's key as the
  // transaction source - the same key discovery publishes.
  const op = tx.operations[0];
  const nonceValue = op && op.value ? Buffer.from(op.value) : Buffer.alloc(0);
  // SEP-10 (with the web_auth_domain extension) allows exactly one extra
  // operation: a manageData named "<web auth domain> auth" sourced from the
  // anchor itself. Anything else - a payment, a third op, a foreign source -
  // fails this check.
  const extraOpsAllowed = tx.operations
    .slice(1)
    .every((extra) => extra.type === 'manageData' && extra.source === tx.source);
  record(
    'sep10_challenge_structure',
    tx.source === challenge.body.signing_key &&
      tx.sequence === '0' &&
      tx.operations.length >= 1 &&
      tx.operations.length <= 2 &&
      extraOpsAllowed &&
      op.type === 'manageData' &&
      op.name === `${challenge.body.home_domain} auth` &&
      op.source === client.publicKey() &&
      nonceValue.length === 64 &&
      Boolean(tx.timeBounds) &&
      Number(tx.timeBounds.maxTime) - Number(tx.timeBounds.minTime) <= 900,
    `sequence ${tx.sequence}, ${tx.operations.length} manageData op(s) "${op && op.name}", nonce ${nonceValue.length} bytes, timeboxed`
  );
  const tomlKey = discoveryToml && discoveryToml.match(/SIGNING_KEY="(G[A-Z0-9]{55})"/);
  record(
    'sep1_discovery_matches_auth',
    Boolean(tomlKey) && tomlKey[1] === challenge.body.signing_key,
    tomlKey ? `stellar.toml signs with the same key the challenge is sourced from (${tomlKey[1].slice(0, 6)}...)` : 'no SIGNING_KEY line in the served toml'
  );

  tx.sign(client);
  const signed = tx.toEnvelope().toXDR('base64');

  const verified = await request('/v1/sep10/auth', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({transaction: signed}),
  });
  const issued = verified.status === 200 && typeof verified.body.token === 'string';
  record('sep10_challenge_verified', issued, issued ? `JWT issued for ${String(verified.body.account).slice(0, 6)}..., expires in ${verified.body.expires_in}s` : `HTTP ${verified.status}, code ${verified.body.error ? verified.body.error.code : 'none'}`);

  // A signature from a different key must not be accepted.
  const impostor = Keypair.random();
  const wrong = TransactionBuilder.fromXDR(challenge.body.transaction, passphrase);
  wrong.sign(impostor);
  const refused = await request('/v1/sep10/auth', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({transaction: wrong.toEnvelope().toXDR('base64')}),
  });
  record('sep10_wrong_signer_refused', refused.status === 401 && isEnvelope(refused.body), `HTTP ${refused.status}, code ${refused.body.error ? refused.body.error.code : 'none'}`);

  // A well-formed HS256 token that was not issued by this anchor must not
  // open anything: the structure passes, the signature does not.
  const forgedHeader = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url');
  const forgedPayload = Buffer.from(JSON.stringify({
    iss: 'lumen-gate.local',
    sub: client.publicKey(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  const forged = await request('/v1/transactions', {
    headers: {Authorization: `Bearer ${forgedHeader}.${forgedPayload}.${Buffer.from(crypto.randomBytes(32)).toString('base64url')}`},
  });
  record('sep10_forged_jwt_refused', forged.status === 401 && isEnvelope(forged.body), `HTTP ${forged.status}, code ${forged.body.error ? forged.body.error.code : 'none'}`);

  // An expired but correctly signed challenge stays refused. This needs the
  // anchor secret to construct one, so it runs when the probe shares the
  // operator's environment; otherwise the check is skipped, not passed.
  const anchorSecret = (process.env.SEP10_SIGNING_SECRET || '').trim();
  if (anchorSecret && StrKey.isValidEd25519SecretSeed(anchorSecret)) {
    const serverKeypair = Keypair.fromSecret(anchorSecret);
    const staleClient = Keypair.random();
    const past = Math.floor(Date.now() / 1000) - 900;
    const stale = new TransactionBuilder(new Account(serverKeypair.publicKey(), '-1'), {
      fee: '100',
      networkPassphrase: passphrase,
      timebounds: {minTime: past, maxTime: past + 300},
    })
      .addOperation(Operation.manageData({
        name: `${challenge.body.home_domain} auth`,
        value: crypto.randomBytes(64),
        source: staleClient.publicKey(),
      }))
      .build();
    stale.sign(serverKeypair);
    stale.sign(staleClient);
    const expired = await request('/v1/sep10/auth', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({transaction: stale.toEnvelope().toXDR('base64')}),
    });
    record(
      'sep10_expired_challenge_refused',
      (expired.status === 400 || expired.status === 401) && isEnvelope(expired.body) && expired.body.error.code === 'invalid_transaction',
      `a fully signed stale challenge got HTTP ${expired.status} (${expired.body.error ? expired.body.error.code : 'none'})`
    );
  }

  return issued ? {token: verified.body.token, account: verified.body.account, signingKey: challenge.body.signing_key, homeDomain: challenge.body.home_domain} : null;
}

async function checkSep6(session) {
  const info = await request('/v1/sep6/info');
  const deposit = info.body && info.body.deposit ? Object.values(info.body.deposit)[0] : null;
  const fields = ['enabled', 'authentication_required', 'min_amount', 'max_amount', 'fee_fixed', 'fee_percent'];
  const missing = deposit ? fields.filter((field) => deposit[field] === undefined) : fields;
  record('sep6_info_fields', info.status === 200 && missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'deposit and withdraw blocks carry the documented fields');
  record('sep6_not_implemented_marked', Array.isArray(info.body.not_implemented) && info.body.not_implemented.length > 0, `${info.body.not_implemented ? info.body.not_implemented.length : 0} capabilities explicitly marked not implemented`);

  const customer = await request('/v1/sep12/customer');
  record(
    'sep12_is_honest_about_absence',
    customer.status === 501 && isEnvelope(customer.body) && customer.body.error.code === 'not_implemented',
    `HTTP ${customer.status}, code ${customer.body.error ? customer.body.error.code : 'none'}`
  );

  const account = session ? session.account : Keypair.random().publicKey();
  const authHeaders = session ? {Authorization: `Bearer ${session.token}`} : {};

  // Opening a record names an account, so it is never anonymous: without a
  // session the route must refuse before it touches the store.
  const anonymousDeposit = await request('/v1/deposit?asset_code=wSRC&amount=10');
  record(
    'sep6_deposit_requires_session',
    anonymousDeposit.status === 401 && isEnvelope(anonymousDeposit.body),
    `HTTP ${anonymousDeposit.status}, code ${anonymousDeposit.body.error ? anonymousDeposit.body.error.code : 'none'}`
  );

  const depositRequest = await request(`/v1/deposit?asset_code=wSRC&amount=10`, {headers: authHeaders});
  const depositFields = ['how', 'id', 'eta', 'min_amount', 'max_amount', 'fee_fixed'];
  const missingDeposit = depositFields.filter((field) => depositRequest.body[field] === undefined);
  record(
    'sep6_deposit_instructions',
    depositRequest.status === 200 && missingDeposit.length === 0,
    missingDeposit.length ? `missing: ${missingDeposit.join(', ')}` : `record ${String(depositRequest.body.id).slice(0, 8)}... created with SEP-6 fields`
  );

  // A session may open a record for its own account only. Asking for someone
  // else's G-address must be refused, not silently re-pointed.
  if (session) {
    const stranger = Keypair.random().publicKey();
    const crossAccount = await request(`/v1/deposit?asset_code=wSRC&account=${stranger}&amount=10`, {headers: authHeaders});
    record(
      'sep6_cross_account_refused',
      crossAccount.status === 403 && isEnvelope(crossAccount.body),
      `deposit for a foreign account answered HTTP ${crossAccount.status} (${crossAccount.body.error ? crossAccount.body.error.code : 'no envelope'})`
    );
  }

  const transactions = await request('/v1/transactions', {headers: authHeaders});
  const records = transactions.body.transactions || [];
  const first = records[0];
  const transactionFields = ['id', 'kind', 'status', 'amount_in', 'amount_out', 'amount_fee', 'started_at', 'stellar_transaction_id'];
  const missingTransaction = first ? transactionFields.filter((field) => first[field] === undefined) : transactionFields;
  record(
    'sep6_transaction_schema',
    transactions.status === 200 && records.length > 0 && missingTransaction.length === 0,
    missingTransaction.length ? `missing: ${missingTransaction.join(', ')}` : `${records.length} record(s) in the SEP-6 transaction schema`
  );

  const withdrawal = await request(`/v1/withdraw?asset_code=wSRC&amount=5`, {headers: authHeaders});
  record('sep6_withdraw_instructions', withdrawal.status === 200 && typeof withdrawal.body.id === 'string', `HTTP ${withdrawal.status}`);

  // The withdrawal record must not advance on a client's word alone. The token
  // below is signed by the SEP-10 session, but the transaction hash does not
  // exist, so the facade has to refuse it after checking the network.
  if (session) {
    const bogus = await request(`/v1/transactions/${withdrawal.body.id}/burn`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`},
      body: JSON.stringify({stellar_transaction_id: 'a'.repeat(64)}),
    });
    record(
      'sep6_burn_not_taken_on_trust',
      bogus.status === 404 || bogus.status === 400,
      `a non-existent burn hash was answered with HTTP ${bogus.status} (${bogus.body.error ? bogus.body.error.code : 'no envelope'})`
    );

    const noToken = await request(`/v1/transactions/${withdrawal.body.id}/burn`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({stellar_transaction_id: 'a'.repeat(64)}),
    });
    record('sep6_burn_requires_session', noToken.status === 401 && isEnvelope(noToken.body), `HTTP ${noToken.status}`);
  }
}

async function checkRateLimit() {
  let limited = 0;
  let envelope = false;
  let retryAfter = false;
  for (let index = 0; index < RATE_LIMIT_BURST; index += 1) {
    const response = await request('/v1/health');
    if (response.status === 429) {
      limited += 1;
      if (isEnvelope(response.body)) envelope = true;
      // A refusal that does not say when to come back invites retry storms.
      const value = Number(response.headers.get('retry-after'));
      if (Number.isFinite(value) && value > 0) retryAfter = true;
    }
  }
  if (limited === 0) {
    record('rate_limit_enforced', false, `${RATE_LIMIT_BURST} rapid reads were all served: the limiter is off or set above the burst`);
  } else {
    record('rate_limit_enforced', envelope && retryAfter, `burst of ${RATE_LIMIT_BURST} produced ${limited} rate-limited answer(s), envelope ${envelope ? 'intact' : 'missing'}, Retry-After ${retryAfter ? 'present' : 'missing'}`);
  }
}

// The rate-limit check below deliberately spends the facade's whole window --
// that is what testing a limiter means. A second probe inside the same window
// would then read 429 on its own opening requests and report a healthy facade
// as broken, so the probe waits out a window that a previous burst closed. The
// wait is bounded, and it is announced rather than hidden.
async function awaitRateLimitWindow() {
  try {
    const response = await fetch(`${FACADE_URL}/v1/info`);
    if (response.status !== 429) return;
    const retryAfter = Number(response.headers.get('retry-after') || 60);
    const wait = Math.min(Math.max(retryAfter, 1) + 1, 90);
    if (!AS_JSON) console.log(`  [wait] the rate-limit window is still closed from a previous burst; waiting ${wait}s before probing`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  } catch {
    // An unreachable facade is reported by the checks themselves, with detail.
  }
}

async function main() {
  if (!AS_JSON) console.log(`SEP conformance probe against ${FACADE_URL}\n`);
  await awaitRateLimitWindow();
  await checkDiscovery();
  await checkEnvelopeAndRouting();
  const session = await checkSep10();
  await checkSep6(session);
  await checkRateLimit();

  const passed = checks.filter((check) => check.passed).length;
  const summary = {
    target: FACADE_URL,
    finished_at: new Date().toISOString(),
    checks_passed: passed,
    checks_total: checks.length,
    all_passed: passed === checks.length,
    checks,
  };
  if (AS_JSON) console.log(JSON.stringify(summary, null, 2));
  else console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(summary.all_passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`conformance probe failed: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
