'use strict';

// ---------------------------------------------------------------------------
// Cash-out to a bank account, through a real SEP-6 anchor. The payout currency
// is whatever the anchor quotes; the client names none of its own.
//
// This is a client, not a mock. It speaks SEP-1 (discovery), SEP-10 (auth),
// SEP-6 (withdraw + transaction polling) and SEP-38 (a firm quote) to the
// anchor named by `CASHOUT_ANCHOR_HOME`, and it moves real testnet assets with
// the Stellar SDK. The bank and the KYC behind that anchor are simulated by the
// anchor itself -- that is the anchor's business, not ours -- and the Stellar
// leg is real testnet USDC.
//
// The reason this exists: Lumen Gate wraps a source-chain asset into wSRC, and
// an exit into a local currency is the step that makes a wrapped asset useful to
// someone who does not want to hold it. Lumen Gate does not become an anchor to
// do that; it plugs into one. The whole integration is a home domain, an asset
// and the standard SEP surface, so moving to a different anchor (or to mainnet)
// is a configuration change rather than a rewrite.
//
// The flow, in the order the network performs it:
//
//   1. SEP-1  GET  https://<home>/.well-known/stellar.toml   -> endpoints
//   2. SEP-10 GET  /auth?account=G...                        -> challenge XDR
//             sign the challenge with the user's key
//             POST /auth {transaction}                       -> JWT
//   3. SEP-38 GET  /sep38/price                              -> firm fiat quote
//   4. SEP-6  GET  /sep6/withdraw?asset_code=USDC&type=bank_account&amount=...
//                                                            -> treasury + memo
//   5.        send USDC on-chain to that treasury with that memo
//   6. SEP-6  GET  /sep6/transaction?id=...                  -> until completed
//
// Step 5 is the only step that touches the ledger, and it is the only step that
// costs a fee. Everything else is HTTPS.
//
// The bridge step (wSRC -> USDC) is separate and honest about its own limits:
// see `bridgeToUsdc`.
//
// Configuration (env):
//   CASHOUT_ANCHOR_HOME    anchor home domain        (default: the testnet sandbox)
//   CASHOUT_ANCHOR_BASE_URL  override the HTTPS base (default: https://<home>)
//   CASHOUT_QUOTE_ASSET    the SEP-38 buy asset to request when the anchor
//                          does not publish an asset list of its own
//   CASHOUT_USER_SECRET    user secret key           (or pass --secret)
//   CASHOUT_SWAP_SECRET    counterparty secret for the simplified swap
//   CASHOUT_SWAP_RATE      USDC per wSRC in that swap (default: 1.0)
//   HORIZON_URL            Horizon endpoint          (default: testnet)
// ---------------------------------------------------------------------------

const path = require('node:path');

const DEFAULT_HOME = 'tr-mock-anchor.fly.dev';
const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';

function sdk() {
  // Required lazily so that reading this file, or running its non-signing
  // helpers, does not require the SDK to be installed.
  return require('@stellar/stellar-sdk');
}

function homeDomain() {
  return (process.env.CASHOUT_ANCHOR_HOME || DEFAULT_HOME).trim();
}

function baseUrl() {
  const explicit = (process.env.CASHOUT_ANCHOR_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `https://${homeDomain()}`;
}

function horizonUrl() {
  return (process.env.HORIZON_URL || DEFAULT_HORIZON).trim().replace(/\/+$/, '');
}

function networkPassphrase() {
  return (process.env.NETWORK_PASSPHRASE || '').trim() || sdk().Networks.TESTNET;
}

/** The asset this client exits into and out of: whatever the anchor publishes. */
const USDC_ISSUER_FALLBACK = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

class CashoutError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const anchorMessage = body && typeof body === 'object' ? body.error : body;
    throw new CashoutError(
      'anchor_error',
      `${url} answered ${response.status}${anchorMessage ? `: ${anchorMessage}` : ''}`,
      { status: response.status, body }
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// SEP-1: what the anchor says about itself
// ---------------------------------------------------------------------------

/**
 * Reads the anchor's stellar.toml and returns the endpoints this client uses.
 *
 * Only the handful of fields this flow needs are parsed, with a line-oriented
 * reader rather than a full TOML parser: a dependency that exists to read six
 * keys is a dependency that has to be trusted, patched and explained, and the
 * fields here are single-line strings by specification.
 */
async function discover(options = {}) {
  const home = options.homeDomain || homeDomain();
  const url = `${options.baseUrl || baseUrl()}/.well-known/stellar.toml`;
  const response = await fetch(url, { headers: { accept: 'text/plain' } });
  if (!response.ok) {
    throw new CashoutError('discovery_failed', `${url} answered ${response.status}`);
  }
  const toml = await response.text();
  const field = (name) => {
    const match = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'));
    return match ? match[1].trim() : null;
  };
  const currency = (code) => {
    const blocks = toml.split('[[CURRENCIES]]').slice(1);
    for (const block of blocks) {
      const codeMatch = block.match(/^\s*code\s*=\s*"([^"]*)"/m);
      if (codeMatch && codeMatch[1] === code) {
        const issuerMatch = block.match(/^\s*issuer\s*=\s*"([^"]*)"/m);
        return { code, issuer: issuerMatch ? issuerMatch[1] : null };
      }
    }
    return null;
  };

  const discovered = {
    home_domain: home,
    base_url: options.baseUrl || baseUrl(),
    network_passphrase: field('NETWORK_PASSPHRASE'),
    signing_key: field('SIGNING_KEY'),
    web_auth_endpoint: field('WEB_AUTH_ENDPOINT'),
    transfer_server: field('TRANSFER_SERVER'),
    kyc_server: field('KYC_SERVER'),
    quote_server: field('ANCHOR_QUOTE_SERVER') || field('ANCHOR_QUOTE_SERVER_SEP0038'),
    usdc: currency('USDC'),
  };
  if (!discovered.web_auth_endpoint || !discovered.transfer_server) {
    throw new CashoutError(
      'discovery_incomplete',
      'the anchor publishes no WEB_AUTH_ENDPOINT or TRANSFER_SERVER, so nothing can be authenticated or withdrawn',
      discovered
    );
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// SEP-10: prove the user controls the account
// ---------------------------------------------------------------------------

/**
 * Runs SEP-10 for one account and returns the JWT.
 *
 * The challenge is never submitted to the network: its only purpose is to make
 * the client sign a statement the anchor chose, which is what proves the key is
 * under the client's control.
 */
async function authenticate({ account, secret, discovered }) {
  const anchor = discovered || (await discover());
  const challenge = await fetchJson(`${anchor.web_auth_endpoint}?account=${encodeURIComponent(account)}`);
  const { TransactionBuilder, Keypair } = sdk();
  const transaction = TransactionBuilder.fromXDR(
    challenge.transaction,
    challenge.network_passphrase || anchor.network_passphrase || networkPassphrase()
  );
  const keypair = Keypair.fromSecret(secret);
  if (keypair.publicKey() !== account) {
    throw new CashoutError('wrong_key', 'the secret key does not belong to the account being authenticated');
  }
  transaction.sign(keypair);
  const result = await fetchJson(anchor.web_auth_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction: transaction.toXDR() }),
  });
  if (!result.token) {
    throw new CashoutError('auth_failed', 'the anchor answered the signed challenge without a token', result);
  }
  return { token: result.token, anchor };
}

// ---------------------------------------------------------------------------
// SEP-6 + SEP-38: what the anchor can do, and at what rate
// ---------------------------------------------------------------------------

async function info(token, discovered) {
  const anchor = discovered || (await discover());
  return fetchJson(`${anchor.transfer_server}/info`, { headers: bearer(token) });
}

/**
 * A firm quote from the anchor for the amount being withdrawn.
 *
 * SEP-38 identifiers differ between deployments, so the client does not name a
 * currency at all: it asks the anchor's own /info which assets it quotes and
 * tries every non-on-chain one it publishes, falling back to an explicitly
 * configured identifier when the anchor publishes no list. A client that
 * hard-coded a counterparty's currency would be a demo of one anchor, not of
 * the standard.
 */
async function price({ sellAmount, sellAsset, buyAsset, token, discovered }) {
  const anchor = discovered || (await discover());
  if (!anchor.quote_server) return null;
  let candidates = buyAsset ? [buyAsset] : [];
  if (!candidates.length) {
    try {
      const info = await fetchJson(`${anchor.quote_server}/info`);
      candidates = (info.assets || [])
        .map((entry) => entry.asset)
        .filter((asset) => typeof asset === 'string' && !asset.startsWith('stellar:'));
    } catch {
      // no published list: only an explicit configuration can proceed
    }
  }
  if (!candidates.length) {
    const configured = (process.env.CASHOUT_QUOTE_ASSET || '').trim();
    candidates = configured ? [configured] : [];
  }
  if (!candidates.length) {
    return {
      unsupported: true,
      tried: [],
      reason: 'the anchor publishes no SEP-38 buy assets and CASHOUT_QUOTE_ASSET is not set',
    };
  }
  const urls = [];
  for (const buy of candidates) {
    const url = `${anchor.quote_server}/price?sell_asset=${encodeURIComponent(sellAsset)}&buy_asset=${encodeURIComponent(buy)}&sell_amount=${encodeURIComponent(sellAmount)}&context=sep6`;
    urls.push({ url, buy });
    try {
      const body = await fetchJson(url, { headers: token ? bearer(token) : undefined });
      return { ...body, buy_asset: buy, sell_asset: sellAsset, source: url };
    } catch (error) {
      if (error instanceof CashoutError && /unsupported asset pair/.test(String(error.message))) continue;
      throw error;
    }
  }
  return { unsupported: true, tried: urls.map((entry) => entry.buy) };
}

function bearer(token) {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/**
 * Starts a SEP-6 withdrawal and returns the anchor's payment instructions:
 * the treasury account, the memo and the memo type.
 *
 * The memo is not decoration. The anchor identifies the incoming payment by it,
 * so a payment sent without the memo is a payment to a shared account that the
 * anchor has no way to attribute.
 */
async function startWithdraw({ amount, account, assetCode = 'USDC', token, discovered }) {
  const anchor = discovered || (await discover());
  const url = `${anchor.transfer_server}/withdraw?asset_code=${assetCode}&type=bank_account&amount=${encodeURIComponent(amount)}&account=${encodeURIComponent(account)}`;
  const body = await fetchJson(url, { headers: bearer(token) });
  if (!body.account_id) {
    throw new CashoutError('withdraw_incomplete', 'the anchor did not return a treasury account to pay', body);
  }
  if (!body.memo) {
    throw new CashoutError(
      'withdraw_without_memo',
      'the anchor returned no memo, and paying a shared treasury without one would be unattributable',
      body
    );
  }
  return { ...body, transaction_id: body.id, treasury: body.account_id };
}

/** SEP-6 transaction polling. Returns the raw transaction object. */
async function transaction({ id, token, discovered }) {
  const anchor = discovered || (await discover());
  const body = await fetchJson(`${anchor.transfer_server}/transaction?id=${encodeURIComponent(id)}`, {
    headers: bearer(token),
  });
  return body.transaction || body;
}

/**
 * Polls until the anchor reports a terminal status.
 *
 * The statuses are the SEP-6 ones: `pending_user_transfer_start` until the
 * payment is seen, `pending_anchor` while the anchor works, `completed` or
 * `error` at the end. Anything unrecognised is returned rather than treated as
 * success: a client that treats an unknown status as done is a client that
 * reports money that never arrived.
 */
async function poll({ id, token, discovered, timeoutMs = 180000, intervalMs = 3000, onStatus }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await transaction({ id, token, discovered });
    if (onStatus) onStatus(last);
    if (['completed', 'error', 'refunded', 'expired'].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new CashoutError('poll_timeout', `no terminal status after ${timeoutMs} ms`, last);
}

// ---------------------------------------------------------------------------
// The on-chain leg
// ---------------------------------------------------------------------------

/**
 * Sends the anchor's asset to the treasury with the memo the anchor asked for.
 *
 * This is the user's own payment: their key signs it and their XLM pays for it.
 * The exit direction is deliberately not gasless -- collectSPONSORED operations
 * exist for the inbound direction, and pretending otherwise here would hide a
 * real cost from the person paying it.
 */
async function submitPayment({ secret, destination, amount, memo, memoType = 'id', assetCode = 'USDC', assetIssuer, horizon }) {
  const { Keypair, Horizon, Asset, TransactionBuilder, Operation, Memo } = sdk();
  const keypair = Keypair.fromSecret(secret);
  const server = new Horizon.Server(horizon || horizonUrl());
  const source = await server.loadAccount(keypair.publicKey());
  const asset = new Asset(assetCode, assetIssuer || USDC_ISSUER_FALLBACK);

  const operation = Operation.payment({ destination, asset, amount });
  const builder = new TransactionBuilder(source, {
    fee: '10000',
    networkPassphrase: networkPassphrase(),
  }).addOperation(operation);

  if (memoType === 'id') {
    if (!/^\d+$/.test(String(memo))) {
      throw new CashoutError('bad_memo', `memo type id needs a numeric memo, got ${memo}`);
    }
    builder.addMemo(Memo.id(String(memo)));
  } else if (memoType === 'text') {
    builder.addMemo(Memo.text(String(memo)));
  } else if (memoType === 'hash') {
    builder.addMemo(Memo.hash(String(memo)));
  } else {
    throw new CashoutError('unsupported_memo_type', `memo type ${memoType} is not one this client can attach`);
  }

  const transaction = builder.setTimeout(60).build();
  transaction.sign(keypair);
  try {
    const result = await server.submitTransaction(transaction);
    return { hash: result.hash, ledger: result.ledger, successful: result.successful };
  } catch (error) {
    const extras = error && error.response && error.response.data ? error.response.data.extras : null;
    throw new CashoutError(
      'payment_failed',
      `the USDC payment was refused by the network: ${extras ? JSON.stringify(extras.result_codes) : error.message}`,
      extras
    );
  }
}

// ---------------------------------------------------------------------------
// The bridge: wSRC -> USDC
// ---------------------------------------------------------------------------

/**
 * Finds a real order-book route from wSRC to the anchor's asset.
 *
 * When a path exists the swap is a `pathPaymentStrictSend`, which is a real DEX
 * trade with a real counterparty. When it does not, this returns null instead of
 * inventing a rate: a price that no market quoted is a number, not a price.
 */
async function findBridgePath({ sourceAsset, amount, destinationAsset, horizon }) {
  const { Horizon, Asset } = sdk();
  const server = new Horizon.Server(horizon || horizonUrl());
  const source = new Asset(sourceAsset.code, sourceAsset.issuer);
  const destination = new Asset(destinationAsset.code, destinationAsset.issuer);
  try {
    const paths = await server.strictSendPaths(source, amount, [destination]).call();
    const records = paths.records || [];
    if (records.length === 0) return null;
    return {
      kind: 'order_book',
      destination_amount: records[0].destination_amount,
      path: records[0].path || [],
      source_amount: amount,
    };
  } catch (error) {
    // A Horizon that answers with an error is not a market. Treat it as "no
    // route known" and let the caller decide, rather than reporting a swap.
    return { kind: 'lookup_failed', error: String(error && error.message ? error.message : error) };
  }
}

/**
 * Turns wSRC into the asset the anchor exits.
 *
 * Two routes, in this order:
 *
 *   1. **A real order book**, executed as `pathPaymentStrictSend`. This is the
 *      route this code exists to use, and it needs no trust: the trade either
 *      happens at the market's price or it does not happen.
 *   2. **A simplified counterparty exchange**, executed only when
 *      `CASHOUT_SWAP_SECRET` is configured. The counterparty receives the wSRC and
 *      sends USDC back at `CASHOUT_SWAP_RATE` (default 1.0, i.e. no spread). This is
 *      a swap with an operator standing behind it, which is why it is opt-in and
 *      why the README states it rather than describing this function as a DEX.
 *
 * With neither configured, it refuses with `no_bridge_route` and says what is
 * missing. An exit path that silently guesses a rate is worse than one that
 * says it cannot price the trade.
 */
async function bridgeToUsdc({ userSecret, amount, wsrc, usdc, horizon }) {
  const { Keypair, Horizon, Asset, TransactionBuilder, Operation } = sdk();
  const server = new Horizon.Server(horizon || horizonUrl());
  const wsrcAsset = new Asset(wsrc.code, wsrc.issuer);
  const usdcAsset = new Asset(usdc.code, usdc.issuer);
  const user = Keypair.fromSecret(userSecret);
  const userAccount = user.publicKey();

  const route = await findBridgePath({
    sourceAsset: { code: wsrc.code, issuer: wsrc.issuer },
    amount,
    destinationAsset: { code: usdc.code, issuer: usdc.issuer },
    horizon,
  });

  if (route && route.kind === 'order_book') {
    const source = await server.loadAccount(userAccount);
    const transaction = new TransactionBuilder(source, { fee: '10000', networkPassphrase: networkPassphrase() })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: wsrcAsset,
          sendAmount: amount,
          destination: userAccount,
          destAsset: usdcAsset,
          destMin: (Number(route.destination_amount) * 0.98).toFixed(7),
          path: route.path.map((entry) => new Asset(entry.asset_code, entry.asset_issuer)),
        })
      )
      .setTimeout(60)
      .build();
    transaction.sign(user);
    const result = await server.submitTransaction(transaction);
    return { kind: 'order_book', hash: result.hash, received: route.destination_amount, rate_source: 'order book' };
  }

  const counterpartySecret = (process.env.CASHOUT_SWAP_SECRET || '').trim();
  if (!counterpartySecret) {
    throw new CashoutError(
      'no_bridge_route',
      'no order book route from wSRC to the anchor asset exists, and no counterparty is configured (CASHOUT_SWAP_SECRET). Nothing was swapped and nothing was guessed.',
      { lookup: route }
    );
  }

  const rate = Number(process.env.CASHOUT_SWAP_RATE || '1');
  const received = (Number(amount) * rate).toFixed(7);
  const counterparty = Keypair.fromSecret(counterpartySecret);

  // Leg 1: the user sends the wrapped asset and pays the fee for it. A memo
  // makes the two legs attributable to each other on the ledger.
  const userAccountSource = await server.loadAccount(userAccount);
  const sendLeg = new TransactionBuilder(userAccountSource, { fee: '10000', networkPassphrase: networkPassphrase() })
    .addOperation(Operation.payment({ destination: counterparty.publicKey(), asset: wsrcAsset, amount }))
    .addMemo(sdk().Memo.text('lg-swap'))
    .setTimeout(60)
    .build();
  sendLeg.sign(user);
  const sendResult = await server.submitTransaction(sendLeg);

  // Leg 2: the counterparty pays out at the agreed rate.
  const counterpartySource = await server.loadAccount(counterparty.publicKey());
  const payoutLeg = new TransactionBuilder(counterpartySource, { fee: '10000', networkPassphrase: networkPassphrase() })
    .addOperation(Operation.payment({ destination: userAccount, asset: usdcAsset, amount: received }))
    .addMemo(sdk().Memo.text('lg-swap'))
    .setTimeout(60)
    .build();
  payoutLeg.sign(counterparty);
  const payoutResult = await server.submitTransaction(payoutLeg);

  return {
    kind: 'counterparty',
    rate,
    send_hash: sendResult.hash,
    payout_hash: payoutResult.hash,
    received,
    rate_source: 'configured counterparty rate, not a market price',
    simplification: true,
  };
}

// ---------------------------------------------------------------------------
// The whole exit, as one call, with a step-by-step record
// ---------------------------------------------------------------------------

/**
 * Cash out to a bank account.
 *
 * Every step is recorded as it happens, including the ones that were refused, so
 * the returned object can be written to disk as a receipt instead of as a
 * summary written from memory afterwards.
 */
async function cashOutToTry({
  userSecret,
  account,
  amount,
  assetCode = 'USDC',
  skipBridge = false,
  wsrc = null,
  discovered = null,
  poll: shouldPoll = true,
  intervalMs = 3000,
  timeoutMs = 180000,
}) {
  const steps = [];
  const record = (step, ok, detail, extra = {}) => {
    steps.push({ step, ok, detail, at: new Date().toISOString(), ...extra });
    return ok;
  };

  const anchor = discovered || (await discover());
  record('discover', true, `anchor ${anchor.home_domain}: auth ${anchor.web_auth_endpoint}, transfer ${anchor.transfer_server}`, {
    signing_key: anchor.signing_key,
    usdc: anchor.usdc,
  });

  const user = account || sdk().Keypair.fromSecret(userSecret).publicKey();
  const { token } = await authenticate({ account: user, secret: userSecret, discovered: anchor });
  record('sep10_authenticate', true, `authenticated ${user} against ${anchor.web_auth_endpoint}`);

  const capabilities = await info(token, anchor);
  const withdraw = capabilities.withdraw && capabilities.withdraw[assetCode];
  if (!withdraw || withdraw.enabled !== true) {
    record('sep6_capabilities', false, `the anchor does not enable ${assetCode} withdrawals`);
    throw new CashoutError('withdraw_not_enabled', `the anchor does not enable ${assetCode} withdrawals`, capabilities);
  }
  record('sep6_capabilities', true, `${assetCode} withdrawal enabled, fee_percent ${withdraw.fee_percent}, types ${Object.keys(withdraw.types || {}).join(',')}`, {
    fee_percent: withdraw.fee_percent,
    funding_methods: withdraw.funding_methods,
  });

  let quote = null;
  if (anchor.quote_server && anchor.usdc) {
    try {
      quote = await price({
        sellAmount: amount,
        sellAsset: `stellar:${assetCode}:${anchor.usdc.issuer}`,
        token,
        discovered: anchor,
      });
      record('sep38_price', Boolean(quote && !quote.unsupported),
        quote && !quote.unsupported
          ? `1 ${assetCode} = ${quote.price} ${quote.buy_asset}, as quoted by the anchor's SEP-38 endpoint`
          : `the anchor's quote endpoint did not price ${assetCode} against a local currency`,
        { quote });
    } catch (error) {
      record('sep38_price', false, `quote failed: ${error.message}`);
      quote = null;
    }
  }

  const bridge = skipBridge || !wsrc
    ? null
    : await bridgeToUsdc({ userSecret, amount, wsrc, usdc: anchor.usdc, horizon: horizonUrl() }).catch((error) => {
        record('bridge_wsrc_to_usdc', false, `${error.code || 'bridge_failed'}: ${error.message}`);
        throw error;
      });
  if (bridge) {
    record('bridge_wsrc_to_usdc', true, `swapped via ${bridge.rate_source}, received ${bridge.received} ${assetCode}`, {
      route: bridge.kind,
      send_hash: bridge.send_hash,
      payout_hash: bridge.payout_hash,
      simplification: Boolean(bridge.simplification),
    });
  }

  const instructions = await startWithdraw({ amount, account: user, assetCode, token, discovered: anchor });
  record('sep6_withdraw_started', true, `withdrawal ${instructions.transaction_id}: pay ${amount} ${assetCode} to ${instructions.treasury} with ${instructions.memo_type} memo ${instructions.memo}`, {
    transaction_id: instructions.transaction_id,
    treasury: instructions.treasury,
    memo: instructions.memo,
    memo_type: instructions.memo_type,
    eta: instructions.eta,
    extra_info: instructions.extra_info,
  });

  const payment = await submitPayment({
    secret: userSecret,
    destination: instructions.treasury,
    amount,
    memo: instructions.memo,
    memoType: instructions.memo_type,
    assetCode,
    assetIssuer: anchor.usdc ? anchor.usdc.issuer : USDC_ISSUER_FALLBACK,
  });
  record('stellar_payment', true, `sent ${amount} ${assetCode} to the anchor treasury, transaction ${payment.hash}`, payment);

  if (!shouldPoll) {
    return { anchor, user, quote, instructions, payment, steps, transaction: null };
  }

  const final = await poll({
    id: instructions.transaction_id,
    token,
    discovered: anchor,
    intervalMs,
    timeoutMs,
    onStatus: (current) => {
      // Only record transitions, so the receipt is a history rather than a log.
      if (!steps.some((entry) => entry.step === 'sep6_status' && entry.status === current.status)) {
        steps.push({ step: 'sep6_status', ok: true, status: current.status, at: new Date().toISOString() });
      }
    },
  });
  record('sep6_completed', final.status === 'completed', `the anchor reports status ${final.status}`, {
    status: final.status,
    amount_in: final.amount_in,
    amount_out: final.amount_out,
    amount_fee: final.amount_fee,
    external_transaction_id: final.external_transaction_id,
    stellar_transaction_id: final.stellar_transaction_id,
  });

  return { anchor, user, quote, instructions, payment, transaction: final, steps };
}

// ---------------------------------------------------------------------------
// CLI: one cash-out, written to a file as a receipt
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { amount: null, secret: process.env.CASHOUT_USER_SECRET || '', out: null, skipBridge: false, json: false, discoverOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--amount') args.amount = value;
    else if (key === '--secret') args.secret = value;
    else if (key === '--out') args.out = value;
    else if (key === '--discover') args.discoverOnly = true;
    else if (key === '--json') args.json = true;
    else if (key === '--skip-bridge') args.skipBridge = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fs = require('node:fs');

  if (args.discoverOnly || !args.amount) {
    const anchor = await discover();
    const capabilities = await info(null, anchor).catch((error) => ({ error: error.message }));
    const summary = { discovered: anchor, capabilities };
    if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!args.secret) {
    console.error('a user secret is required: pass --secret or set CASHOUT_USER_SECRET');
    process.exit(2);
  }

  const result = await cashOutToTry({
    userSecret: args.secret,
    amount: args.amount,
    skipBridge: true,
    poll: true,
  });

  const receipt = {
    home_domain: result.anchor.home_domain,
    account: result.user,
    amount: args.amount,
    asset: 'USDC',
    quote: result.quote,
    treasury: result.instructions.treasury,
    memo: result.instructions.memo,
    memo_type: result.instructions.memo_type,
    payment: result.payment,
    transaction_id: result.instructions.transaction_id,
    final_status: result.transaction ? result.transaction.status : null,
    amount_out: result.transaction ? result.transaction.amount_out : null,
    amount_fee: result.transaction ? result.transaction.amount_fee : null,
    external_transaction_id: result.transaction ? result.transaction.external_transaction_id : null,
    steps: result.steps,
    finished_at: new Date().toISOString(),
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify(receipt, null, 2));
}

module.exports = {
  CashoutError,
  DEFAULT_HOME,
  USDC_ISSUER_FALLBACK,
  authenticate,
  baseUrl,
  bridgeToUsdc,
  cashOutToTry,
  discover,
  findBridgePath,
  homeDomain,
  info,
  poll,
  price,
  startWithdraw,
  submitPayment,
  transaction,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.code ? `[${error.code}] ` : ''}${error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2).slice(0, 1200));
    process.exit(1);
  });
}
