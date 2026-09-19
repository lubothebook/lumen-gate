'use strict';

// ---------------------------------------------------------------------------
// Per-address rate limiting for the public read surface.
//
// The operator token protects writes; nothing protected reads. A public read
// endpoint that can be hammered for free is both an outage risk and a cost
// risk (several of these routes call upstream services). This is a fixed
// window counter, deliberately simple: it is a blast-radius limiter, not a
// billing system.
//
//   RATE_LIMIT_PER_MIN   requests allowed per window per address (default 60)
//   RATE_LIMIT_DISABLED  set to 1 to switch the limiter off (local development)
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;
const buckets = new Map();

function limit() {
  const raw = Number(process.env.RATE_LIMIT_PER_MIN || 60);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.min(Math.floor(raw), 100_000);
}

function disabled() {
  return process.env.RATE_LIMIT_DISABLED === '1';
}

/** The caller's address, preferring the proxy's forwarded header when present. */
function address(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Counts one request.
 *
 * Returns `{allowed, remaining, resetSeconds, limit}`. Expired windows are
 * dropped opportunistically, and the map is swept when it grows past a
 * threshold so a long-lived process cannot be filled up by unique addresses.
 */
function consume(req) {
  const max = limit();
  if (disabled()) {
    return {allowed: true, remaining: max, resetSeconds: 0, limit: max, disabled: true};
  }
  const key = address(req);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = {count: 0, resetAt: now + WINDOW_MS};
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }

  const remaining = Math.max(0, max - bucket.count);
  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return {allowed: bucket.count <= max, remaining, resetSeconds, limit: max, disabled: false};
}

function headers(result) {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetSeconds),
    ...(result.allowed ? {} : {'Retry-After': String(result.resetSeconds)}),
  };
}

/** Test seam: forget every bucket. */
function reset() {
  buckets.clear();
}

module.exports = { consume, headers, reset, address };
