'use strict';

// Local stand-in for the Vercel function runtime.
//
// It serves the same handlers from api/ on one port, so `npm run dev` in the
// frontend can exercise the exact code that will be deployed. A function that
// only ever runs in production is untested code.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.API_PORT || 3001);
const API_DIR = path.join(__dirname, '..', 'api');

const ROUTES = {
  '/api/status': 'status.js',
  '/api/audit': 'audit.js',
  '/api/finality': 'finality.js',
  '/api/source': 'source.js',
  '/api/relay': 'relay.js',
  // The cash-out panel posts here as well; the route used to be missing from
  // this stand-in while the deployed function list had it, so every cash-out
  // button died with a 404 in development and worked in production.
  '/api/cashout': 'cashout.js',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const file = ROUTES[url.pathname];
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', routes: Object.keys(ROUTES) }));
    return;
  }
  if (req.method === 'POST') req.body = await readBody(req);
  req.url = `${url.pathname}${url.search}`;
  try {
    const handler = require(path.join(API_DIR, file));
    await handler(req, res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'handler_crashed', detail: String(error && error.stack ? error.stack : error) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`api dev server on http://0.0.0.0:${PORT}`);
  console.log(`  routes: ${Object.keys(ROUTES).join(', ')}`);
  console.log(`  SOURCE_URL: ${process.env.SOURCE_URL || '(unset: the source adapter will report itself as absent)'}`);
  if (!process.env.OPERATOR_TOKEN) console.log('  OPERATOR_TOKEN: unset, so every write is refused');
});
