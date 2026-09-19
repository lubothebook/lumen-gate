// Lumen Gate console.
//
// One rule shapes this file: every value on screen comes from somewhere that
// can be checked. Addresses come from the deployment manifest, finality comes
// from a contract simulation, balances come from Horizon, and the audit comes
// from the record the loop writes. Where something cannot be checked from a
// hosted deployment, the interface says so instead of showing a button that
// would fail.

const EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/';
const EXPLORER_CONTRACT = 'https://stellar.expert/explorer/testnet/contract/';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

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
  if (!value) return '-';
  const text = String(value);
  return text.length <= keep * 2 + 2 ? text : `${text.slice(0, keep)}...${text.slice(-4)}`;
}

function txLink(hash) {
  return el('a', { class: 'explorer', href: EXPLORER_TX + hash, target: '_blank', rel: 'noreferrer', text: short(hash, 10) });
}

function log(message, level = '') {
  const box = $('txLog');
  const time = new Date().toISOString().slice(11, 19);
  if (box.textContent.trim() === 'Ready.') box.textContent = '';
  box.append(el('span', { class: level, text: `[${time}] ${message}\n` }));
  box.scrollTop = box.scrollHeight;
}

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.operatorToken) headers.Authorization = `Bearer ${state.operatorToken}`;
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, payload };
}

// ------------------------------------------------------------------ nav
function watchSections() {
  const targets = [...document.querySelectorAll('nav.main a[data-nav]')];
  const sections = targets.map((link) => $(link.dataset.nav)).filter(Boolean);
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      for (const link of targets) {
        if (link.dataset.nav === visible.target.id) link.setAttribute('aria-current', 'true');
        else link.setAttribute('aria-current', 'false');
      }
    },
    { rootMargin: '-84px 0px -60% 0px', threshold: [0.05, 0.25] }
  );
  for (const section of sections) observer.observe(section);
}

// -------------------------------------------------------------- status
function pill(id, ok, label, detail) {
  const node = $(id);
  node.textContent = '';
  node.append(el('span', { class: `dot ${ok ? 'ok' : 'warn'}` }), document.createTextNode(` ${label}`));
  if (detail) node.title = detail;
}

function setStat(valueId, subId, value, sub, mono) {
  const node = $(valueId);
  node.textContent = value ?? '-';
  node.className = 'value' + (mono ? ' sm' : '');
  if (sub !== undefined) $(subId).textContent = sub;
}

function renderDeployment(status) {
  const contracts = status.contracts || {};
  const kv = $('deploymentKv');
  kv.textContent = '';
  const rows = [
    ['Registry', contracts.registry, `${EXPLORER_CONTRACT}${contracts.registry}`],
    ['Gateway', contracts.gateway, `${EXPLORER_CONTRACT}${contracts.gateway}`],
    [`${contracts.asset || 'wSRC'} (Stellar Asset Contract)`, contracts.wrapped_asset, `${EXPLORER_CONTRACT}${contracts.wrapped_asset}`],
    ['Issuer', contracts.issuer, `https://stellar.expert/explorer/testnet/account/${contracts.issuer}`],
    ['Source domain key', status.domain?.key, null],
    ['Target domain', status.target_domain, null],
  ];
  for (const [label, value, href] of rows) {
    kv.append(el('dt', { text: label }));
    if (!value) {
      kv.append(el('dd', { text: '-' }));
      continue;
    }
    kv.append(el('dd', { text: value }));
    if (href) kv.append(el('dd', {}, [el('a', { class: 'explorer', href, target: '_blank', rel: 'noreferrer', text: 'open in explorer' })]));
  }
  $('deploymentStamp').textContent = `read ${new Date().toLocaleTimeString()}`;
}

function renderHonesty(status) {
  const panel = $('honestyPanel');
  panel.textContent = '';
  const items = [
    ['The source chain is simulated in this deployment.', 'Its BLS signatures are real (RFC 9380 hash-to-curve, domain separator lumen-gate-finality-v1) but the validator keys are fixed demo values. A production deployment needs a key ceremony, not a constant.'],
    ['The Groth16 lane is a statement proof.', 'It proves a quorum of approval bits and a Poseidon binding of three roots. It is not a signature verifier and not a zkVM, so settlement never anchors on it: the registry stores zeroes in the event-root slot for that lane.'],
    ['Gasless applies to inbound mints only.', 'The recipient pays nothing because the relayer signs and pays. Burning your own tokens still needs your key and your fee.'],
    ['No bonds, no slashing, no market fee.', 'A validator that signs a wrong root loses nothing here. The relayer fee is a fixed amount chosen at submission time, not a market.'],
  ];
  for (const [head, body] of items) {
    panel.append(el('p', { class: 'note', style: 'margin:0 0 12px' }, [el('strong', { text: head }), document.createTextNode(' ' + body)]));
  }
  if (status.honesty?.findings_recorded) {
    panel.append(
      el('p', { class: 'xs faint', text: `${status.honesty.findings_recorded} defects found in this build are recorded in the deployment manifest, including the ones this console found while it was being driven.` })
    );
  }
}

function renderCapabilities(status) {
  const caps = status.capabilities || {};
  pill('capReads', true, 'reads on', 'the manifest, balances and the audit record are public');
  const relay = Boolean(caps.operator_relay?.enabled);
  pill('capRelay', relay, relay ? 'relay on' : 'relay off', caps.operator_relay?.note || caps.operator_relay?.requires);
  const source = Boolean(caps.source_chain?.configured);
  pill('capSource', source, source ? 'source chain on' : 'source chain off', caps.source_chain?.note);
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
    ['renounce_admin (registry)', receipts.renounce_admin],
    ['renounce_admin (gateway)', receipts.gateway_renounce_admin],
    ['forward mint', receipts.forward_mint_height_32 || receipts['forward_mint']],
    ['reverse burn', receipts.burn_and_relay],
    ['console round trip: BLS anchor', receipts.registry_bls_accepted_height_1_console_run],
    ['console round trip: mint 1 of 3', receipts.console_mint_1_of_3],
    ['console round trip: mint 2 of 3', receipts.console_mint_2_of_3],
    ['console round trip: mint 3 of 3', receipts.console_mint_3_of_3],
  ].filter(([, hash]) => hash);
  if (status.gasless?.transaction) named.push(['gasless mint, zero-XLM recipient', status.gasless.transaction]);
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
  const findings = status.findings || [];
  list.textContent = '';
  $('findingsSummary').textContent = findings.length === 0
    ? 'Nothing is recorded, which for a build this size usually means nobody looked.'
    : `${findings.length} defects, kept in the deployment manifest instead of edited out of it. A build with no recorded defects is a build where nobody looked.`;
  for (const finding of findings) {
    const block = el('div', { class: 'finding' });
    block.append(el('p', { class: 'mono xs', style: 'color:var(--faint); margin-top:16px', text: finding.id }));
    block.append(el('p', { style: 'margin-top:6px', text: finding.found }));
    block.append(el('p', {}, [el('strong', { text: 'Fix. ' }), document.createTextNode(finding.fix)]));
    list.append(block);
  }
}

function renderAudit(audit) {
  const body = $('auditRows');
  body.textContent = '';
  const history = audit?.history || [];
  if (history.length === 0) {
    // The status payload carries a summary; the round history comes from
    // /api/audit. Say which one this is instead of showing an empty table.
    body.append(el('tr', {}, [
      el('td', { class: 'mono', text: audit?.latest?.round ?? 'latest' }),
      el('td', { class: 'mono xs', text: audit?.last_check || audit?.latest?.finished_at || '-' }),
      el('td', { class: 'mono', text: audit?.result || '-' }),
      el('td', { class: audit?.all_passed ? 'ok' : 'warn', text: audit?.all_passed ? 'all passed' : 'attention' }),
    ]));
    return;
  }
  for (const round of history.slice().reverse()) {
    body.append(
      el('tr', {}, [
        el('td', { class: 'mono', text: String(round.round) }),
        el('td', { class: 'mono xs', text: round.finished_at || '-' }),
        el('td', { class: 'mono', text: `${round.checks_passed}/${round.checks_total}` }),
        el('td', { class: round.all_passed ? 'ok' : 'bad', text: round.all_passed ? 'all passed' : 'attention' }),
      ])
    );
  }
}

async function loadAuditHistory() {
  const { ok, payload } = await api('/api/audit');
  if (!ok) return;
  const record = payload.record || payload;
  if (Array.isArray(record.history) && record.history.length > 0) {
    renderAudit({ ...record, last_check: record.latest?.finished_at, result: `${record.latest?.checks_passed}/${record.latest?.checks_total}`, all_passed: record.latest?.all_passed });
    $('auditStamp').textContent = `${record.history.length} rounds`;
  }
}

async function loadStatus() {
  const { ok, payload } = await api('/api/status');
  if (!ok) {
    // Degraded mode. Without the API layer there are no live reads, but the
    // addresses still have to be right: they come from the generated module,
    // which is written from the same deployment manifest, and the page says
    // out loud that it is offline instead of showing empty panels.
    $('netPill').innerHTML = '<span class="dot bad"></span> API unavailable - static addresses only';
    log(`Live status request failed (${payload.error || payload.raw || 'network error'}). Addresses below come from the generated deployment module.`, 'warn');
    try {
      const { deployment } = await import('./deployment.js');
      renderDeployment({
        contracts: { registry: deployment.registryId, gateway: deployment.gatewayId, wrapped_asset: deployment.tokenId, asset: 'wSRC' },
        domain: { key: deployment.sourceDomainKey },
      });
      setStat('statRegistry', 'statRegistrySub', short(deployment.registryId, 8), 'static manifest', true);
      setStat('statFinality', 'statFinalitySub', '-', 'no API layer in this build');
      $('settleNote').textContent = 'No API layer in this build: start one with node tools/api-dev-server.js, or deploy the functions to Vercel.';
      $('lockBtn').disabled = true;
      $('settleBtn').disabled = true;
      $('sourceNote').textContent = 'No API layer: the source adapter cannot be reached from this build.';
    } catch (error) {
      log(`No static deployment module either: ${error}`, 'bad');
    }
    return null;
  }

  state.status = payload;
  const net = $('netPill');
  net.textContent = '';
  net.append(
    el('span', { class: 'dot ok' }),
    el('span', { class: 'net-long', text: `Stellar ${payload.network} - ledger ${payload.chain?.latest_ledger ?? '?'}` }),
    el('span', { class: 'net-short', text: payload.network || 'testnet' })
  );

  setStat('statRegistry', 'statRegistrySub', short(payload.contracts?.registry, 8), `read live at ledger ${payload.chain?.latest_ledger ?? '?'}`, true);
  setStat('statAudit', 'statAuditSub', payload.audit?.result || '-', payload.audit ? `${payload.audit.rounds_recorded} round(s) recorded` : 'no record');
  setStat('statFindings', 'statFindingsSub', String(payload.honesty?.findings_recorded ?? '-'), 'recorded in the deployment manifest');

  renderDeployment(payload);
  renderHonesty(payload);
  renderCapabilities(payload);
  renderReceipts(payload);
  renderFindings(payload);
  renderAudit(payload);

  const recipient = $('lockRecipient');
  if (!recipient.value) recipient.value = payload.accounts?.gasless_recipient || payload.accounts?.end_user || '';

  const relayReady = Boolean(payload.capabilities?.operator_relay?.enabled);
  $('settleNote').textContent = relayReady
    ? 'This deployment can relay: the button runs one relayer pass at the height you locked. The relayer signs and pays.'
    : 'This deployment cannot relay by itself: no operator URL and token are configured here. Locking still works; use "Copy the command instead" to settle it with the local relayer.';
  $('settleBtn').disabled = !relayReady || !state.lock;

  const sourceReady = Boolean(payload.capabilities?.source_chain?.configured);
  $('sourceNote').textContent = sourceReady
    ? 'Source adapter configured. Locks created here become real events on the simulated source chain, with real BLS evidence behind them.'
    : 'No source adapter is configured on this deployment, so this button is disabled rather than pretending to work.';
  $('lockBtn').disabled = !sourceReady;

  $('operatorHint').textContent = state.operatorToken ? 'writes: token set for this tab' : 'writes: no operator token yet';
  $('footerChain').textContent = `${payload.chain?.horizon || ''}`.replace('https://', '');
  return payload;
}

// -------------------------------------------------------------- finality
async function queryFinality(height) {
  const kv = $('finalityKv');
  kv.textContent = '';
  kv.append(el('dt', { text: 'Result' }), el('dd', { text: 'querying the contract...' }));
  const { ok, payload } = await api(`/api/finality${height ? `?height=${encodeURIComponent(height)}` : ''}`);
  kv.textContent = '';
  if (!ok) {
    kv.append(el('dt', { text: 'Error' }), el('dd', { text: payload.error || JSON.stringify(payload).slice(0, 140) }));
    return null;
  }
  const record = payload.record || {};
  const backing = Array.isArray(record.last_security) ? record.last_security.join(' ') : record.last_security;
  const rows = [
    ['Query', payload.query],
    ['Found', payload.found ? 'yes' : 'no'],
    ['Finalized height', record.last_height],
    ['State root', record.last_root || record.state_root],
    ['Event root', record.last_event_root || record.event_root],
    ['Backing', backing],
    ['Read at ledger', payload.latest_ledger],
  ];
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    kv.append(el('dt', { text: label }), el('dd', { text: String(value) }));
  }
  setStat('statFinality', 'statFinalitySub', record.last_height || '-', backing ? `backing: ${backing}` : 'no finality recorded yet');
  return payload;
}

// ---------------------------------------------------------------- wallet
async function connectWallet() {
  const freighter = window.freighterApi || window.freighter;
  if (!freighter) {
    $('walletNote').textContent = 'Freighter is not installed in this browser. Receiving does not need a wallet at all; only burning your own tokens does.';
    log('Freighter is not available in this browser. The inbound direction needs no wallet.', 'warn');
    return null;
  }
  try {
    const access = await (freighter.requestAccess ? freighter.requestAccess() : freighter.getPublicKey());
    const pub = typeof access === 'string' ? access : access.address;
    state.wallet = pub;
    $('walletChip').textContent = short(pub, 6);
    $('connectBtn').textContent = 'Reconnect';
    log(`Wallet connected: ${pub}`, 'ok');
    await refreshWallet();
    return pub;
  } catch (error) {
    log(`Wallet connection failed: ${error}`, 'bad');
    return null;
  }
}

async function refreshWallet() {
  if (!state.wallet) {
    $('walletNote').textContent = 'Connect a wallet to read your own balances. You do not need one to receive.';
    return;
  }
  const horizon = state.status?.chain?.horizon || 'https://horizon-testnet.stellar.org';
  const asset = state.status?.contracts?.asset || 'wSRC';
  try {
    const account = await (await fetch(`${horizon}/accounts/${state.wallet}`)).json();
    if (account.status === 404) throw new Error('this account is not funded on testnet');
    const native = account.balances.find((b) => b.asset_type === 'native');
    const wrapped = account.balances.find((b) => b.asset_code === asset);
    const reserve = ((2 + (account.subentry_count || 0)) * 0.5).toFixed(7);
    const spendable = native ? (Number(native.balance) - Number(reserve)).toFixed(7) : null;

    const body = $('walletKv');
    body.textContent = '';
    const row = (label, unit, value, cls) => {
      const tr = el('tr');
      const left = el('td', {}, [document.createTextNode(label)]);
      if (unit) left.append(el('span', { class: 'unit', text: unit }));
      const right = el('td', { text: value });
      if (cls) right.className = cls;
      tr.append(left, right);
      return tr;
    };
    body.append(row('XLM', '', native ? native.balance : '-'));
    body.append(row('Spendable XLM', 'after reserve', spendable ?? '-', Number(spendable) > 0 ? 'ok' : 'warn'));
    body.append(row(asset, 'wrapped asset', wrapped ? wrapped.balance : `no trustline for ${asset}`, wrapped ? '' : 'warn'));

    $('walletKind').textContent = 'connected: you can burn, and receive';
    const link = $('walletLink');
    link.hidden = false;
    link.setAttribute('href', `https://stellar.expert/explorer/testnet/account/${state.wallet}`);
    link.textContent = 'Open in explorer';
    $('walletNote').textContent = "Balances read from Horizon. Spendable XLM is what is left after the account's own reserve, and receiving does not need any of it.";
  } catch (error) {
    log(`Balance read failed: ${error}`, 'bad');
    $('walletNote').textContent = `Could not read balances: ${error}`;
  }
}

// -------------------------------------------------------- inbound (lock)
const STEP_IDS = { lock: 'bstep-lock', finality: 'bstep-finality', mint: 'bstep-mint' };

function step(name, status, detail) {
  const node = $(STEP_IDS[name]);
  if (!node) return;
  node.classList.toggle('done', status === 'done');
  node.classList.toggle('active', status === 'active');
  const mark = node.querySelector('[data-mark]');
  if (mark) mark.textContent = status === 'done' ? 'OK' : status === 'active' ? '..' : '';
  if (detail) {
    const target = node.querySelector('[data-detail]');
    if (target) target.textContent = detail;
  }
}

function resetSteps() {
  step('lock', 'idle', 'message id, nonce and payload hash come from the event');
  step('finality', 'idle', 'aggregate BLS signature over height, state root and event root');
  step('mint', 'idle', 'Merkle proof of that event against the finalized root');
}

async function lock() {
  const amount = Number($('lockAmount').value);
  const recipient = $('lockRecipient').value.trim();
  const count = Number($('lockCount').value || 1);
  if (!Number.isInteger(amount) || amount <= 0) return log('Amount must be a positive whole number.', 'bad');
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) return log('Recipient must be a Stellar account address (G..., 56 characters).', 'bad');

  resetSteps();
  step('lock', 'active', 'creating the lock event on the source chain');
  log(`Locking ${amount} for ${short(recipient)} with ${count} event(s) in the block...`);
  const { ok, payload } = await api('/api/source?path=/lock', { method: 'POST', auth: true, body: { amount, recipient, count } });
  if (!ok) {
    step('lock', 'idle');
    log(`Lock refused: ${payload.error || payload.raw || JSON.stringify(payload).slice(0, 160)}`, 'bad');
    if (payload.error === 'writes_disabled' || payload.error === 'unauthorized') {
      log('Open Operator in the header and set the token, then try again.', 'warn');
    }
    if (payload.error === 'source_unreachable') {
      log('The source adapter is not reachable from this deployment. That is a configuration state, not a chain failure.', 'warn');
    }
    return;
  }
  const event = payload.event || payload.events?.[0];
  state.lock = { height: event?.height ?? payload.block_height, event, events: payload.events || [] };
  step('lock', 'done', `lock observed at source height ${state.lock.height}`);
  log(`Locked. message_id ${event?.message_id}\n  nonce ${event?.nonce} - payload_hash ${event?.payload_hash}\n  ${payload.events?.length || 1} event(s) in block ${payload.block_height}, expiry height ${event?.expiry_height}`, 'ok');
  $('settleBtn').disabled = !state.status?.capabilities?.operator_relay?.enabled;
  await showProof(state.lock.height);
}

async function showProof(height) {
  step('finality', 'active', 'reading the finality evidence for this height');
  const { ok, payload } = await api(`/api/source?path=${encodeURIComponent(`/proof?height=${height}&kind=bls`)}`);
  if (!ok) {
    step('finality', 'idle');
    log(`Finality evidence unavailable: ${payload.error || JSON.stringify(payload).slice(0, 160)}`, 'bad');
    return null;
  }
  const b = payload.payload || {};
  step('finality', 'active', `${b.signer_count} signatures collected, ${b.required} required`);
  log(
    `Finality evidence for height ${payload.declared_height}\n  state_root ${payload.declared_root}\n  event_root ${b.event_root}\n  ${b.signer_count} signatures collected, policy requires ${b.required} - aggregate is ${(b.sig_hex || '').length / 2} bytes`,
    'info'
  );
  return payload;
}

async function settle() {
  const height = state.lock?.height;
  if (!height) return;
  $('settleBtn').disabled = true;
  $('settleBtn').textContent = 'Relayer pass running...';
  step('finality', 'active', 'the relayer is anchoring this block and paying for the mint');
  log(`Asking the operator facade for one relayer pass at height ${height}. This signs, submits and waits for confirmation, so it takes tens of seconds.`);
  const { ok, payload } = await api(`/api/relay?height=${height}`, { method: 'POST', auth: true });
  $('settleBtn').textContent = 'Ask the relayer to settle';
  if (!ok) {
    log(`Relay refused (${payload.error || 'error'}): ${payload.why || payload.detail || JSON.stringify(payload).slice(0, 200)}`, 'warn');
    step('finality', 'idle', 'the relayer pass did not complete; finality was not anchored');
    $('settleBtn').disabled = false;
    return;
  }
  if (payload.error) log(`The relayer did not run: ${payload.error}`, 'bad');
  const receipts = payload.receipts || [];
  for (const hash of receipts) log(`confirmed transaction ${hash}`, 'ok');
  if (receipts.length === 0) log(payload.note || 'no transaction was confirmed', 'warn');
  for (const line of String(payload.output || '').split('\n')) {
    if (/refused|failed|error|already/i.test(line)) log(`  ${line.trim()}`, 'warn');
  }
  const finality = await queryFinality(String(height));
  if (finality?.found) {
    step('finality', 'done', `registry recorded height ${finality.record?.last_height || height}`);
    log(`registry finality record: ${JSON.stringify(finality.record)}`, 'ok');
  }
  if (receipts.length > 0) {
    step('mint', 'done', 'mint confirmed on Stellar');
    log(`Explorer: ${EXPLORER_TX}${receipts[receipts.length - 1]}`, 'info');
  }
  $('settleBtn').disabled = false;
}

async function copyCommand() {
  const height = state.lock?.height || '<height>';
  const text = [
    '# settle a locked source height with the local relayer',
    'cd <repo>',
    'SIM_URL=http://127.0.0.1:8080 \\',
    '  STELLAR_SOURCE_ACCOUNT=lumen-relayer \\',
    '  STELLAR_RELAYER_ADDRESS=<relayer G address> \\',
    '  RELAYER_FEE=1000000 STELLAR_NETWORK=testnet \\',
    `  ./target/debug/relayer --height ${height} --once`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('Command copied to the clipboard.', 'ok');
  } catch {
    log(text);
  }
}

// ------------------------------------------------------- outbound (burn)
async function burn() {
  if (!state.wallet) {
    const address = await connectWallet();
    if (!address) return;
  }
  const amount = Number($('burnAmount').value);
  const recipient = ($('burnRecipient').value || state.wallet).trim();
  if (!Number.isInteger(amount) || amount <= 0) return log('Amount must be a positive whole number.', 'bad');
  const gateway = state.status?.contracts?.gateway;
  const targetDomain = state.status?.domain?.key;
  if (!gateway || !targetDomain) return log('Deployment addresses are not loaded yet.', 'warn');

  log(`Preparing a burn of ${amount} with unlock to ${short(recipient)}...`);
  try {
    const module = await import('./soroban.ts');
    const prepared = await module.buildBurnAndRelayTx(gateway, String(amount), recipient, targetDomain, state.wallet);
    const freighter = window.freighterApi || window.freighter;
    const signed = await freighter.signTransaction(prepared.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address: state.wallet });
    const xdr = typeof signed === 'string' ? signed : signed.signedTxXdr;
    if (!xdr) throw new Error('Freighter returned no signed transaction');
    const submitted = await module.server.sendTransaction(prepared);
    log(`Submitted: ${JSON.stringify(submitted).slice(0, 300)}`, 'ok');
    await refreshWallet();
  } catch (error) {
    log(`Burn failed: ${error && error.message ? error.message : error}`, 'bad');
    log('The outbound direction needs the gateway burn entrypoint signed by your own key. If Freighter is not installed, the README documents the CLI path.', 'warn');
  }
}

// -------------------------------------------------------------- operator
function operatorDialog() {
  $('opToken').value = state.operatorToken;
  $('opState').textContent = state.operatorToken ? 'A token is set for this tab.' : 'No token set: writes will be refused.';
  $('operatorDialog').showModal();
}

function showTab(which) {
  const inbound = which === 'inbound';
  $('tabInbound').setAttribute('aria-selected', String(inbound));
  $('tabOutbound').setAttribute('aria-selected', String(!inbound));
  $('paneInbound').classList.toggle('hidden', !inbound);
  $('paneOutbound').classList.toggle('hidden', inbound);
}

function wire() {
  $('lockBtn').addEventListener('click', () => lock().catch((error) => log(String(error), 'bad')));
  $('settleBtn').addEventListener('click', () => settle().catch((error) => log(String(error), 'bad')));
  $('copyCmdBtn').addEventListener('click', () => copyCommand());
  $('useWalletBtn').addEventListener('click', async () => {
    const pub = state.wallet || (await connectWallet());
    if (pub) $('lockRecipient').value = pub;
  });
  $('connectBtn').addEventListener('click', () => connectWallet());
  $('balanceBtn').addEventListener('click', () => refreshWallet());
  $('walletLink').addEventListener('click', () => {});
  $('burnBtn').addEventListener('click', () => burn());
  $('queryBtn').addEventListener('click', () => queryFinality($('heightQuery').value.trim()));
  $('heightQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') queryFinality($('heightQuery').value.trim());
  });
  $('tabInbound').addEventListener('click', () => showTab('inbound'));
  $('tabOutbound').addEventListener('click', () => showTab('outbound'));
  $('operatorBtn').addEventListener('click', operatorDialog);
  $('opSave').addEventListener('click', () => {
    state.operatorToken = $('opToken').value.trim();
    const persisted = store.set('lumen.operatorToken', state.operatorToken);
    if (!persisted) log('The browser refused session storage, so the token is kept in memory for this page only.', 'warn');
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
watchSections();
resetSteps();
loadStatus()
  .then(async (status) => {
    if (!status) return null;
    await loadAuditHistory();
    return queryFinality('');
  })
  .catch((error) => log(`Startup failed: ${error}`, 'bad'));
