'use strict';

// POST /api/relay?height=N
//
// Forwards one relayer pass to a configured operator facade. The signing key
// lives there, never here: a hosted console must not hold the ability to spend
// an operator's XLM, and a deployment that does not configure an operator gets
// a clear refusal instead of a button that quietly does nothing.

const { send, operatorAuthorized, capabilities, sendError} = require('./_shared');

const OPERATOR_URL = (process.env.OPERATOR_URL || '').trim().replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || 60000);

function parseHeight(value) {
  if (value === null || value === undefined || value === '') return { ok: true, height: null };
  if (!/^\d{1,9}$/.test(String(value))) return { ok: false };
  const height = Number(value);
  return height >= 1 ? { ok: true, height } : { ok: false };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', 'this endpoint is POST only');
    return;
  }

  const auth = operatorAuthorized(req);
  if (!auth.ok) {
    sendError(
      res,
      auth.reason === 'writes_disabled' ? 503 : 401,
      auth.reason,
      auth.reason === 'writes_disabled'
        ? 'no OPERATOR_TOKEN is configured, so this deployment refuses every mutating request'
        : 'a valid operator token is required',
      { capabilities: capabilities() }
    );
    return;
  }

  if (!OPERATOR_URL) {
    sendError(
      res,
      503,
      'no_operator_configured',
      'the hosted console has no OPERATOR_URL pointing at a running anchor facade, so it cannot relay',
      { fix: 'run the anchor facade and set OPERATOR_URL plus OPERATOR_TOKEN in the deployment environment' }
    );
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parsed = parseHeight(url.searchParams.get('height'));
  if (!parsed.ok) {
    sendError(res, 400, 'invalid_height', 'height must be a positive integer');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      `${OPERATOR_URL}/relay${parsed.height ? `?height=${parsed.height}` : ''}`,
      {
        method: 'POST',
        headers: {
          Authorization: req.headers.authorization || '',
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      }
    );
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    send(res, response.status, body);
  } catch (error) {
    sendError(res, 504, 'operator_unreachable', 'the anchor facade did not answer', {
      upstream: String(error && error.message ? error.message : error),
    });
  } finally {
    clearTimeout(timer);
  }
};
