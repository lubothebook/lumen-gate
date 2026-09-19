// Lumen Gate console.
//
// One rule shapes this file: every value on screen comes from somewhere that
// can be checked. Addresses come from the deployment manifest, finality comes
// from a contract simulation, balances come from Horizon, and the audit comes
// from the record the loop writes. Where something cannot be checked from a
// hosted deployment, the interface says so instead of showing a button that
// fails.

const API = '';
const EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/';
const EXPLORER_CONTRACT = 'https://stellar.expert/explorer/testnet/contract/';

// Storage access is wrapped because a sandboxed or privacy-restricted context
// throws on the first touch, and a console that does not render because of a
// storage exception is worse than one that keeps the token in memory.
const store = {
  get(key) {
    try {
      return window.sessionStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  clear(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* nothing to clear */
    }
  },
};

const state = {
  status: null,
  source: null,
  lock: null,
  operatorToken: store.get('lumen.operatorToken'),
  wallet: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

function short(value, keep = 6) {
  if (!value) return '—';
  const text = String(value);
  return text.length <= keep * 2 + 2 ? text : `${text.slice(0, keep)}…${text.slice(-4)}`;
}

function txLink(hash) {
  return el('a', { class: 'explorer', href: EXPLORER_TX + hash, target: '_blank', rel: 'noreferrer', text: short(hash, 10) });
}

function log(id, message, level = '') {
  const box = $(id);
  if (!box) return;
  const time = new Date().toISOString().slice(11, 19);
  box.append(el('span', { class: level, text: `[${time}] ${message}\n` }));
  box.scrollTop = box.scrollHeight;
  if (box.textContent.trim() === 'Ready.') box.textContent = '';
}

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.operatorToken) headers.Authorization = `Bearer ${state.operatorToken}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, payload };
}

// -------------------------------------------------------------------- routing
function route() {
  const name = (location.hash.replace('#', '') || 'overview').split('?')[0];
  const known = ['overview', 'bridge', 'redeem', 'evidence', 'about'];
  const active = known.includes(name) ? name : 'overview';
  for (const section of known) $(`view-${section}`).hidden = section !== active;
  for (const button of document.querySelectorAll('nav.main button')) {
    if (button.dataset.nav === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    location.hash = nav.dataset.nav;
    event.preventDefault();
  }
});
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------- overview
function pill(id, ok, label, detail) {
  const node = $(id);
  node.textContent = '';
  const dot = el('span', { class: `dot ${ok ? 'ok' : 'warn'}` });
  node.append(dot, document.createTextNode(label));
  if (detail) node.title = detail;
}

function renderDeployment(status) {
  const contracts = status.contracts || {};
  const kv = $('deploymentKv');
  kv.textContent = '';
  const rows = [
    ['Registry', contracts.registry, `${EXPLORER_CONTRACT}${contracts.registry}`],
    ['Gateway', contracts.gateway, `${EXPLORER_CONTRACT}${contracts.gateway}`],
    [`${contracts.asset || 'wSRC'} (SAC)`, contracts.wrapped_asset, `${EXPLORER_CONTRACT}${contracts.wrapped_asset}`],
    ['Issuer', contracts.issuer, `https://stellar.expert/explorer/testnet/account/${contracts.issuer}`],
    ['Source domain', status.domain?.key, null],
  ];
  for (const [label, value, href] of rows) {
    kv.append(el('dt', { text: label }));
    if (!value) {
      kv.append(el('dd', { text: '—' }));
      continue;
    }
    if (/^[A-Z0-9]{56}$/.test(value) || /^[A-Z0-9]{50,60}$/.test(value)) {
      kv.append(el('dd', {}, [el('span', { class: 'chip', text: value })]));
    } else {
      kv.append(el('dd', { class: 'mono sm', text: value }));
    }
    if (href) {
      kv.lastChild.classList.add('sm');
      kv.append(el('dd', {}, [el('a', { class: 'explorer', href, target: '_blank', rel: 'noreferrer', text: 'open in explorer' })]));
    }
  }
  $('deploymentStamp').textContent = `read ${new Date().toLocaleTimeString()}`;
}

function renderHonesty(status) {
  const panel = $('honestyPanel');
  panel.textContent = '';
  const items = [
    ['The source chain is simulated in this deployment.', 'Its BLS signatures are real (RFC 9380 hash-to-curve, domain separator lumen-gate-finality-v1) but the validator keys are fixed demo values. A production deployment needs a DKG.'],
    ['The Groth16 lane is a statement proof, not a zkVM and not a signature verifier.', 'It proves a quorum of approval bits and a Poseidon binding of three roots. It does not prove that anyone signed anything, so settlement never anchors on it.'],
    ['Gasless applies to inbound mints only.', 'The recipient pays nothing; the relayer signs and pays, and is repaid in wrapped asset. Burning your own tokens still needs a fee.'],
    ['No bonds, no slashing, no market fee.', 'A validator that signs a wrong root loses nothing here. The relayer fee is a fixed amount chosen at submission time.'],
  ];
  for (const [head, body] of items) {
    panel.append(el('p', { class: 'note', style: 'margin:0 0 12px' }, [el('strong', { text: head }), document.createTextNode(' ' + body)]));
  }
  if (status.honesty?.findings_recorded) {
    panel.append(el('p', { class: 'xs muted', text: `${status.honesty.findings_recorded} defects found in this build are recorded in the deployment manifest, including the ones found by this console's own audit loop.` }));
  }
}

function renderCapabilities(status) {
  const caps = status.capabilities || {};
  pill('capReads', true, 'reads enabled', 'the manifest, balances and the audit record are public');
  pill('capRelay', Boolean(caps.operator_relay?.enabled), caps.operator_relay?.enabled ? 'relay enabled' : 'relay disabled', caps.operator_relay?.requires);
  pill('capSource', Boolean(caps.source_chain?.configured), caps.source_chain?.configured ? 'source adapter set' : 'source adapter absent', caps.source_chain?.note);
}

async function loadStatus() {
  const { ok, payload } = await api('/api/status');
  if (!ok) {
    // Degraded mode. Without the API layer there are no live reads, but the
    // addresses still have to be right: they are taken from the generated
    // module, which is written from the same deployment manifest, and the page
    // says out loud that it is offline instead of showing empty panels.
    $('netPill').innerHTML = '<span class="dot bad"></span> API unavailable — static addresses only';
    log('bridgeLog', `Live status request failed (${payload.error || payload.raw || 'network error'}). Addresses below come from the generated deployment module.`, 'warn');
    try {
      const { deployment } = await import('./deployment.js');
      renderDeployment({ contracts: {
        registry: deployment.registryId,
        gateway: deployment.gatewayId,
        wrapped_asset: deployment.tokenId,
        asset: 'wSRC',
      }, domain: { key: deployment.sourceDomainKey } });
      $('statRegistry').textContent = short(deployment.registryId, 8);
      $('statRegistrySub').textContent = 'static manifest';
      $('settleNote').textContent = 'No API layer in this build: start one (node tools/api-dev-server.js) or deploy the functions to Vercel.';
      $('lockBtn').disabled = true;
      $('settleBtn').disabled = true;
      $('sourceNote').textContent = 'No API layer: the source adapter cannot be reached from this build.';
    } catch (error) {
      log('bridgeLog', `No static deployment module either: ${error}`, 'bad');
    }
    return null;
  }
  state.status = payload;
  if (!state.lock) {
    const defaults = payload.receipts && payload.receipts['forward_mint'];
    void defaults;
  }

  const net = $('netPill');
  net.textContent = '';
  net.append(el('span', { class: 'dot ok' }), document.createTextNode(`Stellar ${payload.network} · protocol ${payload.protocol_version_at_deploy}`));

  $('statRegistry').textContent = short(payload.contracts?.registry || '—', 8);
  $('statRegistry').classList.add('mono');
  $('statRegistrySub').textContent = payload.chain?.latest_ledger ? `ledger ${payload.chain.latest_ledger}` : 'ledger unknown';
  $('statAudit').textContent = payload.audit?.result || '—';
  $('statAudit').className = `value ${payload.audit?.all_passed ? '' : 'muted'}`;
  $('statAuditSub').textContent = payload.audit ? `${payload.audit.rounds_recorded} round(s) recorded` : 'no record';

  const auditDot = $('auditPill');
  auditDot.textContent = '';
  auditDot.append(
    el('span', { class: `dot ${payload.audit?.all_passed ? 'ok' : 'warn'}` }),
    document.createTextNode(` self-audit ${payload.audit?.result || '—'}`)
  );

  $('footerChain').textContent = `${payload.chain?.horizon || ''}`.replace('https://', '');

  renderDeployment(payload);
  renderHonesty(payload);
  renderCapabilities(payload);
  renderReceipts(payload);
  renderFindings(payload);
  renderAudit(payload.audit);

  const recipient = $('lockRecipient');
  if (!recipient.value) recipient.value = payload.accounts?.end_user || payload.accounts?.gasless_recipient || '';

  const relayReady = Boolean(payload.capabilities?.operator_relay?.enabled);
  $('settleNote').textContent = relayReady
    ? 'This deployment can relay: the button below asks the operator facade for one pass, which signs and pays for the mint.'
    : 'This deployment cannot relay by itself — no operator URL and token are configured here. Locking still works; use “Copy the command instead” to settle it with the local relayer.';
  $('settleBtn').disabled = !relayReady || !state.lock;

  const sourceSet = Boolean(payload.capabilities?.source_chain?.configured);
  $('sourceNote').textContent = sourceSet
    ? 'Source adapter configured. Locks created here are real events on the simulated source chain.'
    : 'No source adapter is configured on this deployment, so the lock button is disabled rather than pretending.';
  $('lockBtn').disabled = !sourceSet;
  return payload;
}

function renderReceipts(status) {
  const body = $('receiptRows');
  body.textContent = '';
  const receipts = status.receipts || {};
  const named = [
    ['registry initialize', receipts.registry_initialize],
    ['register_domain', receipts.register_domain],
    ['set_bls_policy', receipts.set_bls_policy],
    ['admit_domain', receipts.admit_domain],
    ['renounce_admin', receipts.renounce_admin],
    ['forward mint', receipts.forward_mint_height_32 || receipts['forward_mint']],
    ['reverse burn', receipts.burn_and_relay],
  ].filter(([, hash]) => hash);
  if (status.gasless?.transaction) named.push(['gasless mint (zero-XLM recipient)', status.gasless.transaction]);
  if (named.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '2', class: 'muted', text: 'no receipts recorded' })]));
    return;
  }
  for (const [label, hash] of named) {
    body.append(el('tr', {}, [el('td', { text: label }), el('td', {}, [txLink(hash)])]));
  }
}

function renderFindings(status) {
  const list = $('findingsList');
  list.textContent = '';
  const { payload } = { payload: status };
  const findings = state.status?.findings || [];
  $('findingsCount').textContent = `${findings.length} recorded`;
  if (findings.length === 0) {
    list.append(el('p', { class: 'muted', text: 'none recorded' }));
    return;
  }
  for (const finding of findings) {
    list.append(
      el('details', { style: 'margin-bottom:10px' }, [
        el('summary', { text: finding.id }),
        el('p', { class: 'sm muted', style: 'margin:8px 0 4px', text: finding.found }),
        el('p', { class: 'sm', style: 'margin:0', text: `Fix: ${finding.fix}` }),
      ])
    );
  }
  void payload;
}

function renderAudit(audit) {
  const body = $('auditRows');
  body.textContent = '';
  if (!audit) {
    body.append(el('tr', {}, [el('td', { colspan: '4', class: 'muted', text: 'no audit record in this deployment' })]));
    return;
  }
  $('auditStamp').textContent = audit.last_check ? `last round ${audit.last_check}` : '';
  const history = audit.history || (audit.latest ? [audit.latest] : []);
  for (const round of history.slice().reverse()) {
    body.append(
      el('tr', {}, [
        el('td', { class: 'mono', text: String(round.round) }),
        el('td', { class: 'mono xs', text: round.finished_at || '—' }),
        el('td', { class: 'mono', text: `${round.checks_passed}/${round.checks_total}` }),
        el('td', { class: round.all_passed ? '' : 'bad', text: round.all_passed ? 'all passed' : 'attention' }),
      ])
    );
  }
}

// --------------------------------------------------------------------- bridge
const STEPS = {
  lock: 'bstep-lock',
  finality: 'bstep-finality',
  mint: 'bstep-mint',
};

function step(name, status, detail) {
  const node = $(STEPS[name]);
  node.classList.remove('done', 'active');
  if (status === 'done') node.classList.add('done');
  if (status === 'active') node.classList.add('active');
  const mark = node.querySelector('[data-mark]');
  mark.textContent = status === 'done' ? '✓' : status === 'active' ? '…' : '';
  if (detail) node.querySelector('p').textContent = detail;
}

function resetSteps() {
  step('lock', 'idle', 'message id, nonce and payload hash are derived from the event, not chosen by the relayer');
  step('finality', 'idle', 'aggregate BLS signature over height, state root and event root');
  step('mint', 'idle', 'Merkle proof of that single event against the finalized event root');
}

async function lock() {
  const amount = Number($('lockAmount').value);
  const recipient = $('lockRecipient').value.trim();
  const count = Number($('lockCount').value || 1);
  if (!Number.isInteger(amount) || amount <= 0) return log('bridgeLog', 'Amount must be a positive integer.', 'bad');
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) return log('bridgeLog', 'Recipient must be a Stellar account address (G…, 56 characters).', 'bad');

  resetSteps();
  step('lock', 'active');
  log('bridgeLog', `Locking ${amount} for ${short(recipient)} with ${count} event(s) in the block…`);
  const { ok, payload } = await api('/api/source?path=/lock', { method: 'POST', auth: true, body: { amount, recipient, count } });
  if (!ok) {
    step('lock', 'idle');
    log('bridgeLog', `Lock refused: ${payload.error || payload.raw || JSON.stringify(payload).slice(0, 160)}`, 'bad');
    if (payload.error === 'writes_disabled' || payload.error === 'unauthorized') log('bridgeLog', 'Set the operator token from the header button and try again.', 'warn');
    return;
  }
  const event = payload.event || payload.events?.[0];
  state.lock = { height: event?.height, event, blockHeight: payload.block_height || event?.height };
  step('lock', 'done', `lock observed at source height ${state.lock.height}`);
  log('bridgeLog', `Locked. message_id ${event?.message_id}\n  nonce ${event?.nonce} · payload_hash ${event?.payload_hash}\n  source height ${state.lock.height}`, 'ok');
  $('settleBtn').disabled = !state.status?.capabilities?.operator_relay?.enabled;
  await fetchProof(state.lock.height);
}

async function fetchProof(height) {
  step('finality', 'active');
  const { ok, payload } = await api(`/api/source?path=${encodeURIComponent(`/proof?height=${height}&kind=bls`)}`);
  if (!ok) {
    step('finality', 'idle');
    log('bridgeLog', `Proof unavailable: ${payload.error || JSON.stringify(payload).slice(0, 160)}`, 'bad');
    return null;
  }
  const b = payload.payload || {};
  step('finality', 'active', `BLS aggregate ready: ${b.signer_count}/${b.required} signers`);
  log(
    'bridgeLog',
    `Finality evidence for height ${payload.declared_height}\n  state_root ${payload.declared_root}\n  event_root  ${b.event_root}\n  signers ${b.signer_count} of ${b.required} required · signature ${b.sig_hex.length / 2} bytes`,
    'info'
  );
  return payload;
}

async function settle() {
  const height = state.lock?.height;
  if (!height) return;
  $('settleBtn').disabled = true;
  log('bridgeLog', `Asking the operator facade for one relayer pass at height ${height}…`);
  const { ok, payload } = await api(`/api/relay?height=${height}`, { method: 'POST', auth: true });
  if (!ok) {
    log('bridgeLog', `Relay refused (${payload.error || 'error'}): ${payload.why || payload.detail || JSON.stringify(payload).slice(0, 200)}`, 'warn');
    $('settleBtn').disabled = false;
    return;
  }
  for (const hash of payload.receipts || []) log('bridgeLog', `confirmed transaction ${hash}`, 'ok');
  if (!payload.receipts || payload.receipts.length === 0) log('bridgeLog', payload.note || 'no transaction was confirmed', 'warn');
  const lines = String(payload.output || '').split('\n').filter((l) => /receipt|already|minted|refused|failed/i.test(l));
  for (const line of lines) log('bridgeLog', `  ${line.trim()}`);

  const finality = await api(`/api/finality?height=${height}`);
  if (finality.ok && finality.payload.found) {
    step('finality', 'done', `registry recorded height ${finality.payload.record?.last_height || height}`);
    log('bridgeLog', `registry finality record: ${JSON.stringify(finality.payload.record)}`, 'ok');
  }
  if ((payload.receipts || []).length > 0) {
    step('mint', 'done', 'mint confirmed on Stellar');
    log('bridgeLog', `Explorer: ${EXPLORER_TX}${payload.receipts[payload.receipts.length - 1]}`, 'info');
  }
  $('settleBtn').disabled = false;
}

async function copyCommand() {
  const height = state.lock?.height || '<height>';
  const text = [
    '# run the local relayer against the source height you just locked',
    'cd <repo>',
    'SIM_URL=http://127.0.0.1:8080 \\',
    '  STELLAR_SOURCE_ACCOUNT=lumen-relayer \\',
    '  STELLAR_RELAYER_ADDRESS=<relayer G address> \\',
    '  RELAYER_FEE=1000000 STELLAR_NETWORK=testnet \\',
    `  ./target/debug/relayer --height ${height} --once`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('bridgeLog', 'Command copied to the clipboard.', 'ok');
  } catch {
    log('bridgeLog', text);
  }
}

// --------------------------------------------------------------------- redeem
async function connectWallet() {
  const freighter = window.freighterApi || window.freighter;
  if (!freighter) {
    log('redeemLog', 'Freighter is not available in this browser. The inbound direction does not need a wallet at all; only burning your own tokens does.', 'warn');
    return null;
  }
  try {
    const address = await (freighter.requestAccess ? freighter.requestAccess() : freighter.getPublicKey());
    const pub = typeof address === 'string' ? address : address.address;
    state.wallet = pub;
    $('walletChip').textContent = short(pub, 6);
    log('redeemLog', `Connected ${pub}`, 'ok');
    await refreshWallet();
    return pub;
  } catch (error) {
    log('redeemLog', `Wallet connection failed: ${error}`, 'bad');
    return null;
  }
}

async function refreshWallet() {
  if (!state.wallet) return;
  const horizon = state.status?.chain?.horizon || 'https://horizon-testnet.stellar.org';
  const asset = state.status?.contracts?.asset || 'wSRC';
  try {
    const account = await (await fetch(`${horizon}/accounts/${state.wallet}`)).json();
    if (account.status === 404) throw new Error('account not funded on testnet');
    const kv = $('walletKv');
    kv.textContent = '';
    for (const balance of account.balances) {
      const code = balance.asset_code || 'XLM';
      if (code === 'XLM' || code === asset) {
        kv.append(el('dt', { text: code }), el('dd', { text: balance.balance }));
      }
    }
    const native = account.balances.find((b) => b.asset_type === 'native');
    const reserve = ((2 + account.subentry_count) * 0.5).toFixed(7);
    const spendable = native ? (Number(native.balance) - Number(reserve)).toFixed(7) : '—';
    kv.append(el('dt', { text: 'Spendable XLM' }), el('dd', { text: spendable }));
  } catch (error) {
    log('redeemLog', `Balance read failed: ${error}`, 'bad');
  }
}

async function burn() {
  if (!state.wallet) {
    const address = await connectWallet();
    if (!address) return;
  }
  const amount = Number($('burnAmount').value);
  const recipient = ($('burnRecipient').value || state.wallet).trim();
  if (!Number.isInteger(amount) || amount <= 0) return log('redeemLog', 'Amount must be a positive integer.', 'bad');
  const gateway = state.status?.contracts?.gateway;
  const targetDomain = state.status?.domain?.key;
  if (!gateway || !targetDomain) return log('redeemLog', 'Deployment addresses are not loaded yet.', 'warn');

  log('redeemLog', `Preparing burn of ${amount} and unlock to ${short(recipient)}…`);
  try {
    const module = await import('./soroban.ts');
    const prepared = await module.buildBurnAndRelayTx(gateway, amount, recipient, targetDomain, state.wallet);
    const freighter = window.freighterApi || window.freighter;
    const signed = await freighter.signTransaction(prepared.toXDR(), {
      networkPassphrase: 'Test SDF Network ; September 2015',
      address: state.wallet,
    });
    const xdr = typeof signed === 'string' ? signed : signed.signedTxXdr;
    if (!xdr) throw new Error('Freighter returned no signed transaction');
    const server = module.server || module.sorobanServer;
    const submitted = await server.sendTransaction(module.StellarSdk ? module.StellarSdk.TransactionBuilder.fromXDR(xdr, module.StellarSdk.Networks.TESTNET) : xdr);
    log('redeemLog', `Submitted: ${JSON.stringify(submitted).slice(0, 300)}`, 'ok');
    await refreshWallet();
  } catch (error) {
    log('redeemLog', `Burn failed: ${error && error.message ? error.message : error}`, 'bad');
    log('redeemLog', 'The outbound direction needs the gateway burn entrypoint signed by your own key; if Freighter is not installed, use the CLI path documented in the README.', 'warn');
  }
}

// ------------------------------------------------------------------- evidence
async function queryFinality() {
  const height = $('heightQuery').value.trim();
  const kv = $('finalityKv');
  kv.textContent = '';
  kv.append(el('dt', { text: 'Result' }), el('dd', { text: 'querying the contract…' }));
  const { ok, payload } = await api(`/api/finality${height ? `?height=${encodeURIComponent(height)}` : ''}`);
  kv.textContent = '';
  if (!ok) {
    kv.append(el('dt', { text: 'Error' }), el('dd', { text: payload.error || JSON.stringify(payload).slice(0, 120) }));
    return;
  }
  const record = payload.record;
  const rows = [
    ['Query', payload.query],
    ['Found', payload.found ? 'yes' : 'no'],
    ['Latest height', record?.last_height],
    ['State root', record?.last_root || record?.state_root],
    ['Event root', record?.last_event_root || record?.event_root],
    ['Backing', Array.isArray(record?.last_security) ? record.last_security.join(' ') : record?.last_security],
    ['Adapter', record?.adapter_id],
    ['Read at ledger', payload.latest_ledger],
    ['Cost (cpu insns)', payload.cost?.cpu_insns],
  ];
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    kv.append(el('dt', { text: label }), el('dd', {}, [document.createTextNode(String(value))]));
  }
}

// ------------------------------------------------------------------- operator
function operatorDialog() {
  $('opToken').value = state.operatorToken;
  $('opState').textContent = state.operatorToken ? 'A token is set for this tab.' : 'No token set: writes will be refused.';
  $('operatorDialog').showModal();
}

function wire() {
  for (const button of document.querySelectorAll('[data-nav]')) {
    if (button.tagName === 'BUTTON') button.addEventListener('click', () => { location.hash = button.dataset.nav; });
  }
  $('lockBtn').addEventListener('click', () => lock().catch((error) => log('bridgeLog', String(error), 'bad')));
  $('settleBtn').addEventListener('click', () => settle().catch((error) => log('bridgeLog', String(error), 'bad')));
  $('copyCmdBtn').addEventListener('click', () => copyCommand());
  $('useWalletBtn').addEventListener('click', async () => {
    const pub = state.wallet || (await connectWallet());
    if (pub) $('lockRecipient').value = pub;
  });
  $('connectBtn').addEventListener('click', () => connectWallet());
  $('balanceBtn').addEventListener('click', () => refreshWallet());
  $('burnBtn').addEventListener('click', () => burn());
  $('queryBtn').addEventListener('click', () => queryFinality());
  $('operatorBtn').addEventListener('click', operatorDialog);
  $('opSave').addEventListener('click', () => {
    state.operatorToken = $('opToken').value.trim();
    const persisted = store.set('lumen.operatorToken', state.operatorToken);
    if (!persisted) log('bridgeLog', 'The browser refused session storage, so the token is kept in memory for this page only.', 'warn');
    $('operatorDialog').close();
    loadStatus();
  });
  $('opClear').addEventListener('click', () => {
    state.operatorToken = '';
    store.clear('lumen.operatorToken');
    $('opToken').value = '';
    $('opState').textContent = 'Token cleared.';
    loadStatus();
  });
}

wire();
route();
resetSteps();
loadStatus()
  .then(() => queryFinality())
  .catch((error) => {
    log('bridgeLog', `Startup failed: ${error}`, 'bad');
  });
