'use strict';

// ---------------------------------------------------------------------------
// The SEP-6 transaction record store.
//
// A record is created when a client asks for deposit or withdrawal instructions
// and it advances only when evidence is observed on a ledger. That order
// matters: the store is a view of what the networks did, never a place where a
// client can assert that something happened.
//
// Storage is a JSON file so the record survives a restart and can be inspected
// (or committed as evidence) without a database. Writes are atomic: the new
// document is written to a temporary file and renamed over the old one, so a
// crash mid-write cannot leave a half-file behind.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STORE = path.join(__dirname, '..', '..', 'deployments', 'sep6-transactions.json');

function storePath() {
  return (process.env.SEP6_STORE || '').trim() || DEFAULT_STORE;
}

function emptyDocument() {
  return {
    note:
      'SEP-6 transaction records for this deployment. Each record is advanced only by evidence read from a ledger (a source-chain lock event, a Stellar payment, or a verified burn transaction).',
    records: [],
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!parsed || !Array.isArray(parsed.records)) return emptyDocument();
    return parsed;
  } catch {
    return emptyDocument();
  }
}

function save(document) {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function newId() {
  return crypto.randomUUID();
}

function create(fields) {
  const document = load();
  const now = new Date().toISOString();
  const record = {
    id: newId(),
    started_at: now,
    updated_at: now,
    stellar_transaction_id: null,
    external_transaction_id: null,
    message: null,
    ...fields,
  };
  document.records.unshift(record);
  save(document);
  return record;
}

function update(id, patch) {
  const document = load();
  const index = document.records.findIndex((record) => record.id === id);
  if (index === -1) return null;
  document.records[index] = {...document.records[index], ...patch, updated_at: new Date().toISOString()};
  save(document);
  return document.records[index];
}

function list({id, account, kind, status} = {}) {
  let records = load().records;
  if (id) records = records.filter((record) => record.id === id);
  if (kind) records = records.filter((record) => record.kind === kind);
  if (status) records = records.filter((record) => record.status === status);
  if (account) {
    records = records.filter(
      (record) => record.from === account || record.to === account || record.account === account
    );
  }
  return records;
}

function get(id) {
  return load().records.find((record) => record.id === id) || null;
}

module.exports = {load, save, create, update, list, get, storePath};
