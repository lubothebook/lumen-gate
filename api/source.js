'use strict';

// GET  /api/source?path=/info
// POST /api/source?path=/lock
//
// If SOURCE_URL is set, this proxies to the Rust source_simulator. If it is
// not, an in-process simulator (api/_sim.js) handles lock / proof / info so
// the 1.0 console's last pass can run without a second binary.

const { send, sendError, operatorAuthorized, capabilities } = require('./_shared');
const sim = require('./_sim');

const SOURCE_URL = (process.env.SOURCE_URL || '').trim().replace(/\/+$/, '');
const READ_PATHS = [/^\/info$/, /^\/blocks(\/[\w-]+)?$/, /^\/events(\?.*)?$/, /^\/proof(\?.*)?$/];

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(String(req.body || '{}'));
  } catch {
    return {};
  }
}

function handleEmbedded(req, res, path) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (path === '/info' && req.method === 'GET') {
    send(res, 200, sim.info());
    return;
  }
  if (path === '/lock') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method_not_allowed', 'creating a lock is POST /api/source?path=/lock');
      return;
    }
    const body = parseBody(req);
    const result = sim.lock(body);
    if (!result.ok) {
      sendError(res, result.status, 'lock_refused', result.error);
      return;
    }
    send(res, 200, result.body);
    return;
  }
  if (path.startsWith('/proof') && req.method === 'GET') {
    const height = Number(url.searchParams.get('height') || (path.split('height=')[1] || '').split('&')[0]);
    const q = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : url.search.slice(1));
    const h = Number(q.get('height') || height);
    const result = sim.proof(h, q.get('kind'), q.get('message_id'));
    if (!result.ok) {
      sendError(res, result.status, 'proof_unavailable', result.error);
      return;
    }
    send(res, 200, result.body);
    return;
  }
  if (path.startsWith('/events') && req.method === 'GET') {
    const q = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : url.search.slice(1));
    const h = q.get('height') ? Number(q.get('height')) : null;
    send(res, 200, sim.eventsAt(h));
    return;
  }
  if (path === '/blocks/latest' && req.method === 'GET') {
    send(res, 200, sim.latest());
    return;
  }
  sendError(res, 403, 'path_not_allowed', 'that path is not one this proxy forwards', {
    allowed: ['/info', '/blocks/latest', '/events', '/proof', '/lock (POST)'],
  });
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // A POST with no path is a lock. GET with no path is /info. The console
  // always sends ?path=…; this default is for a curl that forgets it.
  const path = url.searchParams.get('path') || (req.method === 'POST' ? '/lock' : '/info');

  if (!SOURCE_URL) {
    handleEmbedded(req, res, path);
    return;
  }

  const isRead = READ_PATHS.some((pattern) => pattern.test(path));
  const isLock = path === '/lock';

  if (!isRead && !isLock) {
    sendError(res, 403, 'path_not_allowed', 'that path is not one this proxy forwards', {
      allowed: ['/info', '/blocks/latest', '/blocks/:height', '/events', '/proof', '/lock (POST)'],
    });
    return;
  }

  if (isLock) {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method_not_allowed', 'creating a lock is POST /api/source?path=/lock');
      return;
    }
    const auth = operatorAuthorized(req);
    if (!auth.ok) {
      sendError(res, auth.reason === 'writes_disabled' ? 503 : 401, auth.reason);
      return;
    }
  } else if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'source reads are GET');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${SOURCE_URL}${path}`, {
      method: isLock ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: isLock ? req.body || '{}' : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    send(res, response.status, body);
  } catch (error) {
    sendError(res, 504, 'source_unreachable', 'the source adapter did not answer', {
      upstream: String(error && error.message ? error.message : error),
    });
  } finally {
    clearTimeout(timer);
  }
};
