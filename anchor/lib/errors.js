'use strict';

// ---------------------------------------------------------------------------
// One error shape for every endpoint.
//
// A client that integrates with this facade should never have to guess how a
// failure is reported. Every non-200 answer from every route is:
//
//   { "error": { "code": "invalid_account", "message": "...", "details": {...} } }
//
// `code` is stable and machine-readable, `message` is for a human, and
// `details` carries structured context when the failure has some. The old
// unversioned surface returned a bare string in `error`; that shape is gone,
// because two shapes for the same concept is how integration bugs and quiet
// mis-parsing happen.
// ---------------------------------------------------------------------------

const CODES = {
  not_found: 'the requested resource does not exist',
  method_not_allowed: 'this route does not accept that HTTP method',
  invalid_request: 'the request is missing a required parameter or has a bad value',
  invalid_account: 'account must be a Stellar account id (G...) or muxed account (M...)',
  invalid_asset: 'asset_code is not issued by this deployment',
  invalid_amount: 'amount must be a positive decimal with at most 7 decimal places',
  invalid_transaction: 'transaction must be a base64-encoded signed challenge transaction',
  invalid_id: 'id must be a 32-byte hash in lower-case hex',
  rate_limited: 'too many requests from this address',
  unauthorized: 'authentication is required for this endpoint',
  not_implemented: 'this capability is not implemented by this deployment',
  not_configured: 'this capability is configured off on this deployment',
  upstream_unavailable: 'an upstream service did not answer',
  internal_error: 'the facade failed while handling the request',
  writes_disabled: 'no operator token is configured, so mutating routes refuse every request',
  relay_disabled: 'the relayer trigger is opt-in and is switched off',
  relay_busy: 'a relayer pass is already running',
  relay_cooldown: 'a relayer pass finished recently; wait for the cooldown',
};

function errorBody(code, message, details) {
  const body = { error: { code } };
  body.error.message = message || CODES[code] || code;
  if (details && Object.keys(details).length > 0) body.error.details = details;
  return body;
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, code, message, details, extraHeaders = {}) {
  sendJson(res, status, errorBody(code, message, details), extraHeaders);
}

module.exports = { CODES, errorBody, sendJson, sendError };
