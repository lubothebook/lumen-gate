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

const LOG_PLACEHOLDER = [
  'nothing yet in this session.',
  '',
  'Lock a block and this panel will show, line by line: the message id that',
  'the event produced, the aggregate BLS signature the registry checks, and',
  'every transaction hash the relayer confirmed.',
].join('\n');

function showLogPlaceholder() {
  const box = $('txLog');
  box.textContent = '';
  box.append(el('span', { class: 'log-empty', text: LOG_PLACEHOLDER }));
}

function log(message, level = '') {
  const box = $('txLog');
  if (box.querySelector('.log-empty')) box.textContent = '';
  const time = new Date().toISOString().slice(11, 19);
  box.append(el('span', { class: level, text: `[${time}] ${message}\n` }));
  box.scrollTop = box.scrollHeight;
}

/**
 * One place that turns a failure payload into something an operator can read.
 *
 * The API layer answers with {error: {code, message, details}} everywhere now,
 * so the console reads the code and the message from the envelope instead of
 * printing an object. A failure that reaches a human as "[object Object]" is a
 * failure an operator cannot act on.
 */
function failureCode(payload) {
  if (!payload) return null;
  if (payload.error && typeof payload.error === 'object') return payload.error.code || null;
  return payload.error || null;
}

function failureText(payload) {
  if (!payload) return 'no answer';
  if (payload.error && typeof payload.error === 'object') {
    const { code, message } = payload.error;
    return message ? `${code}: ${message}` : String(code);
  }
  return payload.error || payload.raw || JSON.stringify(payload).slice(0, 160);
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


// --------------------------------------------------------------- the lattice
// The page background is the source chain: one cube per block at its own 60px
// size. This lights up the cube under the pointer with a 4px frame. The frame
// element sits below every surface in the document, so the black band and the
// cards hide it on their own; the only reason this listens for the pointer at
// all is to keep the work off the layout thread.
// The tile is 60x60 and it is meant to be read as pixels, not as a picture that
// happens to be pixel-sized: one asset pixel per *screen* pixel. On a 2x display
// that is a 30px cell in CSS terms, which is exactly what an image viewer at
// 100% zoom would show. Nothing is ever enlarged.
const TILE_PX = 60;
const FRAME_PX = 4;

// One asset pixel per screen pixel, always. The cell and the ring are the
// tile divided by the device pixel ratio, never multiplied - a 2x display
// gets a 30px cell that still lands on 60 physical pixels.
function sizeLattice() {
  const dpr = window.devicePixelRatio || 1;
  const root = document.documentElement;
  root.style.setProperty('--cell', `${TILE_PX / dpr}px`);
  root.style.setProperty('--ring', `${FRAME_PX / dpr}px`);
  return TILE_PX / dpr;
}

// The background is not a wallpaper: every cube is its own element on a
// coded grid, one element per block of the source chain, each carrying the
// submitted tile at the tile's own size.
//
// The frame is painted from pointer tracking rather than from the cube's own
// :hover, and that is a correction rather than a preference. The lattice is
// painted behind the page (z-index: -1), so every wrapper above it - the
// section, the shell, the body - wins the browser's hit test, and a :hover on
// the cube could never fire anywhere on the live page. What is tracked here is
// the rule the design actually asks for: the frame appears on the cube under
// the pointer, and only where that cube is visible - a strip, a card, the
// wallet band, the header, the footer or a dialog all hide it again.
const LATTICE_BLOCKERS = [
  'header.top',
  'footer',
  'nav.foot-nav',
  'dialog',
  '.boundary',
  '.hero-panel',
  '.band',
  '.card',
  '.steps',
  '.lane',
  '.log-wrap',
  'main > section.strip > .shell > *',
];

function cubeUnderPointer(stack) {
  const at = stack.findIndex((node) => node.classList && node.classList.contains('cube'));
  if (at === -1) return null;
  const hidden = stack
    .slice(0, at)
    .some((node) => node.matches && LATTICE_BLOCKERS.some((selector) => node.matches(selector)));
  return hidden ? null : stack[at];
}

function initLatticeFrame() {
  const wall = $('cubeLattice');
  if (!wall || typeof document.elementsFromPoint !== 'function') return;
  let framed = null;
  let queued = false;
  let x = 0;
  let y = 0;
  const clear = () => {
    if (!framed) return;
    framed.classList.remove('frame');
    framed = null;
  };
  const paint = () => {
    queued = false;
    const cube = cubeUnderPointer(document.elementsFromPoint(x, y));
    if (cube === framed) return;
    clear();
    if (cube) {
      cube.classList.add('frame');
      framed = cube;
    }
  };
  window.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return;
      x = event.clientX;
      y = event.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    },
    { passive: true }
  );
  window.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
  window.addEventListener('scroll', clear, { passive: true });
  window.addEventListener('resize', clear, { passive: true });
}

function buildLattice() {
  const wall = $('cubeLattice');
  if (!wall) return;
  const cell = sizeLattice();
  const cols = Math.max(1, Math.ceil(window.innerWidth / cell));
  const rows = Math.max(1, Math.ceil(window.innerHeight / cell));
  const wanted = Math.min(cols * rows, 6000);
  if (buildLattice.wanted === wanted) return;
  buildLattice.wanted = wanted;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < wanted; i += 1) {
    const cube = document.createElement('div');
    cube.className = 'cube';
    frag.append(cube);
  }
  wall.textContent = '';
  wall.append(frag);
}

let latticeQueued = false;
function queueLattice() {
  if (latticeQueued) return;
  latticeQueued = true;
  requestAnimationFrame(() => {
    latticeQueued = false;
    buildLattice();
  });
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

// Stellar amounts arrive with seven decimals (40.8000003). The face of the
// page shows a rounded reading; the exact value stays one hover away, in the
// cell's title, and in the receipt detail.
function fmtAmount(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) {
    return { ui: String(raw ?? '-'), full: String(raw ?? '-') };
  }
  return {
    ui: n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    full: String(raw),
  };
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
    ['The ZK lanes are two bounded machines and two statement proofs — and the bounds are the point.', 'The execution lane proves a committed program running step by step on a machine with eleven opcodes, eight registers and sixteen memory words inside a twenty-row budget; the gate-vm lane proves a committed program on a second, field-native machine whose instructions can hash, inside an eight-row window, with a 32-row sibling compiled from the same core. The other two lanes prove a quorum of approval bits bound to three roots, and a chained state transition. Every bound is stated where it applies: the window is the gas, so programs that do not halt inside it have no proof here; the trusted setup is a local ceremony until a public transcript can be imported and audited (the buckets are currently AccessDenied, and the door in setup.sh says so); and no statement lane or machine lane moves the settlement anchor, because none of them verifies a signature.'],
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
    ['registry initialize', receipts.registry_initialize, null],
    ['register_domain', receipts.register_domain, null],
    ['set_bls_policy', receipts.set_bls_policy, 'BLS'],
    ['admit_domain', receipts.admit_domain, null],
    ['renounce_admin (registry)', receipts.renounce_admin, null],
    ['renounce_admin (gateway)', receipts.gateway_renounce_admin, null],
    ['finality accepted, height 91', receipts.bls_finality_accepted_height_91, 'BLS'],
    ['finality accepted, height 91', receipts.zk_finality_accepted_height_91, 'ZK'],
    ['forward mint', receipts.forward_mint_height_32 || receipts['forward_mint'], 'BLS'],
    ['reverse burn', receipts.burn_and_relay, null],
    ['console round trip: BLS anchor', receipts.registry_bls_accepted_height_1_console_run, 'BLS'],
    ['console round trip: mint 1 of 3', receipts.console_mint_1_of_3, null],
    ['console round trip: mint 2 of 3', receipts.console_mint_2_of_3, null],
    ['console round trip: mint 3 of 3', receipts.console_mint_3_of_3, null],
  ].filter(([, hash]) => hash);
  if (status.gasless?.transaction) named.push(['gasless mint, zero-XLM recipient', status.gasless.transaction]);
  if (named.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '2', class: 'muted', text: 'no receipts recorded' })]));
    return;
  }
  for (const [label, hash, method] of named) {
    const labelCell = el('td');
    if (method) labelCell.append(el('span', { class: `lane-chip ${method.toLowerCase()}`, text: method }), document.createTextNode(' '));
    labelCell.append(document.createTextNode(label));
    body.append(el('tr', {}, [labelCell, el('td', {}, [txLink(hash)])]));
  }
}

function renderFindings(status) {
  const list = $('findingsList');
  const findings = status.findings || [];
  list.textContent = '';
  $('findingsCount').textContent = `${findings.length} recorded`;
  $('findingsSummary').textContent = findings.length === 0
    ? 'Nothing is recorded, which for a build this size usually means nobody looked.'
    : 'A build with no recorded defects is a build where nobody looked. These are the real ones, kept in the deployment manifest instead of edited out of it.';
  for (const finding of findings) {
    const block = el('div', { class: 'finding' });
    block.append(el('span', { class: 'id', text: finding.id }));
    block.append(el('p', { text: finding.found }));
    block.append(el('p', {}, [el('b', { text: 'Fix. ' }), document.createTextNode(finding.fix)]));
    list.append(block);
  }
}

function relTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return 'at an unknown time';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function paintAuditBadge() {
  const stamp = state.auditLatest;
  if (!stamp) return;
  $('auditBadge').textContent = `Self-audit: ${stamp.result}`;
  $('auditBadgeSub').textContent = `${stamp.rounds} round(s) recorded - latest ${relTime(stamp.finishedAt)}`;
  $('auditBadgeDot').className = `dot ${stamp.allPassed ? 'ok' : 'bad'}`;
}

function renderAudit(audit) {
  state.auditLatest = {
    result: audit?.result || (audit?.latest ? `${audit.latest.checks_passed}/${audit.latest.checks_total}` : '-'),
    allPassed: Boolean(audit?.all_passed ?? audit?.latest?.all_passed),
    finishedAt: audit?.last_check || audit?.latest?.finished_at || null,
    rounds: audit?.rounds_recorded ?? (Array.isArray(audit?.history) ? audit.history.length : 0),
  };
  paintAuditBadge();
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
    // Two lengths, the same way the live pill speaks: the full sentence where
    // there is room for it, a short one where there is not. A header that
    // overflows on a phone is the cheapest way to look broken.
    $('netPill').textContent = '';
    $('netPill').title = 'API unavailable - static addresses only';
    $('netPill').append(
      el('span', { class: 'dot bad' }),
      el('span', { class: 'net-long', text: 'API unavailable - static addresses only' }),
      el('span', { class: 'net-short', text: 'no API' })
    );
    log(`Live status request failed (${failureText(payload)}). Addresses below come from the generated deployment module.`, 'warn');
    try {
      const { deployment } = await import('./deployment.js');
      renderDeployment({
        contracts: { registry: deployment.registryId, gateway: deployment.gatewayId, wrapped_asset: deployment.tokenId, asset: 'wSRC' },
        domain: { key: deployment.sourceDomainKey },
      });
      setStat('statRegistry', 'statRegistrySub', deployment.registryId, 'static manifest', true);
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

  setStat('statRegistry', 'statRegistrySub', payload.contracts?.registry || '-', `read live at ledger ${payload.chain?.latest_ledger ?? '?'}`, true);
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
  $('settleBtn').title = relayReady ? (state.lock ? '' : 'Lock something first: settlement settles a specific lock.') : 'No operator URL and token are configured here, so this deployment cannot relay.';

  const sourceReady = Boolean(payload.capabilities?.source_chain?.configured);
  $('sourceNote').textContent = sourceReady
    ? 'Source adapter configured. Locks created here become real events on the simulated source chain, with real BLS evidence behind them.'
    : 'No source adapter is configured on this deployment, so this button is disabled rather than pretending to work.';
  $('lockBtn').disabled = !sourceReady;
  $('lockBtn').title = sourceReady ? '' : 'No source adapter is configured on this deployment. Locking is disabled on purpose.';

  paintWriteState();
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
    kv.append(el('dt', { text: 'Error' }), el('dd', { text: failureText(payload) }));
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

// ------------------------------------------------------- trust evidence
// The renounce hashes live in the deployment manifest that ships with the
// page, so this panel works even with no API layer at all - the same file the
// postbuild copies into dist/deployments.
async function loadTrustEvidence() {
  try {
    const manifest = await (await fetch('deployments/testnet.json')).json();
    const receipts = manifest.receipts || {};
    for (const [id, hash] of [
      ['renounceRegistry', receipts.renounce_admin],
      ['renounceGateway', receipts.gateway_renounce_admin],
    ]) {
      const anchor = $(id);
      if (!anchor) continue;
      if (!hash) {
        anchor.textContent = 'not recorded in this manifest';
        anchor.removeAttribute('href');
        continue;
      }
      // The hash is written in full, and it opens the transaction itself.
      anchor.textContent = hash;
      anchor.href = `${EXPLORER_TX}${hash}`;
    }
  } catch (error) {
    log(`Trust evidence could not be read: ${error && error.message ? error.message : error}`, 'warn');
    for (const id of ['renounceRegistry', 'renounceGateway']) {
      const anchor = $(id);
      if (anchor) anchor.textContent = 'unavailable in this build';
    }
  }
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
    const pub = typeof access === 'string' ? access : access && access.address;
    if (!pub) {
      // Newer Freighter builds resolve with { error } on a refusal instead of
      // throwing. Say that out loud instead of rendering "undefined" as an
      // address, which used to read as a broken connection.
      const why = access && access.error ? String(access.error) : 'the popup was closed without an approval';
      $('walletNote').textContent = `Freighter did not share an address: ${why}`;
      log(`Wallet connection was not approved: ${why}`, 'warn');
      return null;
    }
    state.wallet = pub;
    $('walletChip').textContent = short(pub, 6);
    $('connectBtn').textContent = 'Reconnect';
    log(`Wallet connected: ${pub}`, 'ok');
    // An advisory network check: a wallet pointed at Mainnet can still be
    // read here, but every signature it makes would be for the wrong
    // passphrase, and the failure would only surface much later.
    if (freighter.getNetwork) {
      try {
        const net = await freighter.getNetwork();
        const name = typeof net === 'string' ? net : net && net.network;
        if (name && String(name).toUpperCase() !== 'TESTNET') {
          $('walletNote').textContent = `Connected, but Freighter is set to ${name}. Switch the wallet to Testnet before burning.`;
          log(`Freighter is on ${name}, not Testnet: receiving still works, switch before you burn.`, 'warn');
        }
      } catch (networkError) {
        // Some Freighter versions refuse getNetwork until they are unlocked;
        // the hint is advisory, so a refusal here stays silent.
      }
    }
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
    const row = (label, unit, value, cls, title) => {
      const tr = el('tr');
      const left = el('td', {}, [document.createTextNode(label)]);
      if (unit) left.append(el('span', { class: 'unit', text: unit }));
      const right = el('td', { text: value });
      if (cls) right.className = cls;
      if (title) right.title = `exact: ${title}`;
      tr.append(left, right);
      return tr;
    };
    const xlm = fmtAmount(native && native.balance);
    const spend = fmtAmount(spendable);
    body.append(row('XLM', '', native ? xlm.ui : '-', null, native ? xlm.full : null));
    body.append(row('Spendable XLM', 'after reserve', spendable !== null ? spend.ui : '-', Number(spendable) > 0 ? 'ok' : 'warn', spendable !== null ? spend.full : null));
    const wrappedAmount = wrapped ? fmtAmount(wrapped.balance) : null;
    body.append(row(asset, 'wrapped asset', wrappedAmount ? wrappedAmount.ui : `no trustline for ${asset}`, wrapped ? '' : 'warn', wrappedAmount ? wrappedAmount.full : null));

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

// ------------------------------------------------------------------ amounts
// Amounts travel as base units because that is what the contracts take. Nobody
// reads 137000000 as 13.7, so every amount field carries its own translation.
const ASSET_DECIMALS = 7;

function formatUnits(value) {
  const [whole, fraction] = (value / 10 ** ASSET_DECIMALS).toFixed(ASSET_DECIMALS).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function amountHint(inputId, hintId, tail) {
  const input = $(inputId);
  const hint = $(hintId);
  const paint = () => {
    const raw = input.value.trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      hint.textContent = 'a positive whole number of base units';
      hint.dataset.state = 'warn';
      return;
    }
    hint.dataset.state = '';
    hint.textContent = `= ${formatUnits(value)} wSRC ${tail}`;
  };
  input.addEventListener('input', paint);
  paint();
}

function wireAmounts() {
  amountHint('lockAmount', 'lockAmountHint', 'minted, minus the relayer fee');
  amountHint('burnAmount', 'burnAmountHint', 'burned from your own balance');
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
    log(`Lock refused: ${failureText(payload)}`, 'bad');
    if (failureCode(payload) === 'writes_disabled' || failureCode(payload) === 'unauthorized') {
      log('Open Operator in the header and set the token, then try again.', 'warn');
    }
    if (failureCode(payload) === 'source_unreachable') {
      log('The source adapter is not reachable from this deployment. That is a configuration state, not a chain failure.', 'warn');
    }
    return;
  }
  const event = payload.event || payload.events?.[0];
  state.lock = { height: event?.height ?? payload.block_height, event, events: payload.events || [] };
  step('lock', 'done', `lock observed at source height ${state.lock.height}`);
  $('runStatus').textContent = `locked ${state.lock.events?.length || 1} event(s) at source height ${state.lock.height}`;
  log(`Locked. message_id ${event?.message_id}\n  nonce ${event?.nonce} - payload_hash ${event?.payload_hash}\n  ${payload.events?.length || 1} event(s) in block ${payload.block_height}, expiry height ${event?.expiry_height}`, 'ok');
  $('settleBtn').disabled = !state.status?.capabilities?.operator_relay?.enabled;
  await showProof(state.lock.height);
}

async function showProof(height) {
  step('finality', 'active', 'reading the finality evidence for this height');
  const { ok, payload } = await api(`/api/source?path=${encodeURIComponent(`/proof?height=${height}&kind=bls`)}`);
  if (!ok) {
    step('finality', 'idle');
    log(`Finality evidence unavailable: ${failureText(payload)}`, 'bad');
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
    log(`Relay refused (${failureCode(payload) || 'error'}): ${failureText(payload)}`, 'warn');
    step('finality', 'idle', 'the relayer pass did not complete; finality was not anchored');
    $('settleBtn').disabled = false;
    return;
  }
  if (payload.error) log(`The relayer did not run: ${failureText(payload)}`, 'bad');
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
    $('runStatus').textContent = `pass finished: ${receipts.length} transaction(s) confirmed on Stellar`;
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
    // The bytes that go to the network are the ones Freighter signed, never
    // the still-unsigned prepared transaction: sending `prepared` here would
    // be refused with tx_bad_auth and the burn would look like a wallet bug.
    const submitted = await module.submitSoroban(xdr);
    if (submitted && submitted.status && submitted.status !== 'PENDING' && submitted.status !== 'SUCCESS') {
      throw new Error(`the RPC refused the submission: ${submitted.errorResult ? JSON.stringify(submitted.errorResult) : submitted.status}`);
    }
    log(`Submitted: ${submitted.hash || JSON.stringify(submitted).slice(0, 300)}`, 'ok');
    await refreshWallet();
  } catch (error) {
    log(`Burn failed: ${error && error.message ? error.message : error}`, 'bad');
    log('The outbound direction needs the gateway burn entrypoint signed by your own key. If Freighter is not installed, the README documents the CLI path.', 'warn');
  }
}

// -------------------------------------------------------------- operator
// Every surface that reports whether this tab may write reads from one place,
// and it repaints the moment the token changes instead of waiting for the next
// status poll to notice.
// Every async action parks its button in a visible pending state, so a slow
// RPC round trip never reads as a frozen page.
async function withBusy(btn, fn) {
  if (!btn || btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } finally {
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
  }
}

function paintWriteState() {
  const set = Boolean(state.operatorToken);
  $('operatorHint').textContent = set ? 'writes: token set for this tab' : 'writes: no operator token yet';
  $('operatorHintBtn').hidden = set;
  $('opState').textContent = set ? 'A token is set for this tab.' : 'No token set: writes will be refused.';
}

function operatorDialog() {
  const dialog = $('operatorDialog');
  $('opToken').value = state.operatorToken;
  $('opState').textContent = state.operatorToken
    ? 'A token is set for this tab. Saving replaces it.'
    : 'No token set: writes will be refused.';
  dialog.showModal();
  // Put the caret in the field the dialog exists for, so a keyboard user does
  // not have to tab through the toolbar to reach it.
  $('opToken').focus();
  $('opToken').select();
  // Wherever the dialog is dismissed from, focus returns to the button that
  // opened it: a dialog that closes into nowhere loses the reader's place.
  dialog.addEventListener('close', restoreOperatorFocus, { once: true });
}

function restoreOperatorFocus() {
  if ($('operatorBtn') && !$('operatorBtn').hidden) {
    $('operatorBtn').focus();
  } else if ($('operatorHintBtn')) {
    $('operatorHintBtn').focus();
  }
}

function showTab(which) {
  const panes = { inbound: 'paneInbound', outbound: 'paneOutbound', cashout: 'paneCashout' };
  for (const [name, pane] of Object.entries(panes)) {
    const selected = name === which;
    $(`tab${name[0].toUpperCase()}${name.slice(1)}`).setAttribute('aria-selected', String(selected));
    $(pane).classList.toggle('hidden', !selected);
  }
}


// ------------------------------------------------- cash out to a local currency
// This panel drives a real SEP-6 anchor from the browser. Nothing here is a
// mock: discovery, the SEP-10 challenge, the firm quote, the withdrawal
// instructions and the status poll all travel to the anchor, and the payment is
// signed by the user's own Freighter key.
//
// The one thing worth reading carefully is `X-Anchor-Token`. The anchor's token
// is the *user's* credential for the external anchor. It is deliberately not the
// operator token this facade uses for its own writes: an operator is not the
// user, and an operator must not be able to open a withdrawal on somebody
// else's behalf.
const CASHOUT = {
  anchorToken: null,
  transactionId: null,
  instructions: null,
  anchor: null,
};

async function cashoutApi(query, { method = 'GET', body, anchorToken = null } = {}) {
  // Through /api/cashout rather than straight at the facade: the browser never
  // has to reach a host the page does not control, and the deployment can say
  // honestly that the exit is unavailable instead of failing with a network
  // error. The anchor's own token is passed through untouched.
  const headers = { 'Content-Type': 'application/json' };
  if (anchorToken) headers['X-Anchor-Token'] = anchorToken;
  const response = await fetch(`/api/cashout${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, payload };
}

function cashoutPaintInstructions(instructions) {
  const rows = instructions
    ? [
        ['treasury', short(instructions.treasury, 8)],
        ['memo', `${instructions.memo} (${instructions.memo_type})`],
        ['amount', `${instructions.amount} ${instructions.asset_code}`],
        ['transaction', instructions.transaction_id],
      ]
    : [['treasury', 'not opened yet']];
  // Built as nodes rather than as an HTML string: these values come from an
  // external anchor, and interpolating an external string into markup is how a
  // page ends up rendering somebody else's tags.
  const container = $('cashoutInstructions');
  container.textContent = '';
  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const left = document.createElement('span');
    left.textContent = key;
    const right = document.createElement('span');
    right.className = 'mono';
    right.textContent = String(value);
    row.append(left, right);
    container.append(row);
  }
  $('cashoutPayBtn').disabled = !instructions;
  $('cashoutStatusBtn').disabled = !CASHOUT.transactionId;
  if (instructions && instructions.extra_info && instructions.extra_info.message) {
    $('cashoutPayHint').textContent = instructions.extra_info.message;
  }
}

async function cashoutReadAnchor() {
  const result = await cashoutApi('?action=anchor');
  if (!result.ok) return log(`Anchor unreachable: ${failureText(result.payload)}`, 'bad');
  CASHOUT.anchor = result.payload.anchor;
  $('cashoutAnchorChip').textContent = result.payload.anchor.home_domain;
  const usdc = result.payload.anchor.usdc || {};
  log(`Anchor ${result.payload.anchor.home_domain}: auth ${result.payload.anchor.web_auth_endpoint}, transfer ${result.payload.anchor.transfer_server}`, 'ok');
  log(`It exits ${usdc.code || 'the asset'} issued by ${short(usdc.issuer || 'unknown', 8)}; ${result.payload.withdraw}.`, '');

  const amount = ($('cashoutAmount').value || '').trim();
  const quote = await cashoutApi(`?action=bridge&amount=${encodeURIComponent(amount || '1')}`);
  if (quote.ok) {
    if (quote.payload.route === 'order_book') {
      log(`Bridge: a real market route exists (${quote.payload.detail.slice(0, 120)}).`, 'ok');
    } else {
      log(`Bridge: ${quote.payload.detail}`, 'warn');
    }
  }
  return result.payload;
}

async function cashoutAuthenticate() {
  if (!state.wallet) {
    const address = await connectWallet();
    if (!address) return null;
  }
  const challenge = await cashoutApi(`?action=challenge&account=${encodeURIComponent(state.wallet)}`);
  if (!challenge.ok) {
    log(`No challenge: ${failureText(challenge.payload)}`, 'bad');
    return null;
  }
  const freighter = window.freighterApi || window.freighter;
  if (!freighter) {
    log('Freighter is required to sign the anchor challenge.', 'bad');
    return null;
  }
  try {
    const module = await import('./soroban.ts');
    const signed = await module.signAnchorChallenge(challenge.payload.transaction, state.wallet);
    const token = await cashoutApi('?action=token', { method: 'POST', body: { transaction: signed } });
    if (!token.ok) {
      log(`The anchor refused the signed challenge: ${failureText(token.payload)}`, 'bad');
      return null;
    }
    CASHOUT.anchorToken = token.payload.token;
    $('cashoutAuthChip').textContent = `session for ${short(state.wallet, 4)}`;
    log('Authenticated with the anchor. The token lives in this tab only.', 'ok');
    return CASHOUT.anchorToken;
  } catch (error) {
    log(`Authentication failed: ${error && error.message ? error.message : error}`, 'bad');
    return null;
  }
}

async function cashoutStart() {
  if (!CASHOUT.anchorToken && !(await cashoutAuthenticate())) return;
  const amount = ($('cashoutAmount').value || '').trim();
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) return log('Amount must be a positive decimal with at most 7 places.', 'bad');
  const result = await cashoutApi('?action=start', {
    method: 'POST',
    anchorToken: CASHOUT.anchorToken,
    body: { amount, account: state.wallet },
  });
  if (!result.ok) {
    if (result.status === 401 && CASHOUT.anchorToken) {
      CASHOUT.anchorToken = null;
      $('cashoutAuthChip').textContent = 'session expired';
    }
    return log(`The anchor did not open a withdrawal: ${failureText(result.payload)}`, 'bad');
  }
  CASHOUT.instructions = result.payload;
  CASHOUT.transactionId = result.payload.transaction_id;
  cashoutPaintInstructions(result.payload);
  log(`Withdrawal ${result.payload.transaction_id} is open: pay ${result.payload.amount} ${result.payload.asset_code} to ${short(result.payload.treasury, 8)} with memo ${result.payload.memo}.`, 'ok');
}

async function cashoutPay() {
  if (!CASHOUT.instructions) return log('Open the withdrawal first.', 'warn');
  if (!state.wallet) {
    const address = await connectWallet();
    if (!address) return;
  }
  try {
    const module = await import('./soroban.ts');
    const prepared = await module.buildAnchorPaymentTx(
      CASHOUT.instructions.treasury,
      CASHOUT.instructions.amount,
      CASHOUT.instructions.asset_issuer,
      CASHOUT.instructions.memo,
      state.wallet
    );
    const freighter = window.freighterApi || window.freighter;
    const signed = await freighter.signTransaction(prepared.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address: state.wallet });
    const xdr = typeof signed === 'string' ? signed : signed.signedTxXdr;
    if (!xdr) throw new Error('Freighter returned no signed transaction');
    const submitted = await module.submitClassic(xdr);
    log(`Paid the anchor: ${submitted}. The anchor identifies the deposit by the memo, so it will now match this withdrawal.`, 'ok');
    await refreshWallet();
  } catch (error) {
    log(`Payment failed: ${error && error.message ? error.message : error}`, 'bad');
  }
}

async function cashoutStatus() {
  if (!CASHOUT.transactionId) return;
  const result = await cashoutApi(`?action=status&id=${encodeURIComponent(CASHOUT.transactionId)}`, {
    anchorToken: CASHOUT.anchorToken,
  });
  if (!result.ok) return log(`Status check failed: ${failureText(result.payload)}`, 'bad');
  const payload = result.payload;
  log(`Anchor reports ${payload.status}${payload.amount_out ? `, paid out ${payload.amount_out}` : ''}${payload.external_transaction_id ? `, reference ${payload.external_transaction_id}` : ''}.`, payload.status === 'completed' ? 'ok' : '');
}

function wire() {
  $('lockBtn').addEventListener('click', () => withBusy($('lockBtn'), () => lock().catch((error) => log(String(error), 'bad'))));
  $('settleBtn').addEventListener('click', () => withBusy($('settleBtn'), () => settle().catch((error) => log(String(error), 'bad'))));
  $('copyCmdBtn').addEventListener('click', () => copyCommand());
  $('clearLogBtn').addEventListener('click', () => showLogPlaceholder());
  $('operatorHintBtn').addEventListener('click', operatorDialog);
  window.addEventListener('resize', queueLattice);
  wireAmounts();
  $('demoRecipientBtn').addEventListener('click', () => {
    const demo = state.status?.accounts?.gasless_recipient || state.status?.accounts?.end_user;
    if (!demo) {
      log('The manifest in this deployment carries no demo account to fill in.', 'warn');
      return;
    }
    $('lockRecipient').value = demo;
    log(`Recipient set to the manifest's demo account ${demo}.`, 'info');
  });
  $('useWalletBtn').addEventListener('click', () => withBusy($('useWalletBtn'), async () => {
    const pub = state.wallet || (await connectWallet());
    if (pub) $('lockRecipient').value = pub;
  }));
  $('connectBtn').addEventListener('click', () => withBusy($('connectBtn'), () => connectWallet()));
  $('balanceBtn').addEventListener('click', () => withBusy($('balanceBtn'), () => refreshWallet()));
  $('walletLink').addEventListener('click', () => {});
  $('burnBtn').addEventListener('click', () => withBusy($('burnBtn'), () => burn()));
  $('queryBtn').addEventListener('click', () => withBusy($('queryBtn'), () => queryFinality($('heightQuery').value.trim())));
  $('heightQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') queryFinality($('heightQuery').value.trim());
  });
  $('tabInbound').addEventListener('click', () => showTab('inbound'));
  $('tabOutbound').addEventListener('click', () => showTab('outbound'));
  $('tabCashout').addEventListener('click', () => showTab('cashout'));
  $('cashoutQuoteBtn').addEventListener('click', () => withBusy($('cashoutQuoteBtn'), () => cashoutReadAnchor().catch((error) => log(String(error), 'bad'))));
  $('cashoutAuthBtn').addEventListener('click', () => withBusy($('cashoutAuthBtn'), () => cashoutAuthenticate().catch((error) => log(String(error), 'bad'))));
  $('cashoutStartBtn').addEventListener('click', () => withBusy($('cashoutStartBtn'), () => cashoutStart().catch((error) => log(String(error), 'bad'))));
  $('cashoutPayBtn').addEventListener('click', () => withBusy($('cashoutPayBtn'), () => cashoutPay().catch((error) => log(String(error), 'bad'))));
  $('cashoutStatusBtn').addEventListener('click', () => withBusy($('cashoutStatusBtn'), () => cashoutStatus().catch((error) => log(String(error), 'bad'))));
  $('operatorBtn').addEventListener('click', operatorDialog);
  $('opSave').addEventListener('click', () => {
    state.operatorToken = $('opToken').value.trim();
    const persisted = store.set('lumen.operatorToken', state.operatorToken);
    if (!persisted) log('The browser refused session storage, so the token is kept in memory for this page only.', 'warn');
    paintWriteState();
    log(state.operatorToken ? 'Operator token set for this tab. Writes will carry it from now on.' : 'Token cleared: this tab is read-only again.');
    $('operatorDialog').close();
    loadStatus();
  });
  $('opClear').addEventListener('click', () => {
    state.operatorToken = '';
    store.clear('lumen.operatorToken');
    $('opToken').value = '';
    paintWriteState();
    log('Token cleared: this tab is read-only again.');
    // Clearing is a completed action, so the dialog closes and the reader lands
    // back on the control they came from instead of on an empty form.
    $('operatorDialog').close();
    loadStatus();
  });
  $('opClose').addEventListener('click', () => $('operatorDialog').close());
}

// --- the read-only receipts card ---------------------------------------------------
// Rendered entirely from the generated deployment module, which is generated from
// the receipts in deployments/*.json. No fetch, no signer, no network: the facts
// this card can show are exactly the facts the repository wrote down, so an
// outage cannot change it and a live answer cannot flatter it.
async function renderLanes() {
  const kv = $('lanesKv');
  if (!kv) return;
  kv.textContent = '';
  let lanes = null;
  try {
    ({ lanes } = await import('./deployment.js'));
  } catch {
    /* the fallback row below is the honest state of a missing module */
  }
  if (!lanes) {
    kv.append(el('dt', { text: 'Receipts' }), el('dd', { text: 'no lanes block in the generated module: run node tools/sync-frontend-deployment.mjs' }));
    return;
  }
  const DASH = ' —';
  const row = (label, nodes) => {
    kv.append(el('dt', { text: label }));
    kv.append(el('dd', {}, nodes));
  };
  const faint = (text) => el('span', { class: 'faint', text });
  const contractLink = (id) =>
    el('a', { class: 'explorer', href: EXPLORER_CONTRACT + id, target: '_blank', rel: 'noreferrer', text: `registry ${short(id, 6)}` });
  const audit = lanes.last_audit;
  row('Audit loop', [
    document.createTextNode(
      audit
        ? `round ${audit.round}: ${audit.passed}/${audit.total} ${audit.all_passed ? 'passed' : 'FAILED — the record says so'}`
        : 'no round recorded'
    ),
    audit?.finished_at ? faint(`  ·  ${audit.finished_at}`) : null,
  ].filter(Boolean));
  const merged = lanes.merged_registry;
  if (merged?.contract_id) {
    row('Merged registry', [
      contractLink(merged.contract_id),
      faint(
        merged.all_lanes_passed
          ? `   all lanes passed on one contract (${Object.entries(merged.lane_suites || {})
              .map(([lane, facts]) => `${lane} ${facts.passed}/${facts.checks}`)
              .join(', ')})`
          : '   the merged receipt reports failures; open the record'
      ),
    ]);
  }
  const laneRows = [
    ['Settlement lane', lanes.settlement, true],
    ['Step-chain lane', lanes.step_chain, false],
    ['Execution lane', lanes.execution, false],
    ['Gate-vm lane', lanes.gate_vm, false],
    ['Gate-vm32 lane', { ...lanes.gate_vm32, registry: lanes.gate_vm32?.registry, checks: undefined }, false],
  ];
  for (const [label, facts, isSettlement] of laneRows) {
    if (!facts || (facts.recorded === false && !isSettlement)) continue;
    const tail = [
      facts.checks ? faint(`checks ${facts.checks}`) : null,
      faint(
        isSettlement
          ? ` ·  admin ${facts.admin_state || 'state not recorded'}`
          : ` ·  ledger ${facts.ledger || DASH.replace(' —', '—')} · ${facts.fee_stroops ? `${facts.fee_stroops} stroops` : '—'}`
      ),
    ].filter(Boolean);
    row(label, [
      facts.registry ? contractLink(facts.registry) : faint('no registry id'),
      facts.honest_transaction
        ? el('span', {}, [document.createTextNode('  ·  accepted by '), txLink(facts.honest_transaction)])
        : null,
      ...tail,
    ].filter(Boolean));
  }
}

renderLanes().catch(() => {});
wire();
watchSections();
buildLattice();
initLatticeFrame();
resetSteps();
showLogPlaceholder();
loadTrustEvidence();
setInterval(paintAuditBadge, 30000);
setInterval(() => {
  loadStatus().then((status) => (status ? loadAuditHistory() : null)).catch(() => {});
}, 300000);
loadStatus()
  .then(async (status) => {
    if (!status) return null;
    await loadAuditHistory();
    return queryFinality('');
  })
  .catch((error) => log(`Startup failed: ${error}`, 'bad'));
