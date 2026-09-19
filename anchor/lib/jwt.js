'use strict';

// ---------------------------------------------------------------------------
// Short-lived session tokens for authenticated users.
//
// A SEP-10 challenge proves that a caller controls a Stellar account. What the
// caller then needs is something cheap to present on later requests, so the
// facde issues an HS256 JWT: `sub` is the account, `exp` is short, and nothing
// about the user is stored server-side beyond the session bookkeeping the SEP-6
// records already keep.
//
// Secrets: SEP10_JWT_SECRET if set, otherwise derived from the SEP-10 signing
// secret with a domain-separation label. No secret means no tokens are issued,
// and SEP-10 reports itself as not configured rather than handing out a token
// that nothing can verify.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 900;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function signingSecret() {
  const explicit = (process.env.SEP10_JWT_SECRET || '').trim();
  if (explicit) return explicit;
  const anchorSecret = (process.env.SEP10_SIGNING_SECRET || '').trim();
  if (anchorSecret) {
    return crypto.createHash('sha256').update(`lumen-gate:sep10-jwt:${anchorSecret}`).digest('hex');
  }
  return '';
}

function configured() {
  return signingSecret().length > 0;
}

function ttlSeconds() {
  const raw = Number(process.env.SEP10_JWT_TTL || DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(raw), 86400);
}

function issuer() {
  return (process.env.SEP10_HOME_DOMAIN || '').trim() || 'lumen-gate.local';
}

/** Issues a token. Throws when no secret is configured: a token nobody can verify is worse than none. */
function issue(account, {audience, extraClaims = {}} = {}) {
  const secret = signingSecret();
  if (!secret) throw new Error('no SEP-10 JWT secret configured');
  const now = Math.floor(Date.now() / 1000);
  const ttl = ttlSeconds();
  const payload = {
    iss: issuer(),
    sub: account,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomBytes(12).toString('hex'),
    ...(audience ? {aud: audience} : {}),
    ...extraClaims,
  };
  const header = {alg: 'HS256', typ: 'JWT'};
  const body = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(body).digest();
  return {token: `${body}.${base64url(signature)}`, expires_at: new Date((now + ttl) * 1000).toISOString(), expires_in: ttl, claims: payload};
}

/**
 * Verifies a token.
 *
 * Returns `{ok: true, claims}` or `{ok: false, reason}`. Expiry is enforced
 * here rather than trusted to the client, and the signature is compared in
 * constant time.
 */
function verify(token) {
  const secret = signingSecret();
  if (!secret) return {ok: false, reason: 'not_configured'};
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return {ok: false, reason: 'malformed'};
  const [header, payload, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  let provided;
  try {
    provided = fromBase64url(signature);
  } catch {
    return {ok: false, reason: 'malformed'};
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return {ok: false, reason: 'bad_signature'};
  }
  let claims;
  try {
    claims = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return {ok: false, reason: 'malformed'};
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return {ok: false, reason: 'expired'};
  if (claims.iss !== issuer()) return {ok: false, reason: 'bad_issuer'};
  return {ok: true, claims};
}

/** Reads a bearer token from the Authorization header or X-Lumen-Session. */
function fromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    // Operator tokens are not JWTs; the caller checks theirs separately.
    if (value.split('.').length === 3) return value;
  }
  const sessionHeader = req.headers['x-lumen-session'];
  return sessionHeader ? String(sessionHeader).trim() : '';
}

module.exports = {issue, verify, configured, fromRequest, ttlSeconds, issuer};
