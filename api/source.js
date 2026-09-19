'use strict';

// GET  /api/source?path=/info
// POST /api/source?path=/lock
//
// The source side of this deployment is a deterministic simulator that plays a
// source chain. It is reached through this one proxy so that the browser never
// talks to a host it does not control, and so the console can say honestly
// whether a source adapter exists at all instead of failing with a network
// error in front of a judge.

const { send, sendError, operatorAuthorized, capabilities } = require('./_shared');

const SOURCE_URL = (process.env.SOURCE_URL || '').trim().replace(/\/+$/, '');
const READ_PATHS = [/^\/info$/, /^\/blocks(\/[\w-]+)?$/, /^\/events(\?.*)?$/, /^\/proof(\?.*)?$/];

module.exports = async function handler(req, res) {
  if (!SOURCE_URL) {
    sendError(res, 503, 'no_source_adapter', 'this deployment has no SOURCE_URL configured, so there is no source chain to talk to', {
      capabilities: capabilities(),
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.searchParams.get('path') || '/info';
  const isRead = READ_PATHS.some((pattern) => pattern.test(path));
  const isLock = path === '/lock';

  if (!isRead && !isLock) {
    sendError(res, 403, 'path_not_allowed', 'that path is not one this proxy forwards', {
      allowed: ['/info', '/blocks/latest', '/blocks/:height', '/events', '/proof', '/lock (POST)'],
    });
    return;
  }

  // Reading the source chain is public. Creating a lock on it is an operator
  // action, because it is the first step of a value transfer that the relayer
  // will then pay to settle.
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
