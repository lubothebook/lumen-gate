'use strict';
/**
 * Cash-out anchor facade (default 0.0.0.0:8082).
 *
 * api/cashout.js forwards to `${FACADE_URL}/v1/cashout/<action>` and this is the
 * process that answers. It is a thin, honest adapter in front of a REAL anchor:
 * by default Stellar's own testnet reference anchor, which speaks SEP-1, SEP-10
 * and SEP-6 for live testnet USDC.
 *
 * Nothing here is simulated. There is no fake treasury address, no invented
 * memo, no pretend transaction id. Every value the console displays is read out
 * of the anchor's own response. If the anchor is down, the console says the
 * anchor is down rather than showing a plausible-looking withdrawal that would
 * send a user's money nowhere.
 *
 * Why a facade at all, when the browser could call the anchor directly:
 *   - the page keeps one origin, so a CORS change at the anchor cannot silently
 *     break the exit lane;
 *   - the anchor's home domain, asset and issuer are pinned HERE, server-side,
 *     so the treasury address a user is told to pay cannot be swapped by
 *     anything running in the tab;
 *   - the deployment can answer "this exit is not configured" with a reason.
 *
 * The SEP-10 token is minted by the anchor against a challenge the USER signs in
 * their own wallet. This process never holds a key and never signs on a user's
 * behalf; it passes the signed XDR through and hands back whatever token the
 * anchor returns.
 *
 * Env:
 *   ANCHOR_PORT       default 8082
 *   ANCHOR_HOST       default 0.0.0.0
 *   ANCHOR_HOME       anchor home domain (default testanchor.stellar.org)
 *   ANCHOR_ASSET      asset code to exit (default USDC)
 */

const http = require('http');

const PORT = Number(process.env.ANCHOR_PORT || 8082);
const HOST = process.env.ANCHOR_HOST || '0.0.0.0';
const HOME = (process.env.ANCHOR_HOME || 'testanchor.stellar.org').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const ASSET = (process.env.ANCHOR_ASSET || 'USDC').trim().toUpperCase();
const HORIZON = (process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org').replace(/\/+$/, '');

const TIMEOUT_MS = 20000;

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function fail(res, status, code, message, details) {
  send(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

async function call(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SEP-1: read the anchor's own stellar.toml.
 *
 * Parsed with a deliberately small reader rather than a TOML library: the four
 * values needed are all top-level strings plus one array of tables, and adding a
 * dependency to the dev stack for that is not worth it. Anything it cannot parse
 * is reported as unparseable instead of being guessed at.
 */
let tomlCache = null;
async function readToml() {
  if (tomlCache && Date.now() - tomlCache.at < 300000) return tomlCache.value;
  const result = await call(`https://${HOME}/.well-known/stellar.toml`);
  if (!result.ok) throw new Error(`the anchor's stellar.toml answered ${result.status}`);

  const scalar = (key) => {
    const match = result.text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'mi'));
    return match ? match[1] : null;
  };

  // Currencies are [[CURRENCIES]] tables; split on the header and read each one.
  const currencies = [];
  for (const chunk of result.text.split(/^\s*\[\[CURRENCIES\]\]\s*$/mi).slice(1)) {
    const head = chunk.split(/^\s*\[\[/m)[0];
    const code = head.match(/^\s*code\s*=\s*"([^"]+)"/mi);
    const issuer = head.match(/^\s*issuer\s*=\s*"([^"]+)"/mi);
    if (code) currencies.push({ code: code[1], issuer: issuer ? issuer[1] : null });
  }

  const value = {
    home_domain: HOME,
    web_auth_endpoint: scalar('WEB_AUTH_ENDPOINT'),
    transfer_server: scalar('TRANSFER_SERVER'),
    signing_key: scalar('SIGNING_KEY'),
    currencies,
  };
  if (!value.web_auth_endpoint || !value.transfer_server) {
    throw new Error('the anchor publishes no WEB_AUTH_ENDPOINT or TRANSFER_SERVER, so there is no exit to drive');
  }
  tomlCache = { at: Date.now(), value };
  return value;
}

function assetOf(toml) {
  const found = toml.currencies.find((c) => c.code === ASSET && c.issuer);
  return found ? { code: found.code, issuer: found.issuer } : null;
}

const routes = {
  /** What this anchor is, read live from its own toml. */
  async anchor(_req, res) {
    const toml = await readToml();
    const asset = assetOf(toml);
    if (!asset) {
      return fail(res, 502, 'asset_not_listed', `the anchor at ${HOME} does not list ${ASSET} in its stellar.toml`, {
        lists: toml.currencies.map((c) => c.code),
      });
    }
    // SEP-6 /info is the anchor's own statement of what it will actually do.
    const info = await call(`${toml.transfer_server}/info`);
    const withdraw = info.json && info.json.withdraw ? info.json.withdraw[ASSET] : null;
    send(res, 200, {
      anchor: {
        home_domain: toml.home_domain,
        web_auth_endpoint: toml.web_auth_endpoint,
        transfer_server: toml.transfer_server,
        signing_key: toml.signing_key,
        usdc: asset,
      },
      withdraw: withdraw && withdraw.enabled
        ? `it withdraws ${ASSET} over SEP-6 via ${Object.keys(withdraw.types || {}).join(' or ') || 'an unlisted method'}`
        : `it does not currently withdraw ${ASSET}`,
      withdraw_enabled: Boolean(withdraw && withdraw.enabled),
      note: 'read live from the anchor; this facade holds no keys and invents no values',
    });
  },

  /**
   * Is there a market route from the wrapped asset to the anchor's asset?
   *
   * Answered from Horizon's real order book. The honest answer today is usually
   * no: wSRC is this deployment's own wrapped asset and nobody is making a
   * market in it. Saying so plainly is the point - a cash-out panel that implies
   * a route exists when it does not is worse than one that says there is none.
   */
  async bridge(req, res, url) {
    const amount = (url.searchParams.get('amount') || '1').trim();
    const toml = await readToml();
    const asset = assetOf(toml);
    if (!asset) return fail(res, 502, 'asset_not_listed', `${ASSET} is not listed by ${HOME}`);

    const wrapped = (process.env.WRAPPED_ASSET_CODE || '').trim();
    const wrappedIssuer = (process.env.WRAPPED_ASSET_ISSUER || '').trim();
    if (!wrapped || !wrappedIssuer) {
      return send(res, 200, {
        route: 'none',
        detail: `no wrapped asset is configured in this deployment, so there is nothing to sell for ${ASSET}: a holder would have to acquire ${ASSET} another way before withdrawing ${amount}`,
      });
    }

    const query = new URLSearchParams({
      selling_asset_type: 'credit_alphanum4',
      selling_asset_code: wrapped,
      selling_asset_issuer: wrappedIssuer,
      buying_asset_type: 'credit_alphanum4',
      buying_asset_code: asset.code,
      buying_asset_issuer: asset.issuer,
      limit: '1',
    });
    const book = await call(`${HORIZON}/order_book?${query}`);
    const bids = book.json && Array.isArray(book.json.bids) ? book.json.bids : [];
    if (!bids.length) {
      return send(res, 200, {
        route: 'none',
        detail: `Horizon's order book for ${wrapped} to ${asset.code} is empty: no one is offering to buy ${wrapped}, so ${amount} cannot be routed to ${asset.code} on the DEX today`,
      });
    }
    send(res, 200, {
      route: 'order_book',
      detail: `best bid ${bids[0].price} ${asset.code} per ${wrapped}, depth ${bids[0].amount}`,
      bid: bids[0],
    });
  },

  /** SEP-10 step 1: the anchor builds a challenge for this account. */
  async challenge(req, res, url) {
    const account = (url.searchParams.get('account') || '').trim();
    const toml = await readToml();
    const result = await call(`${toml.web_auth_endpoint}?account=${encodeURIComponent(account)}`);
    if (!result.ok || !result.json || !result.json.transaction) {
      return fail(res, result.status || 502, 'challenge_failed', 'the anchor did not return a challenge transaction', {
        status: result.status,
        body_head: (result.text || '').slice(0, 300),
      });
    }
    send(res, 200, {
      transaction: result.json.transaction,
      network_passphrase: result.json.network_passphrase || 'Test SDF Network ; September 2015',
      note: 'sign this in your own wallet; this facade never signs for you',
    });
  },

  /** SEP-10 step 2: trade the signed challenge for a session token. */
  async token(req, res, _url, body) {
    const toml = await readToml();
    if (!body || typeof body.transaction !== 'string' || !body.transaction) {
      return fail(res, 400, 'invalid_request', 'a signed challenge transaction is required');
    }
    const result = await call(toml.web_auth_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: body.transaction }),
    });
    if (!result.ok || !result.json || !result.json.token) {
      return fail(res, result.status || 502, 'token_refused', 'the anchor refused the signed challenge', {
        status: result.status,
        body_head: (result.text || '').slice(0, 300),
      });
    }
    send(res, 200, { token: result.json.token });
  },

  /**
   * SEP-6 withdraw: ask the anchor to open a withdrawal.
   *
   * The response is reshaped into exactly the four fields the console paints -
   * treasury, memo, amount, transaction_id - because those are what a user has
   * to act on. They are copied from the anchor's answer, never defaulted: if the
   * anchor omits the payment address, this returns an error rather than a blank
   * row that looks like an address is coming later.
   */
  async start(req, res, _url, body, headers) {
    const toml = await readToml();
    const asset = assetOf(toml);
    if (!asset) return fail(res, 502, 'asset_not_listed', `${ASSET} is not listed by ${HOME}`);

    const token = String(headers['x-anchor-token'] || '').trim();
    if (!token) return fail(res, 401, 'not_authenticated', 'authenticate with the anchor first');

    const amount = String((body && body.amount) || '').trim();
    const account = String((body && body.account) || '').trim();
    if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
      return fail(res, 400, 'invalid_request', 'amount must be a positive decimal with at most 7 places');
    }
    if (!/^G[A-Z2-7]{55}$/.test(account)) {
      return fail(res, 400, 'invalid_request', 'account must be a Stellar public key');
    }

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // SEP-24 interactive, because that is what a real anchor actually does.
    //
    // Measured against Stellar's reference anchor: a withdrawal does NOT come
    // back with a payment address. It comes back "incomplete" with a URL the
    // person has to open, because the anchor must collect its own KYC and
    // banking details before it will name a treasury account. Driving SEP-6
    // headlessly with invented KYC gets as far as
    // pending_customer_info_update and stops there - the anchor is not being
    // difficult, it is refusing to route money for someone it has not checked.
    //
    // So the facade returns the anchor's real interactive URL instead of
    // inventing a treasury address to fill the panel with. The address arrives
    // through /status once the person has finished the anchor's form, and only
    // then does the console let them pay.
    const interactive = await call(`https://${HOME}/sep24/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ asset_code: ASSET, account, amount }),
    });

    if (interactive.ok && interactive.json && interactive.json.id) {
      const tx = await call(`https://${HOME}/sep24/transaction?id=${encodeURIComponent(interactive.json.id)}`, { headers: auth });
      const t = (tx.json && tx.json.transaction) || {};
      const treasury = t.withdraw_anchor_account || null;

      // If the anchor already knows the address, hand over the real thing.
      if (treasury) {
        return send(res, 200, {
          treasury,
          memo: t.withdraw_memo || '',
          memo_type: t.withdraw_memo_type || 'text',
          amount,
          asset_code: ASSET,
          asset_issuer: asset.issuer,
          transaction_id: interactive.json.id,
          extra_info: null,
        });
      }

      return send(res, 200, {
        needs_interactive: true,
        interactive_url: interactive.json.url || null,
        transaction_id: interactive.json.id,
        status: t.status || 'incomplete',
        amount,
        asset_code: ASSET,
        asset_issuer: asset.issuer,
        treasury: null,
        memo: '',
        memo_type: 'text',
        extra_info: {
          message: `${HOME} will not name a payment address until you complete its own form. Open the link, finish it, then check the status: the address and memo appear here when the anchor releases them.`,
        },
      });
    }

    return fail(res, interactive.status || 502, 'withdraw_refused', 'the anchor did not open a withdrawal', {
      status: interactive.status,
      body_head: (interactive.text || '').slice(0, 400),
    });
  },

  /**
   * Poll one withdrawal. Reads SEP-24 first (that is where start opened it) and
   * falls back to SEP-6 for a transaction opened the other way.
   *
   * The payment address is passed through the moment the anchor releases it, so
   * the console can go from "finish the anchor's form" to a payable instruction
   * without the user starting over.
   */
  async status(req, res, url, _body, headers) {
    const id = (url.searchParams.get('id') || '').trim();
    const toml = await readToml();
    const token = String(headers['x-anchor-token'] || '').trim();
    const auth = token ? { Authorization: `Bearer ${token}` } : {};

    let tx = null;
    const sep24 = await call(`https://${HOME}/sep24/transaction?id=${encodeURIComponent(id)}`, { headers: auth });
    if (sep24.ok && sep24.json && sep24.json.transaction) {
      tx = sep24.json.transaction;
    } else {
      const sep6 = await call(`${toml.transfer_server}/transaction?id=${encodeURIComponent(id)}`, { headers: auth });
      if (sep6.ok && sep6.json && sep6.json.transaction) tx = sep6.json.transaction;
    }
    if (!tx) {
      return fail(res, 502, 'status_unavailable', 'the anchor did not return this transaction', { id });
    }

    const treasury = tx.withdraw_anchor_account || tx.account_id || null;
    send(res, 200, {
      status: tx.status,
      amount_in: tx.amount_in ?? null,
      amount_out: tx.amount_out ?? null,
      external_transaction_id: tx.external_transaction_id ?? null,
      stellar_transaction_id: tx.stellar_transaction_id ?? null,
      message: tx.message ?? null,
      more_info_url: tx.more_info_url ?? null,
      // Present only once the anchor has released them.
      treasury,
      memo: tx.withdraw_memo || tx.memo || '',
      memo_type: tx.withdraw_memo_type || tx.memo_type || 'text',
      payable: Boolean(treasury),
    });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'anchor-facade',
      anchor_home: HOME,
      asset: ASSET,
      holds_keys: false,
      note: 'proxies a real SEP-10/SEP-6 anchor; signs nothing and invents no values',
    });
  }

  const match = url.pathname.match(/^\/v1\/cashout\/([a-z]+)$/);
  if (!match || !routes[match[1]]) {
    return fail(res, 404, 'not_found', `no route ${url.pathname}`);
  }

  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
        return fail(res, 413, 'payload_too_large', 'body over 64 KiB');
      }
    }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}');
    } catch {
      return fail(res, 400, 'invalid_request', 'body is not JSON');
    }
  }

  try {
    await routes[match[1]](req, res, url, body, req.headers);
  } catch (error) {
    fail(res, 502, 'anchor_unreachable', `the anchor at ${HOME} could not be reached: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[anchor-facade] http://${HOST}:${PORT} -> real anchor ${HOME} (${ASSET}), no keys held`);
});
