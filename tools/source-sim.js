'use strict';

// A deterministic stand-in for the source chain.
//
// The console has always been able to talk to a source adapter; this repo just
// never shipped one, so SOURCE_URL stayed unset and every write path on Gate
// 1.0 was disabled with "no source adapter is configured". That is honest but
// it means nothing on the inbound lane can be exercised.
//
// This process plays the source side over exactly the surface api/source.js is
// willing to proxy:
//
//   GET  /info                         chain identity and head
//   GET  /blocks/latest                the head block
//   GET  /blocks/:height               one block
//   GET  /events?height=               events in a block
//   GET  /proof?height=&kind=bls       finality evidence for a height
//   POST /lock                         create a lock event, seal a block
//
// Deterministic means: the same inputs produce the same message_id, the same
// payload_hash and the same roots, every run, on every machine. Nothing here
// is random and nothing is persisted, so a restart replays identically from
// the same genesis. The Merkle tree is a real tree — leaves are hashed, pairs
// are hashed, an odd node is promoted — so /proof returns a path that actually
// verifies rather than a placeholder.
//
// What this is NOT: it is not a chain, it has no consensus, and its BLS
// "signatures" are deterministic digests standing in for an aggregate. It
// exists so the console's inbound lane can be driven end to end locally.

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.SIM_PORT || 8080);
const HOST = process.env.SIM_HOST || '0.0.0.0';

// Matches the domain the deployment manifest already records, so the registry
// and the console agree about which source chain this is.
const DOMAIN_NAME = process.env.SIM_DOMAIN_NAME || 'source-testnet';
const DOMAIN_KEY = process.env.SIM_DOMAIN_KEY
  || '4c00370b422dcf0f72234af78a49d2fafa5196c3ee6b19f2b6a8e815f587137e';
const GENESIS_HEIGHT = Number(process.env.SIM_GENESIS_HEIGHT || 306);
const SIGNER_COUNT = 3;
const REQUIRED = 2;

const sha256 = (input) => crypto.createHash('sha256').update(input).digest();
const hex = (buf) => Buffer.from(buf).toString('hex');
const h = (...parts) => hex(sha256(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'))))));

// ---------------------------------------------------------------- Merkle

function merkleRoot(leaves) {
  if (leaves.length === 0) return hex(Buffer.alloc(32));
  let level = leaves.map((l) => Buffer.from(l, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      // An odd node is promoted rather than duplicated: duplicating is the
      // classic second-preimage foot-gun.
      next.push(i + 1 < level.length ? sha256(Buffer.concat([level[i], level[i + 1]])) : level[i]);
    }
    level = next;
  }
  return hex(level[0]);
}

function merklePath(leaves, index) {
  const path = [];
  let level = leaves.map((l) => Buffer.from(l, 'hex'));
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : null;
      if (i === idx || i + 1 === idx) {
        if (right === null) {
          // promoted, nothing to pair with at this level
        } else {
          const isLeft = idx === i;
          path.push({ side: isLeft ? 'right' : 'left', hash: hex(isLeft ? right : left) });
        }
        idx = next.length;
      }
      next.push(right ? sha256(Buffer.concat([left, right])) : left);
    }
    level = next;
  }
  return path;
}

// ---------------------------------------------------------------- state

const blocks = new Map();
let head = GENESIS_HEIGHT;
let nonce = 0;

function sealBlock(height, events) {
  const leaves = events.map((e) => e.leaf);
  const eventRoot = merkleRoot(leaves);
  const parent = blocks.get(height - 1);
  const stateRoot = h('state', DOMAIN_KEY, String(height), eventRoot, parent ? parent.state_root : 'genesis');
  const block = {
    height,
    domain_key: DOMAIN_KEY,
    parent_root: parent ? parent.state_root : hex(Buffer.alloc(32)),
    state_root: stateRoot,
    event_root: eventRoot,
    event_count: events.length,
    events,
    sealed_at: new Date().toISOString(),
  };
  blocks.set(height, block);
  if (height > head) head = height;
  return block;
}

// Genesis so /blocks/latest answers before anything is locked.
sealBlock(GENESIS_HEIGHT, []);

function makeEvent(height, indexInBlock, amount, recipient) {
  const n = nonce++;
  const payloadHash = h('payload', DOMAIN_KEY, String(amount), recipient, String(n));
  const messageId = h('message', DOMAIN_KEY, String(height), String(indexInBlock), payloadHash);
  return {
    message_id: messageId,
    nonce: n,
    height,
    index: indexInBlock,
    amount: String(amount),
    recipient,
    payload_hash: payloadHash,
    expiry_height: height + 720,
    leaf: h('leaf', messageId, payloadHash, String(amount), recipient),
  };
}

// The real system aggregates BLS signatures from the signer set. Here each
// "signature" is a deterministic digest over what the signer is attesting to,
// and the aggregate is the digest of the concatenation. Same shape, same
// sizes, no cryptographic claim.
function finalityFor(block) {
  const sigs = [];
  for (let i = 0; i < SIGNER_COUNT; i += 1) {
    sigs.push(h('sig', String(i), block.state_root, block.event_root, String(block.height)));
  }
  const aggregate = h('agg', ...sigs);
  return {
    declared_height: block.height,
    declared_root: block.state_root,
    payload: {
      kind: 'bls',
      event_root: block.event_root,
      state_root: block.state_root,
      height: block.height,
      signer_count: SIGNER_COUNT,
      required: REQUIRED,
      // 96 bytes is a BLS12-381 G2 aggregate; keep the wire shape honest.
      sig_hex: (aggregate + aggregate + aggregate).slice(0, 192),
      signers: sigs.map((s, i) => ({ index: i, sig_hex: s })),
    },
  };
}

// ---------------------------------------------------------------- server

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/info';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    return res.end();
  }

  if (path === '/info') {
    return json(res, 200, {
      kind: 'deterministic source simulator',
      not_a_chain: 'no consensus, no p2p, no validators; deterministic replay only',
      domain: { name: DOMAIN_NAME, key: DOMAIN_KEY },
      head_height: head,
      genesis_height: GENESIS_HEIGHT,
      blocks: blocks.size,
      bls_policy: { signer_count: SIGNER_COUNT, required: REQUIRED, slashable: false },
    });
  }

  if (path === '/blocks/latest') {
    const b = blocks.get(head);
    return json(res, 200, { ...b, events: b.events.map(({ leaf, ...e }) => e) });
  }

  const blockMatch = /^\/blocks\/(\d+)$/.exec(path);
  if (blockMatch) {
    const b = blocks.get(Number(blockMatch[1]));
    if (!b) return json(res, 404, { error: { code: 'no_block', message: `no block at height ${blockMatch[1]}` } });
    return json(res, 200, { ...b, events: b.events.map(({ leaf, ...e }) => e) });
  }

  if (path === '/events') {
    const height = Number(url.searchParams.get('height') || head);
    const b = blocks.get(height);
    if (!b) return json(res, 404, { error: { code: 'no_block', message: `no block at height ${height}` } });
    return json(res, 200, {
      height,
      event_root: b.event_root,
      events: b.events.map(({ leaf, ...e }) => e),
    });
  }

  if (path === '/proof') {
    const height = Number(url.searchParams.get('height') || head);
    const b = blocks.get(height);
    if (!b) return json(res, 404, { error: { code: 'no_block', message: `no block at height ${height}` } });
    const kind = url.searchParams.get('kind') || 'bls';
    const body = finalityFor(b);
    if (kind === 'merkle') {
      const index = Number(url.searchParams.get('index') || 0);
      const leaves = b.events.map((e) => e.leaf);
      body.merkle = {
        index,
        leaf: leaves[index] || null,
        path: leaves.length ? merklePath(leaves, index) : [],
        root: b.event_root,
      };
    }
    return json(res, 200, body);
  }

  if (path === '/lock') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: { code: 'method_not_allowed', message: 'POST /lock' } });
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { error: { code: 'bad_json', message: 'body must be JSON' } });
    }

    const amount = Number(body.amount);
    const recipient = String(body.recipient || '');
    const count = Math.max(1, Math.min(16, Number(body.count) || 1));

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { error: { code: 'bad_amount', message: 'amount must be a positive number of base units' } });
    }
    if (!/^G[A-Z2-7]{55}$/.test(recipient)) {
      return json(res, 400, { error: { code: 'bad_recipient', message: 'recipient must be a Stellar G... address' } });
    }

    const height = head + 1;
    const events = [];
    for (let i = 0; i < count; i += 1) {
      // The first event carries the amount; the rest are siblings so the proof
      // is a real tree walk instead of the single-leaf case.
      events.push(makeEvent(height, i, i === 0 ? amount : amount + i, recipient));
    }
    const block = sealBlock(height, events);

    return json(res, 200, {
      block_height: block.height,
      state_root: block.state_root,
      event_root: block.event_root,
      event: (({ leaf, ...e }) => e)(events[0]),
      events: events.map(({ leaf, ...e }) => e),
    });
  }

  return json(res, 404, { error: { code: 'not_found', message: `no route for ${path}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`source simulator on http://${HOST}:${PORT}`);
  console.log(`  domain ${DOMAIN_NAME} (${DOMAIN_KEY.slice(0, 16)}...)`);
  console.log(`  genesis height ${GENESIS_HEIGHT}, head ${head}`);
  console.log('  routes: /info, /blocks/latest, /blocks/:height, /events, /proof, POST /lock');
  console.log('  deterministic: same inputs replay to the same ids and roots');
});
