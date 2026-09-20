// Bank-transfer console. The payment path is Stello (Seyit Ali Değirmen's kit).
// This file never imports stello-sdk/server — that entry holds the landing key.

import { Keypair } from '@stellar/stellar-sdk';
import { Stello, fromStroops } from 'stello-sdk';

const STORAGE = 'lumen.stello.secret';
const PIGGY = 'CDF6WDCS3M36RN6ERREM4B5ZT74RL5SU3I2TLJ2JXB5DCODMHPP266UH';
const $ = (id) => document.getElementById(id);

const stello = new Stello({ route: 2 });

let keypair = null;
let payment = null;

function log(line, kind = '') {
  const box = $('log');
  if (box.textContent === 'nothing yet in this session.') box.textContent = '';
  const time = new Date().toISOString().slice(11, 19);
  box.textContent += `[${time}] ${line}\n`;
  if (kind === 'bad') box.dataset.kind = 'bad';
  box.scrollTop = box.scrollHeight;
}

function loadKey() {
  const secret = localStorage.getItem(STORAGE);
  if (secret) {
    try {
      return Keypair.fromSecret(secret);
    } catch {
      localStorage.removeItem(STORAGE);
    }
  }
  const fresh = Keypair.random();
  localStorage.setItem(STORAGE, fresh.secret());
  return fresh;
}

function paintKey() {
  $('pubKey').textContent = keypair ? keypair.publicKey() : '—';
}

function kv(rows) {
  const node = $('payKv');
  node.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null || v === '' ? '—' : String(v);
    node.append(dt, dd);
  }
}

function setBusy(busy) {
  for (const id of ['requestBtn', 'simulateBtn', 'waitBtn', 'newKeyBtn']) {
    const btn = $(id);
    if (!btn) continue;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }
  $('requestBtn').disabled = busy;
  $('newKeyBtn').disabled = busy;
  $('simulateBtn').disabled = busy || !payment;
  $('waitBtn').disabled = busy || !payment;
}

async function requestDeposit() {
  const amountTry = $('amountTry').value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(amountTry) || Number(amountTry) <= 0) {
    log(`Amount must be a positive TRY figure, got "${amountTry}".`, 'bad');
    return;
  }
  setBusy(true);
  log(`Opening a ticket for ${amountTry} TRY on Stello route 2 (piggy bank)…`);
  try {
    payment = await stello.requestDeposit({
      keypair,
      amountTry,
      arg: new Uint8Array([1]),
      onStep: (step, detail) => log(`step ${step}${detail ? `: ${detail}` : ''}`),
    });
    kv([
      ['ticket', payment.ticket],
      ['IBAN', payment.iban],
      ['reference', payment.reference],
      ['estimated USDC', payment.estimatedUsdc != null ? String(payment.estimatedUsdc) : ''],
    ]);
    log(`Show the user IBAN ${payment.iban} with reference ${payment.reference}. On this mock, the next button simulates the transfer; no real bank is contacted.`);
  } catch (error) {
    payment = null;
    log(`requestDeposit failed: ${error && error.message ? error.message : error}`, 'bad');
  } finally {
    setBusy(false);
  }
}

async function simulateTransfer() {
  if (!payment) return;
  const amountTry = $('amountTry').value.trim();
  setBusy(true);
  log('Simulating the TRY transfer against the mock anchor. This is not a real bank payment.');
  try {
    await stello.simulateBankTransfer(payment, amountTry);
    log('Mock transfer recorded. Waiting for the router to dispatch…');
    await waitForContract();
  } catch (error) {
    log(`simulateBankTransfer failed: ${error && error.message ? error.message : error}`, 'bad');
    setBusy(false);
  }
}

async function waitForContract() {
  if (!payment) return;
  setBusy(true);
  log('Waiting for router.dispatch / on_deposit (timeout 120s per stage)…');
  try {
    const result = await stello.waitForDeposit({
      handle: payment,
      timeoutMs: 120000,
      onStep: (step, detail) => log(`wait ${step}${detail ? `: ${detail}` : ''}`),
    });
    kv([
      ['ticket', result.ticket],
      ['accepted', result.accepted],
      ['amount (USDC)', fromStroops(result.amount)],
      ['payment ref', result.paymentRef],
    ]);
    if (result.accepted) {
      log(`Piggy bank accepted ${fromStroops(result.amount)} USDC for ${keypair.publicKey()}.`);
    } else {
      log('The target returned accepted: false. On this piggy bank that means it refunded the user itself. The router does not refund.');
    }
  } catch (error) {
    log(`waitForDeposit failed: ${error && error.message ? error.message : error}`, 'bad');
  } finally {
    setBusy(false);
  }
}

export function boot() {
  keypair = loadKey();
  paintKey();
  log(`Key ${keypair.publicKey()}. Route 2 piggy ${PIGGY}.`);
  $('requestBtn').addEventListener('click', () => requestDeposit());
  $('simulateBtn').addEventListener('click', () => simulateTransfer());
  $('waitBtn').addEventListener('click', () => waitForContract());
  $('newKeyBtn').addEventListener('click', () => {
    if (!confirm('Replace the key stored in this browser? The previous secret is discarded here.')) return;
    localStorage.removeItem(STORAGE);
    keypair = loadKey();
    payment = null;
    kv([]);
    paintKey();
    log(`New key ${keypair.publicKey()}.`);
  });
}
