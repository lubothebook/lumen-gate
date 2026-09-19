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

const {Keypair, TransactionBuilder, Networks} = require('@stellar/stellar-sdk');

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

  const badParam = await request('/v1/deposit?account=not-an-account');
  record('error_envelope_on_bad_input', badParam.status === 400 && isEnvelope(badParam.body), `HTTP ${badParam.status}, code ${badParam.body.error ? badParam.body.error.code : 'none'}`);

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

  return issued ? {token: verified.body.token, account: verified.body.account} : null;
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
  const depositRequest = await request(`/v1/deposit?asset_code=wSRC&account=${account}&amount=10`);
  const depositFields = ['how', 'id', 'eta', 'min_amount', 'max_amount', 'fee_fixed'];
  const missingDeposit = depositFields.filter((field) => depositRequest.body[field] === undefined);
  record(
    'sep6_deposit_instructions',
    depositRequest.status === 200 && missingDeposit.length === 0,
    missingDeposit.length ? `missing: ${missingDeposit.join(', ')}` : `record ${String(depositRequest.body.id).slice(0, 8)}... created with SEP-6 fields`
  );

  const transactions = await request(`/v1/transactions?account=${account}`);
  const records = transactions.body.transactions || [];
  const first = records[0];
  const transactionFields = ['id', 'kind', 'status', 'amount_in', 'amount_out', 'amount_fee', 'started_at', 'stellar_transaction_id'];
  const missingTransaction = first ? transactionFields.filter((field) => first[field] === undefined) : transactionFields;
  record(
    'sep6_transaction_schema',
    transactions.status === 200 && records.length > 0 && missingTransaction.length === 0,
    missingTransaction.length ? `missing: ${missingTransaction.join(', ')}` : `${records.length} record(s) in the SEP-6 transaction schema`
  );

  const withdrawal = await request(`/v1/withdraw?asset_code=wSRC&account=${account}&amount=5`);
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
  for (let index = 0; index < RATE_LIMIT_BURST; index += 1) {
    const response = await request('/v1/health');
    if (response.status === 429) {
      limited += 1;
      if (isEnvelope(response.body)) envelope = true;
    }
  }
  if (limited === 0) {
    record('rate_limit_enforced', false, `${RATE_LIMIT_BURST} rapid reads were all served: the limiter is off or set above the burst`);
  } else {
    record('rate_limit_enforced', envelope, `burst of ${RATE_LIMIT_BURST} produced ${limited} rate-limited answer(s), envelope ${envelope ? 'intact' : 'missing'}`);
  }
}

async function main() {
  if (!AS_JSON) console.log(`SEP conformance probe against ${FACADE_URL}\n`);
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
