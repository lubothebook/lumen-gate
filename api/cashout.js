'use strict';

// GET  /api/cashout?action=anchor
// GET  /api/cashout?action=bridge&amount=25
// GET  /api/cashout?action=challenge&account=G...
// POST /api/cashout?action=token   { transaction }
// POST /api/cashout?action=start   { amount, account }   (X-Anchor-Token)
// GET  /api/cashout?action=status&id=...                 (X-Anchor-Token)
//
// The cash-out panel talks to this handler instead of to the anchor directly,
// for the same reason the console talks to the source proxy: the browser should
// never have to reach a host the page does not control, and the deployment
// should be able to say honestly that the exit is unavailable rather than fail
// with a cross-origin error in front of a judge.
//
// The anchor's own session token travels in `X-Anchor-Token` and is forwarded
// untouched. This layer holds no token, mints no token and stores nothing: it is
// a proxy for a user's own credential for an external service. The facade's
// operator token is deliberately not accepted here -- an operator is not the
// user.

const { send, sendError, capabilities } = require('./_shared');

const FACADE_URL = (process.env.FACADE_URL || '').trim().replace(/\/+$/, '');
const ANCHOR_ACTIONS = new Set(['anchor', 'bridge', 'challenge', 'token', 'start', 'status']);

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const action = (url.searchParams.get('action') || 'anchor').trim();

  if (!ANCHOR_ACTIONS.has(action)) {
    sendError(res, 400, 'invalid_request', `unknown cash-out action "${action}"`, {
      allowed: [...ANCHOR_ACTIONS],
    });
    return;
  }
  if (!FACADE_URL) {
    sendError(res, 503, 'not_configured', 'this deployment has no FACADE_URL, so the cash-out routes cannot be reached', {
      capabilities: capabilities(),
      fix: 'set FACADE_URL to the anchor facade origin',
    });
    return;
  }

  const isWrite = action === 'token' || action === 'start';
  if (isWrite && req.method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', `cash-out action "${action}" is POST`);
    return;
  }
  if (!isWrite && req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', `cash-out action "${action}" is GET`);
    return;
  }

  // The read actions build their own query string; the write actions carry a
  // JSON body and at most a token header. Nothing else from the request is
  // forwarded, so a caller cannot smuggle a header the facade did not expect.
  let target = `${FACADE_URL}/v1/cashout/${action}`;
  if (action === 'bridge') {
    const amount = String(url.searchParams.get('amount') || '').trim();
    if (amount && /^\d+(\.\d{1,7})?$/.test(amount)) target += `?amount=${encodeURIComponent(amount)}`;
  }
  if (action === 'challenge') {
    const account = String(url.searchParams.get('account') || '').trim();
    if (!/^G[A-Z0-9]{55}$/.test(account)) {
      sendError(res, 400, 'invalid_request', 'action=challenge needs an account', {example: '?action=challenge&account=G...'});
      return;
    }
    target += `?account=${encodeURIComponent(account)}`;
  }
  if (action === 'status') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
      sendError(res, 400, 'invalid_request', 'action=status needs the transaction id the anchor returned');
      return;
    }
    target += `?id=${encodeURIComponent(id)}`;
  }

  const headers = { 'Content-Type': 'application/json' };
  const anchorToken = String(req.headers['x-anchor-token'] || '').trim();
  if (anchorToken) headers['X-Anchor-Token'] = anchorToken;

  let body;
  if (isWrite) {
    // Two hosts, two conventions. Vercel hands the handler an unread stream;
    // tools/api-dev-server.js reads the body itself and leaves it on req.body
    // so several handlers can share one parse. Reading the stream when it has
    // already been drained yields "" - the request arrives at the facade with
    // {} and comes back as "a signed challenge transaction is required", which
    // reads like the caller forgot to sign rather than like the body was lost.
    //
    // So: take the pre-read body when the host supplies one, otherwise read
    // the stream. Both paths end at the same JSON.parse and the same limit.
    const preRead = req.body;
    let raw;
    if (typeof preRead === "string") {
      raw = preRead;
    } else if (preRead && typeof preRead === "object" && !Buffer.isBuffer(preRead)) {
      // Already parsed upstream (some hosts do this when the content type is
      // JSON): take it as-is rather than re-serialising and re-parsing.
      body = preRead;
      raw = null;
    } else if (Buffer.isBuffer(preRead)) {
      raw = preRead.toString("utf8");
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
        if (chunks.reduce((total, part) => total + part.length, 0) > 64 * 1024) {
          sendError(res, 413, 'payload_too_large', 'the request body is larger than this endpoint accepts');
          return;
        }
      }
      raw = Buffer.concat(chunks).toString('utf8');
    }
    if (raw !== null) {
      if (raw.length > 64 * 1024) {
        sendError(res, 413, 'payload_too_large', 'the request body is larger than this endpoint accepts');
        return;
      }
      try {
        body = JSON.parse(raw.trim() || '{}');
      } catch {
        sendError(res, 400, 'invalid_request', 'the request body must be JSON');
        return;
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(target, {
      method: isWrite ? 'POST' : 'GET',
      headers,
      body: isWrite ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // No fallback shape: a body that will not parse is reported as it arrived,
      // read from the start rather than from a truncated copy that hides where
      // the problem is.
      sendError(res, 502, 'upstream_unavailable', 'the facade answered with a body that is not JSON', {
        status: response.status,
        body_head: text.slice(0, 400),
      });
      return;
    }
    if (!response.ok) {
      const envelope = payload && payload.error ? payload.error : {code: 'upstream_error', message: `status ${response.status}`};
      sendError(res, response.status, envelope.code, envelope.message, envelope.details);
      return;
    }
    send(res, 200, payload);
  } catch (error) {
    sendError(res, 502, 'upstream_unavailable', `the anchor facade could not be reached: ${error.message}`, {
      facade_url: FACADE_URL,
      action,
    });
  } finally {
    clearTimeout(timer);
  }
};
