'use strict';

// Shared helpers for the serverless surface.
//
// Everything here is deliberately dependency-light: the API layer is a thin,
// readable window onto the same facts the repository records, not a second
// implementation of the system. If a value here disagrees with
// deployments/testnet.json, the manifest is right and this file is wrong.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_PATHS = [
  path.join(__dirname, '..', 'deployments', 'testnet.json'),
  path.join(process.cwd(), 'deployments', 'testnet.json'),
];

function loadManifest() {
  for (const candidate of MANIFEST_PATHS) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function contractId(manifest, name) {
  const entry = manifest && manifest.contracts && manifest.contracts[name];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.contract_id || null;
}

function loadAuditRecord() {
  for (const candidate of [
    path.join(__dirname, '..', 'deployments', 'self-audit.json'),
    path.join(process.cwd(), 'deployments', 'self-audit.json'),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/**
 * The one failure shape every function in this layer answers with.
 *
 * It is the same envelope the anchor facade uses:
 * {"error": {"code": ..., "message": ..., "details": ...}}. A console that has
 * to parse two different error shapes is a console that will one day show
 * "[object Object]" to an operator who needs to know what went wrong.
 */
function sendError(res, status, code, message, details, options = {}) {
  const body = { error: { code } };
  if (message) body.error.message = message;
  if (details && Object.keys(details).length > 0) body.error.details = details;
  send(res, status, body, options);
}

function send(res, status, body, { cacheSeconds = 0 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` : 'no-store, max-age=0'
  );
  res.statusCode = status;
  res.end(JSON.stringify(body, null, 2));
}

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: { code: 'upstream_unreachable', message: String(error && error.message ? error.message : error) } },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Constant-time operator token comparison. No token configured means no writes. */
function operatorAuthorized(req) {
  const expected = (process.env.OPERATOR_TOKEN || '').trim();
  if (!expected) return { ok: false, reason: 'writes_disabled' };
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || provided.length !== expected.length) return { ok: false, reason: 'unauthorized' };
  const equal = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  return equal ? { ok: true } : { ok: false, reason: 'unauthorized' };
}

function capabilities() {
  const operatorUrl = (process.env.OPERATOR_URL || '').trim();
  return {
    reads: true,
    finality_reads: true,
    operator_relay: {
      enabled: Boolean(operatorUrl) && Boolean((process.env.OPERATOR_TOKEN || '').trim()),
      requires: 'OPERATOR_URL (a running anchor facade) and OPERATOR_TOKEN',
      note: 'the relayer signs and spends fees, so the hosted console only forwards when an operator has configured both values',
    },
    source_chain: {
      configured: Boolean((process.env.SOURCE_URL || '').trim()),
      note: 'the source side of this deployment is a deterministic simulator; when SOURCE_URL is unset the console says so instead of pretending',
    },
  };
}

module.exports = {
  loadManifest,
  loadAuditRecord,
  contractId,
  send,
  sendError,
  fetchJson,
  operatorAuthorized,
  capabilities,
};
