#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// The cash-out exit, driven through the facade instead of around it.
//
// anchor/cashout-client.js proves the *client* works against the anchor
// directly. This proves the *deployment* works: every request goes through the
// facade's public routes, which is the path the console's Cash out tab takes.
// The difference matters, because a proxy is where credentials get confused —
// this script asserts that the facade never needs the operator token, that the
// anchor's session token is what authorises the withdrawal, and that an
// unauthenticated caller gets a refusal rather than somebody else's money.
//
// Configuration (env):
//   FACADE_URL        facade origin                     (required)
//   CASHOUT_USER_SECRET  the paying account's secret     (required)
//   CASHOUT_AMOUNT    how much to exit                  (default: 0.2)
//   CASHOUT_OUT       where to write the record         (default: deployments/cashout-live.json)
//
// Usage:
//   FACADE_URL=http://127.0.0.1:8081 CASHOUT_USER_SECRET=S... node tools/cashout-live.js
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { Keypair, TransactionBuilder, Horizon, Asset, Operation, Memo, Networks } = require('@stellar/stellar-sdk');

const ROOT = path.join(__dirname, '..');
const FACADE = (process.env.FACADE_URL || '').replace(/\/+$/, '');
const AMOUNT = process.env.CASHOUT_AMOUNT || '0.2';
const OUT = process.env.CASHOUT_OUT || path.join(ROOT, 'deployments', 'cashout-live.json');
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';

const checks = [];

function record(check, passed, detail, extra = {}) {
  checks.push({ check, passed, detail, at: new Date().toISOString(), ...extra });
  console.log(`  [${passed ? 'pass' : 'FAIL'}] ${check}\n         ${detail}`);
}

async function call(url, { method = 'GET', body, anchorToken, operatorToken } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (anchorToken) headers['X-Anchor-Token'] = anchorToken;
  if (operatorToken) headers.authorization = `Bearer ${operatorToken}`;
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, payload };
}

function envelope(payload) {
  return payload && payload.error && typeof payload.error.code === 'string' && typeof payload.error.message === 'string';
}

async function main() {
  if (!FACADE) {
    console.error('FACADE_URL is required');
    process.exit(2);
  }
  const secret = (process.env.CASHOUT_USER_SECRET || '').trim();
  if (!secret) {
    console.error('CASHOUT_USER_SECRET is required');
    process.exit(2);
  }
  const started = new Date().toISOString();
  const user = Keypair.fromSecret(secret);
  const account = user.publicKey();

  // 1. discovery through the facade
  const anchorResult = await call(`${FACADE}/v1/cashout/anchor`);
  record('facade_reads_the_anchor', anchorResult.ok && Boolean(anchorResult.payload.anchor),
    anchorResult.ok
      ? `the facade discovered ${anchorResult.payload.anchor.home_domain} and reports ${anchorResult.payload.withdraw}`
      : `the facade could not read the anchor: ${JSON.stringify(anchorResult.payload).slice(0, 200)}`);
  const anchor = anchorResult.payload.anchor;

  // 2. the bridge route, asked the way the console asks it
  const bridgeResult = await call(`${FACADE}/v1/cashout/bridge?amount=${encodeURIComponent(AMOUNT)}`);
  record('facade_reports_the_bridge_honestly', bridgeResult.ok && typeof bridgeResult.payload.route === 'string',
    bridgeResult.ok
      ? `bridge route is "${bridgeResult.payload.route}": ${String(bridgeResult.payload.detail).slice(0, 150)}`
      : `bridge route lookup failed: ${JSON.stringify(bridgeResult.payload).slice(0, 200)}`,
    { route: bridgeResult.payload.route, simplification: bridgeResult.payload.simplification });

  // 3. no session, no withdrawal: the facade must refuse this itself
  const anonymous = await call(`${FACADE}/v1/cashout/start`, { method: 'POST', body: { amount: AMOUNT, account }, });
  record('withdrawal_without_a_session_is_refused', !anonymous.ok && envelope(anonymous.payload),
    anonymous.ok
      ? 'the facade opened a withdrawal with no anchor session, which means any caller could spend somebody else\'s balance'
      : `refused with HTTP ${anonymous.status} and the error envelope (${anonymous.payload.error.code})`);

  // 4. the operator token must not open a withdrawal either: it is not the user
  const withOperator = await call(`${FACADE}/v1/cashout/start`, {
    method: 'POST',
    body: { amount: AMOUNT, account },
    anchorToken: process.env.OPERATOR_TOKEN || undefined,
  });
  record('the_operator_token_is_not_a_substitute_for_the_user',
    !withOperator.ok,
    withOperator.ok
      ? 'the operator token was accepted where a user session belongs'
      : `the facade answered HTTP ${withOperator.status} instead of opening a record, because the anchor rejected a token that was not the user's`,
    { status: withOperator.status, output: JSON.stringify(withOperator.payload).slice(0, 300) });

  // 5. SEP-10 through the facade
  const challenge = await call(`${FACADE}/v1/cashout/challenge?account=${encodeURIComponent(account)}`);
  if (!challenge.ok) {
    record('sep10_challenge_issued', false, `no challenge: ${JSON.stringify(challenge.payload).slice(0, 200)}`);
    return finish(started);
  }
  const challengeTx = TransactionBuilder.fromXDR(challenge.payload.transaction, challenge.payload.network_passphrase || Networks.TESTNET);
  challengeTx.sign(user);
  const tokenResult = await call(`${FACADE}/v1/cashout/token`, {
    method: 'POST',
    body: { transaction: challengeTx.toXDR() },
  });
  record('sep10_session_issued_through_the_facade', tokenResult.ok && Boolean(tokenResult.payload.token),
    tokenResult.ok
      ? `the anchor issued a session for ${account} and the facade passed it back without storing it`
      : `the anchor refused the signed challenge: ${JSON.stringify(tokenResult.payload).slice(0, 250)}`);
  if (!tokenResult.ok) return finish(started);
  const anchorToken = tokenResult.payload.token;

  // 6. open the withdrawal
  const start = await call(`${FACADE}/v1/cashout/start`, {
    method: 'POST',
    body: { amount: AMOUNT, account },
    anchorToken,
  });
  if (!start.ok) {
    record('withdrawal_opened', false, `the anchor did not open a withdrawal: ${JSON.stringify(start.payload).slice(0, 250)}`);
    return finish(started);
  }
  const instructions = start.payload;
  record('withdrawal_opened', true,
    `withdrawal ${instructions.transaction_id}: pay ${instructions.amount} ${instructions.asset_code} to ${instructions.treasury} with memo ${instructions.memo} (${instructions.memo_type})`,
    { transaction_id: instructions.transaction_id, treasury: instructions.treasury, memo: instructions.memo });

  // 7. pay it, with the user's own key
  const horizon = new Horizon.Server(HORIZON_URL);
  const source = await horizon.loadAccount(account);
  const paymentTx = new TransactionBuilder(source, { fee: '10000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({
      destination: instructions.treasury,
      asset: new Asset(instructions.asset_code, instructions.asset_issuer),
      amount: instructions.amount,
    }))
    .addMemo(Memo.id(String(instructions.memo)))
    .setTimeout(60)
    .build();
  paymentTx.sign(user);
  const submitted = await horizon.submitTransaction(paymentTx);
  record('paid_the_anchor_treasury_with_the_memo', Boolean(submitted.hash),
    `sent ${instructions.amount} ${instructions.asset_code} with memo ${instructions.memo}, transaction ${submitted.hash} on ledger ${submitted.ledger}`,
    { hash: submitted.hash, ledger: submitted.ledger });

  // 8. poll through the facade until the anchor stops moving
  let final = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const status = await call(`${FACADE}/v1/cashout/status?id=${encodeURIComponent(instructions.transaction_id)}`, { anchorToken });
    if (!status.ok) {
      record('status_readable', false, `status failed: ${JSON.stringify(status.payload).slice(0, 200)}`);
      break;
    }
    final = status.payload;
    if (['completed', 'error', 'refunded', 'expired'].includes(final.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  record('anchor_reports_the_payout', final && final.status === 'completed',
    final
      ? `anchor reports ${final.status}${final.amount_out ? `, paid out ${final.amount_out}` : ''}${final.external_transaction_id ? `, reference ${final.external_transaction_id}` : ''}`
      : 'no terminal status came back within the polling window',
    { final });

  finish(started, { anchor, account, instructions, payment: submitted, final });
}

function finish(started, extra = {}) {
  const passed = checks.filter((row) => row.passed).length;
  const output = {
    flow: 'cash out to a local currency, driven through the facade',
    facade: FACADE,
    amount: AMOUNT,
    started_at: started,
    finished_at: new Date().toISOString(),
    checks,
    passed,
    total: checks.length,
    all_passed: passed === checks.length,
    ...extra,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  console.log(`record: ${path.relative(ROOT, OUT)}`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`cash-out probe failed: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
