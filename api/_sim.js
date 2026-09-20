'use strict';

// In-process source-chain simulator so the 1.0 console can Lock without a
// separate Rust process. Layout matches crates/source_simulator (sha256
// message id, binary Merkle tree). BLS aggregate signatures are NOT produced
// here — the proof endpoint returns the block roots and says so.

const crypto = require('crypto');

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function i128le(n) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16xmodem(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function isStellarAccount(value) {
  if (typeof value !== 'string' || value.length !== 56 || value[0] !== 'G') return false;
  let acc = 0;
  let bits = 0;
  const decoded = [];
  for (const ch of value) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return false;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((acc >> bits) & 0xff);
    }
  }
  if (decoded.length < 35) return false;
  const payload = Buffer.from(decoded.slice(0, 33));
  const checksum = decoded[33] | (decoded[34] << 8);
  return crc16xmodem(payload) === checksum;
}

const adapterId = sha256(Buffer.from('source-chain-bls-v1'));
const sourceDomain = sha256(Buffer.concat([adapterId, Buffer.from('source-testnet')]));
const targetDomain = sha256(Buffer.from('lumen-gate-stellar-testnet'));

function leafHash(event) {
  return sha256(Buffer.from(event.message_id, 'hex'), Buffer.from(event.payload_hash, 'hex'));
}

function merkleRoot(leaves) {
  if (!leaves.length) return Buffer.alloc(32);
  let level = leaves.map((l) => Buffer.from(l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      // Odd node is promoted, not duplicated (duplicating is a second-preimage foot-gun).
      next.push(i + 1 < level.length ? sha256(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function merkleProof(leaves, idx) {
  const proof = [];
  let level = leaves.map((l) => Buffer.from(l));
  let i = idx;
  while (level.length > 1) {
    if (i % 2 === 0 && i + 1 < level.length) proof.push(level[i + 1].toString('hex'));
    else if (i % 2 === 1) proof.push(level[i - 1].toString('hex'));
    const next = [];
    for (let k = 0; k < level.length; k += 2) {
      next.push(k + 1 < level.length ? sha256(level[k], level[k + 1]) : level[k]);
    }
    i = Math.floor(i / 2);
    level = next;
  }
  return proof;
}

function makeState(assetId) {
  const genesis = Buffer.alloc(32).toString('hex');
  return {
    assetId,
    latestHeight: 0,
    eventNonce: 0,
    blocks: {
      0: { height: 0, state_root: genesis, event_root: genesis, timestamp_ms: Date.now(), tx_count: 0 },
    },
    events: {},
  };
}

const state = makeState(process.env.SOURCE_ASSET_ID || 'wSRC');

function produceBlock() {
  const prev = state.blocks[state.latestHeight];
  const height = state.latestHeight + 1;
  const stateRoot = sha256(Buffer.from(prev.state_root, 'hex'), u64le(height)).toString('hex');
  const list = state.events[height] || [];
  const eventRoot = merkleRoot(list.map(leafHash)).toString('hex');
  state.blocks[height] = {
    height,
    state_root: stateRoot,
    event_root: eventRoot,
    timestamp_ms: Date.now(),
    tx_count: list.length,
  };
  state.latestHeight = height;
  return state.blocks[height];
}

function addLockEvent(amount, recipient, sender) {
  const nonce = state.eventNonce;
  state.eventNonce += 1;
  const height = state.latestHeight + 1;
  const eventIndex = (state.events[height] || []).length;
  const expiryHeight = height + 100;
  const payloadHash = sha256(Buffer.from(state.assetId), i128le(amount), Buffer.from(recipient));
  const messageId = sha256(
    sourceDomain,
    targetDomain,
    u64le(height),
    u32le(eventIndex),
    u64le(nonce),
    payloadHash,
    u64le(expiryHeight),
    Buffer.from([1]),
    Buffer.from(sender),
    Buffer.from(recipient)
  );
  const event = {
    message_id: messageId.toString('hex'),
    payload_hash: payloadHash.toString('hex'),
    amount,
    recipient_on_source: recipient,
    sender_on_source: sender,
    height,
    event_index: eventIndex,
    nonce,
    expiry_height: expiryHeight,
  };
  if (!state.events[height]) state.events[height] = [];
  state.events[height].push(event);
  return event;
}

function lock({ amount, recipient, sender, count }) {
  if (!isStellarAccount(recipient)) {
    return { ok: false, status: 400, error: `recipient ${recipient} is not a Stellar account strkey` };
  }
  const from = sender || recipient;
  if (!isStellarAccount(from)) {
    return { ok: false, status: 400, error: `sender ${from} is not a Stellar account strkey` };
  }
  const n = Math.max(1, Math.min(64, Number(count) || 1));
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, status: 400, error: 'amount must be a positive integer of base units' };
  }
  const events = [];
  for (let i = 0; i < n; i += 1) events.push(addLockEvent(amt + i, recipient, from));
  const block = produceBlock();
  return { ok: true, status: 200, body: { event: events[events.length - 1], events, block_height: block.height } };
}

function proof(height, kind, messageId) {
  const block = state.blocks[height];
  if (!block) return { ok: false, status: 404, error: 'block not found' };
  const list = state.events[height] || [];
  let merkle = null;
  if (messageId) {
    const idx = list.findIndex((e) => e.message_id === messageId);
    if (idx >= 0) merkle = merkleProof(list.map(leafHash), idx);
  }
  return {
    ok: true,
    status: 200,
    body: {
      adapter_id: adapterId.toString('hex'),
      network: 'source-testnet',
      evidence_version: 1,
      declared_height: height,
      declared_root: block.state_root,
      local_simulator: true,
      note: 'in-process simulator: Merkle root is real; BLS aggregate is not produced here and has not been submitted to the registry',
      payload_hex: '',
      payload: {
        height,
        state_root: block.state_root,
        event_root: block.event_root,
        signer_count: 0,
        required: 2,
        sig_hex: '',
        pubkey_hex: '',
      },
      submitter: 'local-simulator',
      merkle_proof: merkle,
      kind: kind || 'bls',
    },
  };
}

function info() {
  return {
    latest_height: state.latestHeight,
    blocks: Object.keys(state.blocks).length,
    total_events: Object.values(state.events).reduce((n, v) => n + v.length, 0),
    asset_id: state.assetId,
    target_domain: targetDomain.toString('hex'),
    embedded: true,
    note: 'in-process source simulator (api/_sim.js). Lock and Merkle are live in this process. BLS is not signed here.',
  };
}

function latest() {
  return state.blocks[state.latestHeight];
}

function eventsAt(height) {
  if (height == null) return Object.values(state.events).flat();
  return state.events[height] || [];
}

module.exports = { lock, proof, info, latest, eventsAt, isStellarAccount, embedded: true };
