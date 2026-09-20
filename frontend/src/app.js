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
  walletSource: null,
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
// The lattice is not a carpet of interactive elements: the wall is built one
// element per *pitch*, and the pitch opens up with the screen while the tile
// itself never changes size. The pointer can still only ever frame one cube,
// which is the part of the design that is about blocks; the number of elements
// is the part that is about cost, and this is where that cost is decided.
function sizeLattice() {
  const dpr = window.devicePixelRatio || 1;
  const root = document.documentElement;
  // The wall is contiguous: the tile's own 60px is the only rhythm, and every
  // cube on the screen is a real element at the tile's own size. Sparsifying
  // the grid once saved elements nobody missed and broke the artwork's
  // cadence - isolated flowers floating in black read as giant cubes instead
  // of a lattice, which is exactly what the operator asked to remove.
  const stride = 1;
  const cell = TILE_PX / dpr;
  const pitch = cell * stride;
  root.style.setProperty('--cell', `${cell}px`);
  root.style.setProperty('--stride', String(stride));
  root.style.setProperty('--pitch', `${pitch}px`);
  root.style.setProperty('--ring', `${FRAME_PX / dpr}px`);
  // The caller wants the cadence: how far apart the elements sit, not how big
  // the tile inside them is.
  return pitch;
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
// The first area is not on this list, and that is the point of it: it carries
// no strip, so the lattice shows through and the frame can land under the
// hero's own text. A surface belongs here only if it really does cover the
// wall.
// The frame is a state painted on the cube under the pointer, and it lands
// only where the cube is actually visible. Two operator corrections define
// this: detection must not die just because the pointer travels (the cell is
// repainted on scroll and resize, and the hero shows the wall), and the ring
// must never climb on top of the content - a frame above the cards reads as a
// glitch. So the page asks what covers the wall at the pointer, and the cube
// wears the ring only when nothing opaque stands between them.
const LATTICE_BLOCKERS = [
  'header.top',
  'footer',
  'nav.foot-nav',
  'dialog',
  '.boundary',
  '.band',
  '.card',
  '.win',
  '.steps',
  '.stats',
  '.trust-grid',
  '.lane',
  '.log-wrap',
  '.row-strip',
  // the hero banner is opaque artwork: a cube behind it is not a visible cube
  '.hero-banner',
  '.track-box',
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
  let seen = false;
  const clear = () => {
    if (!framed) return;
    framed.classList.remove('frame');
    framed = null;
  };
  const paint = () => {
    queued = false;
    if (!seen) return;
    const cube = cubeUnderPointer(document.elementsFromPoint(x, y));
    if (cube === framed) return;
    clear();
    if (cube) {
      cube.classList.add('frame');
      framed = cube;
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };
  window.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return;
      x = event.clientX;
      y = event.clientY;
      seen = true;
      schedule();
    },
    { passive: true }
  );
  window.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
  // Scrolling moves the page under the fixed wall, so the cube under a still
  // pointer changes: the frame is re-asked rather than left on a cube that is
  // no longer there. Before the first move there is nothing to re-ask.
  window.addEventListener('scroll', () => { if (seen) schedule(); }, { passive: true });
  window.addEventListener('resize', () => { if (seen) schedule(); }, { passive: true });
}

function buildLattice() {
  const wall = $('cubeLattice');
  if (!wall) return;
  const pitch = sizeLattice();
  const cols = Math.max(1, Math.ceil(window.innerWidth / pitch));
  const rows = Math.max(1, Math.ceil(window.innerHeight / pitch));
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

// A closed finding is one line: the id and the first sentence of what went
// wrong, ellipsised. The operator's rule is exact - the list must not lecture
// anybody before they ask: details live behind the door, one door at a time,
// and each door opens on its own without closing its neighbours.
function firstLineOf(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = clean.match(/^[^.!?]*[.!?]/);
  return sentence ? sentence[0] : clean;
}

function renderFindings(status) {
  const list = $('findingsList');
  const findings = status.findings || [];
  list.textContent = '';
  $('findingsCount').textContent = `${findings.length} recorded`;
  $('findingsSummary').textContent = findings.length === 0
    ? 'Nothing is recorded, which for a build this size usually means nobody looked.'
    : 'A build with no recorded defects is a build where nobody looked. These are the real ones, kept in the deployment manifest instead of edited out of it. Each row is one line until you open it.';
  for (const finding of findings) {
    const door = el('details', { class: 'finding' });
    door.append(
      el('summary', {}, [
        el('span', { class: 'id', text: finding.id }),
        el('span', { class: 'first-line', text: firstLineOf(finding.found), title: finding.found }),
        el('span', { class: 'fx', 'aria-hidden': 'true' }),
      ]),
      el('div', { class: 'finding-body' }, [
        el('p', { text: finding.found }),
        el('p', {}, [el('b', { text: 'Fix. ' }), document.createTextNode(finding.fix)]),
      ])
    );
    list.append(door);
  }
}

// --------------------------------------------------------- window panels
// The audit and receipts cards are windows: the bar folds the body, the state
// lives on the window element, and the bar keeps telling the truth about it
// through aria-expanded so a screen reader hears the window shut.
function wireWindows() {
  for (const win of document.querySelectorAll('[data-win]')) {
    const bar = win.querySelector('.win-bar');
    if (!bar) continue;
    bar.addEventListener('click', () => {
      const closed = win.classList.toggle('win-closed');
      bar.setAttribute('aria-expanded', String(!closed));
    });
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
      markUnavailable($('lockBtn'), true);
      markUnavailable($('settleBtn'), true);
      $('sourceNote').textContent = 'No API layer: the source adapter cannot be reached from this build.';
      // The two buttons just went grey, so the notes that explain them and the
      // panel that lists them have to be repainted here as well. Without this
      // the degraded path disabled a control and left the interface panel
      // listing three disabled controls while the page had four - a drift the
      // click-through caught, in the state a visitor is most likely to meet.
      paintDisabledReasons();
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

  renderDeployment(payload);
  renderHonesty(payload);
  renderCapabilities(payload);
  renderReceipts(payload);
  renderFindings(payload);
  renderAudit(payload);

  const recipient = $('lockRecipient');
  if (!recipient.value) recipient.value = payload.accounts?.gasless_recipient || payload.accounts?.end_user || '';

  const relayReady = Boolean(payload.capabilities?.operator_relay?.enabled);
  // Three states, three sentences: the note is what the button's own title is
  // copied from, so a state that is missing here would leave an unavailable
  // button explaining the wrong thing.
  $('settleNote').textContent = !relayReady
    ? 'This deployment cannot relay by itself: no operator URL and token are configured here. Locking still works; use "Copy the command instead" to settle it with the local relayer.'
    : state.lock
      ? 'This deployment can relay: the button runs one relayer pass at the height you locked. The relayer signs and pays.'
      : 'This deployment can relay. Lock a block first: settlement settles one specific lock, so the button unlocks once there is something to settle.';
  markUnavailable($('settleBtn'), !relayReady || !state.lock);

  const sourceReady = Boolean(payload.capabilities?.source_chain?.configured);
  const embedded = Boolean(payload.capabilities?.source_chain?.embedded);
  $('sourceNote').textContent = !sourceReady
    ? 'No source adapter is configured on this deployment (SOURCE_URL is unset server-side), so this button cannot lock anything. Pressing it says exactly this instead of pretending to work.'
    : embedded
      ? 'Lock runs in this process (in-process simulator). Message id and Merkle root are real. BLS is not signed here and mint is not submitted to Stellar without a relayer key.'
      : 'Source adapter configured. Locks created here become real events on the simulated source chain, with real BLS evidence behind them.';
  markUnavailable($('lockBtn'), !sourceReady);

  paintWriteState();
  paintDisabledReasons();
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
/**
 * Every Freighter build since v1 answers a connection request in a slightly
 * different shape, and the reader does not care which one they installed:
 * a bare address string, {address}, {publicKey}, or {error} when the popup was
 * refused. This reads an address out of whatever came back, and says what came
 * back when there is none.
 */
function walletAddressFrom(answer) {
  if (!answer) return null;
  if (typeof answer === 'string') return answer.trim() || null;
  const candidate = answer.address || answer.publicKey || answer.public_key;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function walletReasonFrom(answer) {
  if (!answer || typeof answer === 'string') return null;
  if (answer.error) return String(answer.error.message || answer.error);
  if (answer.message && !walletAddressFrom(answer)) return String(answer.message);
  return null;
}

/**
 * Ask for an address through every door the extension exposes, in order, and
 * keep what each one said. requestAccess() is the modern door; getPublicKey()
 * is what older builds answer; setAllowed() then getPublicKey() is the oldest
 * pair still in the wild. A build that throws from the first may still answer
 * the second, so all of them are tried rather than the first one guessed at.
 */
async function requestWalletAddress(freighter) {
  const attempts = [];
  const doors = [
    ['requestAccess', 'requestAccess', () => freighter.requestAccess()],
    ['getAddress', 'getAddress', () => freighter.getAddress()],
    ['getPublicKey', 'getPublicKey', () => freighter.getPublicKey()],
    ['setAllowed+getPublicKey', 'setAllowed', async () => {
      await freighter.setAllowed();
      return freighter.getPublicKey();
    }],
  ];
  for (const [label, method, open] of doors) {
    if (typeof freighter[method] !== 'function') continue;
    try {
      const answer = await open();
      const address = walletAddressFrom(answer);
      if (address) return { address, via: label, attempts };
      attempts.push(`${label}: ${walletReasonFrom(answer) || 'the extension answered without an address'}`);
    } catch (error) {
      attempts.push(`${label}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  return { address: null, via: null, attempts };
}

// Freighter reaches a page in three shapes depending on its version: the old
// window.freighter, the bundled window.freighterApi, and the SEP-43 registry
// at window.stellar.freighter. An embedded frame gets none of them, because
// extensions inject only into top-level tabs - so saying "not installed" to a
// reader who is holding the wallet inside a preview frame would blame them
// for the frame. The note names the frame instead, and a watcher catches the
// extension when it injects after the page has booted.
// The npm module is the second door, and for recent Freighter builds it is the
// only one. Those versions stopped putting anything on `window`; they speak
// over postMessage to the content script instead. 1.0 only ever looked at
// `window`, so a reader with a perfectly good wallet installed was told it was
// "not installed" and had nothing to click. 2.0 already learned this - the
// same shape is applied here.
//
// The module is loaded lazily so a browser with no wallet at all pays nothing
// for it, and so a failure to load degrades to "no wallet" instead of breaking
// the page.
let officialApi = null;
let officialLoad = null;
async function loadOfficialFreighter() {
  if (officialApi) return officialApi;
  if (!officialLoad) {
    officialLoad = import('@stellar/freighter-api')
      .then((m) => {
        officialApi = {
          isConnected: m.isConnected,
          requestAccess: m.requestAccess,
          getAddress: m.getAddress,
          getNetwork: m.getNetwork,
          signTransaction: m.signTransaction,
          setAllowed: m.setAllowed,
          __official: true,
        };
        return officialApi;
      })
      .catch(() => null);
  }
  return officialLoad;
}

function injectedFreighter() {
  const injected =
    window.freighterApi ||
    window.freighter ||
    (window.stellar && (window.stellar.freighter || window.stellar.Freighter)) ||
    null;
  // A registry entry that cannot be asked for access is not a usable door.
  if (injected && (typeof injected.requestAccess === 'function' || typeof injected.getPublicKey === 'function')) {
    return injected;
  }
  return null;
}

function freighterProvider() {
  return injectedFreighter() || officialApi;
}

/**
 * Is Freighter actually reachable?
 *
 * Injected wins immediately. Otherwise ask the npm module: importing it always
 * succeeds, so the module's presence proves nothing - only isConnected() does,
 * and it is raced against a timeout because without a content script on the
 * other end it never settles.
 */
async function detectFreighter() {
  const injected = injectedFreighter();
  if (injected) return { available: true, api: injected, via: 'injected' };
  const api = await loadOfficialFreighter();
  if (!api) return { available: false, api: null, via: 'none' };
  try {
    const status = await Promise.race([
      api.isConnected(),
      new Promise((resolve) => setTimeout(() => resolve({ isConnected: false, timedOut: true }), 2500)),
    ]);
    const ok = Boolean(status && (status.isConnected === true || status === true));
    return { available: ok, api: ok ? api : null, via: ok ? 'official' : 'none' };
  } catch {
    return { available: false, api: null, via: 'none' };
  }
}
function embeddedFrame() {
  try { return window.top !== window.self; } catch (error) { return true; }
}
function walletAbsenceNote() {
  if (embeddedFrame()) {
    return 'Freighter is not installed or cannot reach this frame: extensions inject only into a top-level tab, and this console is running embedded. Open the page in its own tab to connect; receiving needs no wallet at all.';
  }
  return 'Freighter is not installed in this browser. Receiving does not need a wallet at all; only burning your own tokens does.';
}
let freighterWatch = null;
function watchForFreighter() {
  if (freighterWatch || freighterProvider()) return;
  let tries = 0;
  freighterWatch = setInterval(() => {
    tries += 1;
    if (freighterProvider()) {
      clearInterval(freighterWatch);
      freighterWatch = null;
      log('Freighter appeared after the page booted: Connect is ready now.', 'ok');
      $('walletNote').textContent = 'Freighter detected. Connect to read your own balances and to burn.';
    } else if (tries > 24) {
      clearInterval(freighterWatch);
      freighterWatch = null;
    }
  }, 500);
  // node harnesses boot this module against stubs; a watcher must not hold
  // their event loop open for its whole twelve seconds
  if (freighterWatch && typeof freighterWatch.unref === 'function') freighterWatch.unref();
}

async function connectWallet() {
  // Ask both doors before giving up: injected first, then the npm module.
  // Deciding on `window` alone is what made a wallet that only speaks over
  // postMessage look absent.
  const found = await detectFreighter();
  const freighter = found.api;
  if (!freighter) {
    $('walletNote').textContent = walletAbsenceNote();
    log(walletAbsenceNote(), 'warn');
    watchForFreighter();
    return null;
  }
  try {
    const { address, via, attempts } = await requestWalletAddress(freighter);
    if (!address) {
      // Say which door was tried and what it answered, instead of rendering
      // "undefined" as an address or a generic failure. The last concrete
      // reason is the one a reader can act on.
      const why = attempts.length ? attempts[attempts.length - 1] : 'the extension exposes no way to ask for an address';
      $('walletNote').textContent = `Freighter did not share an address (${why}). Unlock the extension and approve the request, or read the demo account without any wallet.`;
      log(`Wallet connection was not approved: ${why}`, 'warn');
      return null;
    }
    state.wallet = address;
    state.walletSource = 'freighter';
    $('walletChip').textContent = short(address, 6);
    $('connectBtn').textContent = 'Reconnect';
    $('walletKind').textContent = 'connected · Freighter · Stellar testnet';
    log(`Wallet connected via ${found.via}/${via}: ${address}`, 'ok');
    // An advisory network check: a wallet pointed at Mainnet can still be
    // read here, but every signature it makes would be for the wrong
    // passphrase, and the failure would only surface much later.
    if (freighter.getNetwork) {
      try {
        const net = await freighter.getNetwork();
        const name = typeof net === 'string' ? net : net && (net.network || net.networkPassphrase);
        if (name && String(name).toUpperCase() !== 'TESTNET' && String(name).toUpperCase() !== 'TESTNET' && !/test/i.test(String(name))) {
          $('walletNote').textContent = `Connected, but Freighter is set to ${name}. Switch the wallet to Testnet before burning.`;
          log(`Freighter is on ${name}, not Testnet: receiving still works, switch before you burn.`, 'warn');
        }
      } catch (networkError) {
        // Some Freighter versions refuse getNetwork until they are unlocked;
        // the hint is advisory, so a refusal here stays silent.
      }
    }
    await refreshWallet();
    return address;
  } catch (error) {
    log(`Wallet connection failed: ${error && error.message ? error.message : error}`, 'bad');
    return null;
  }
}

function paintWalletKind() {
  if (state.walletSource === 'demo-read-only') {
    $('walletKind').textContent = 'read-only demo view';
    return;
  }
  if (state.wallet && state.walletSource === 'freighter') {
    $('walletKind').textContent = 'connected · Freighter · Stellar testnet';
    return;
  }
  $('walletKind').textContent = 'Stellar testnet · connect Freighter to sign';
}

async function refreshWallet() {
  if (!state.wallet) {
    $('walletNote').textContent = 'Connect Freighter to read your own Stellar testnet balances. You do not need a wallet to receive.';
    paintWalletKind();
    if ($('fundBtn')) $('fundBtn').hidden = true;
    return;
  }
  const horizon = state.status?.chain?.horizon || 'https://horizon-testnet.stellar.org';
  const asset = state.status?.contracts?.asset || 'wSRC';
  try {
    const accountRes = await fetch(`${horizon}/accounts/${state.wallet}`);
    const account = await accountRes.json();
    if (accountRes.status === 404 || account.status === 404) {
      const body = $('walletKv');
      body.textContent = '';
      body.append(el('tr', {}, [el('td', { text: 'Account' }), el('td', { class: 'warn', text: 'not on Stellar testnet yet' })]));
      if ($('fundBtn')) $('fundBtn').hidden = state.walletSource === 'demo-read-only';
      paintWalletKind();
      $('walletNote').textContent = state.walletSource === 'demo-read-only'
        ? 'This is the deployment manifest\'s demo account, read straight from Horizon. It is read-only: connecting your own wallet is still the only way to sign a burn.'
        : 'This Freighter account is not on Stellar testnet yet. Fund it with Friendbot, then refresh.';
      log('This account is not on Stellar testnet yet.', 'warn');
      return;
    }
    // Horizon answers 404 for a valid-but-unfunded account, which is handled
    // above. Everything else it refuses - a malformed key is a 400, an
    // overloaded instance a 429 or 504 - comes back as a problem document with
    // no `balances` at all. Reading .find() off that threw
    // "Cannot read properties of undefined", so a connected wallet reported a
    // TypeError instead of what Horizon actually said.
    if (!accountRes.ok || !Array.isArray(account.balances)) {
      const reason = account.detail || account.title || `Horizon answered ${accountRes.status}`;
      const body = $('walletKv');
      body.textContent = '';
      body.append(el('tr', {}, [el('td', { text: 'Account' }), el('td', { class: 'warn', text: 'balances unavailable' })]));
      paintWalletKind();
      $('walletNote').textContent = `Connected as ${short(state.wallet, 6)}, but Horizon would not return balances: ${reason}`;
      log(`Horizon refused the balance read: ${reason}`, 'warn');
      return;
    }
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

    paintWalletKind();
    if ($('fundBtn')) $('fundBtn').hidden = true;
    const link = $('walletLink');
    link.hidden = false;
    link.setAttribute('href', `https://stellar.expert/explorer/testnet/account/${state.wallet}`);
    link.textContent = 'Open in explorer';
    if (state.walletSource === 'demo-read-only') {
      $('walletNote').textContent = 'This is the deployment manifest\'s demo account, read straight from Horizon. It is read-only: connecting your own wallet is still the only way to sign a burn.';
    } else {
      $('walletNote').textContent = "Balances from Horizon testnet. Spendable XLM is what is left after the account's own reserve. Receiving does not need any of it; burning needs this Freighter key.";
    }
  } catch (error) {
    log(`Balance read failed: ${error}`, 'bad');
    if (!($('walletNote').textContent || '').includes('Friendbot')) {
      $('walletNote').textContent = `Could not read balances: ${error}`;
    }
  }
}

async function fundWithFriendbot() {
  if (!state.wallet || state.walletSource === 'demo-read-only') {
    log('Connect Freighter first. Friendbot funds your testnet account, not the demo view.', 'warn');
    return;
  }
  log(`Calling Friendbot for ${state.wallet}…`);
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(state.wallet)}`);
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 180) }; }
  if (!res.ok) {
    log(`Friendbot: ${res.status} — ${payload.detail || payload.error || payload.raw || 'the account may already be funded'}.`, 'warn');
    await refreshWallet();
    return;
  }
  log(`Friendbot funded this account on Stellar testnet${payload.hash ? `: ${payload.hash}` : '.'}`, 'ok');
  await refreshWallet();
}

async function requireFreighter() {
  if (state.wallet && state.walletSource === 'freighter') return state.wallet;
  if (state.walletSource === 'demo-read-only') {
    log('The demo account cannot sign. Opening Freighter for Stellar testnet.', 'warn');
  }
  return connectWallet();
}

// ------------------------------------------------------------------ amounts
// Amounts travel as base units because that is what the contracts take. Nobody
// reads 137000000 as 13.7, so every amount field carries its own translation.
const ASSET_DECIMALS = 7;

/**
 * What the reader types is what a wallet would show: 13.7, not 137000000.
 * The conversion is string arithmetic on purpose - `13.7 * 1e7` is 136999999.99
 * in binary floating point, and sending that to a contract would be a bug that
 * only shows up on some amounts.
 */
function toBaseUnits(text) {
  const raw = String(text == null ? '' : text).trim().replace(/\s|,/g, '');
  if (!/^\d+(\.\d{1,7})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const padded = (fraction + '0'.repeat(ASSET_DECIMALS)).slice(0, ASSET_DECIMALS);
  const base = whole + padded;
  const trimmed = base.replace(/^0+/, '') || '0';
  if (trimmed.length > 15) return null; // beyond what the contract's i128 path accepts here
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

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
    const base = toBaseUnits(raw);
    if (base === null) {
      hint.textContent = 'a number with up to 7 decimal places, e.g. 13.7';
      hint.dataset.state = 'warn';
      return;
    }
    hint.dataset.state = '';
    // Both directions, in the reader's unit first: the base-unit integer is what
    // goes on the wire, so it is shown rather than hidden.
    hint.textContent = `${base.toLocaleString('en-US')} base units on the wire ${tail}`;
  };
  input.addEventListener('input', paint);
  paint();
}

function wireAmounts() {
  amountHint('lockAmount', 'lockAmountHint', '- minted to the recipient, minus the relayer fee');
  amountHint('burnAmount', 'burnAmountHint', '- burned from your own balance');
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
  const amount = toBaseUnits($('lockAmount').value);
  const typed = $('lockAmount').value.trim();
  const recipient = $('lockRecipient').value.trim();
  const count = Number($('lockCount').value || 1);
  if (amount === null) return log(`Amount must be a number with up to 7 decimal places: "${typed}" cannot be sent.`, 'bad');
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) return log('Recipient must be a Stellar account address (G..., 56 characters).', 'bad');

  // The button is not dead when no source adapter exists behind this
  // deployment; the click is answered with the reason instead. Saying it here,
  // before the request, is what makes the answer instant and exact - the API
  // would say the same thing one round-trip later.
  if (state.status && state.status.capabilities?.source_chain?.configured === false) {
    step('lock', 'idle', 'no source adapter on this deployment');
    log('Lock refused here: this deployment has no source adapter (SOURCE_URL is not set server-side), so there is no source chain to create the lock event on. Locally: run the source simulator and point SOURCE_URL at it.', 'warn');
    return;
  }

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
  markUnavailable($('settleBtn'), !state.status?.capabilities?.operator_relay?.enabled);
  await showProof(state.lock.height);
}

async function showProof(height) {
  step('finality', 'active', 'reading the finality evidence for this height');
  const messageId = state.lock?.event?.message_id;
  const proofPath = `/proof?height=${height}&kind=bls${messageId ? `&message_id=${encodeURIComponent(messageId)}` : ''}`;
  const { ok, payload } = await api(`/api/source?path=${encodeURIComponent(proofPath)}`);
  if (!ok) {
    step('finality', 'idle');
    log(`Finality evidence unavailable: ${failureText(payload)}`, 'bad');
    return null;
  }
  const b = payload.payload || {};
  if (payload.local_simulator) {
    step('finality', 'done', `local Merkle root at height ${payload.declared_height} — BLS not signed, not on Stellar`);
    step('mint', 'idle', 'mint needs the relayer key; nothing was submitted to the gateway');
    log(
      `Local simulator proof for height ${payload.declared_height}\n  state_root ${payload.declared_root}\n  event_root ${b.event_root}\n  ${payload.note || 'BLS not produced in this process'}`,
      'info'
    );
    $('runStatus').textContent = `locked at source height ${height} — mint not submitted (no relayer)`;
    return payload;
  }
  step('finality', 'active', `${b.signer_count} signatures collected, ${b.required} required`);
  log(
    `Finality evidence for height ${payload.declared_height}\n  state_root ${payload.declared_root}\n  event_root ${b.event_root}\n  ${b.signer_count} signatures collected, policy requires ${b.required} - aggregate is ${(b.sig_hex || '').length / 2} bytes`,
    'info'
  );
  return payload;
}

async function settle() {
  const height = state.lock?.height;
  if (!height) {
    // A silent return here is how a button looks dead: the click reaches the
    // handler, the handler does nothing, and the reader learns nothing. Say
    // the state instead.
    log('Nothing to settle yet: lock a block on the source chain first. Settlement is one relayer pass over one specific locked height.', 'warn');
    return;
  }
  $('settleBtn').textContent = 'Relayer pass running...';
  step('finality', 'active', 'the relayer is anchoring this block and paying for the mint');
  log(`Asking the operator facade for one relayer pass at height ${height}. This signs, submits and waits for confirmation, so it takes tens of seconds.`);
  const { ok, payload } = await api(`/api/relay?height=${height}`, { method: 'POST', auth: true });
  $('settleBtn').textContent = 'Ask the relayer to settle';
  if (!ok) {
    log(`Relay refused (${failureCode(payload) || 'error'}): ${failureText(payload)}`, 'warn');
    step('finality', 'idle', 'the relayer pass did not complete; finality was not anchored');
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
  const address = await requireFreighter();
  if (!address) return;
  const amount = toBaseUnits($('burnAmount').value);
  if (amount === null) return log(`Amount must be a number with up to 7 decimal places: "${$('burnAmount').value.trim()}" cannot be sent.`, 'bad');
  // The unlock needs somewhere to land on the source chain. This line went
  // missing at one point - the function referenced a bare `recipient` that no
  // scope defined, so every click died on a ReferenceError before a single
  // byte reached the network. The field is read, required and validated now.
  const recipient = ($('burnRecipient').value || '').trim();
  if (!recipient) return log('Unlock recipient is required: burning locks the value for an address on the source chain, and an empty one would strand it.', 'bad');
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) return log('Unlock recipient must be a source-chain account address (G..., 56 characters).', 'bad');
  const gateway = state.status?.contracts?.gateway;
  const targetDomain = state.status?.domain?.key;
  if (!gateway || !targetDomain) return log('Deployment addresses are not loaded yet.', 'warn');

  log(`Preparing a burn of ${amount} with unlock to ${short(recipient)}...`);
  try {
    const module = await import('./soroban.ts');
    const prepared = await module.buildBurnAndRelayTx(gateway, String(amount), recipient, targetDomain, state.wallet);
    const freighter = freighterProvider();
    if (!freighter || typeof freighter.signTransaction !== 'function') {
      throw new Error('Freighter is not available to sign');
    }
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

// A control that cannot act has to say why, and it has to say it twice: in
// the note under the control, where a reader sees it without hunting, and in
// its own title, where a pointer finds it. Both come from the same sentence -
// the note is the source and the title is a copy of it - because two
// hand-written copies of one reason drift apart, and the version a reader
// hovers is then the one that is wrong.
//
// This started as a finding, not a design: a click-through of the live page
// found four disabled controls, two of them silent. "Pay with Freighter" and
// "Check status" were greyed with nothing anywhere saying why.
const DISABLED_REASONS = [
  { control: 'lockBtn', note: 'sourceNote' },
  { control: 'settleBtn', note: 'settleNote' },
  { control: 'cashoutPayBtn', note: 'cashoutActionNote' },
  { control: 'cashoutStatusBtn', note: 'cashoutActionNote' },
];

/**
 * A `disabled` button cannot be clicked, so it can never say why it is grey:
 * the browser swallows the click before any handler runs, and the reason stays
 * in a note the reader has not found. An *unavailable* control keeps answering:
 * it stays focusable, it carries aria-disabled for assistive tech, and its own
 * handler is where the honest reason lives. The button is never silently dead.
 *
 * Availability is a style state here, not a hard gate: the handlers themselves
 * still decide what a click may do, and a click that cannot act answers with
 * the exact reason in the log instead of doing nothing.
 */
function markUnavailable(button, unavailable) {
  if (!button) return;
  if (unavailable) {
    button.setAttribute('aria-disabled', 'true');
    button.removeAttribute('disabled');
  } else {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('disabled');
  }
  paintDisabledReasons();
}

function isUnavailable(button) {
  return Boolean(button) && (button.disabled || button.getAttribute('aria-disabled') === 'true');
}

function paintDisabledReasons() {
  for (const { control, note } of DISABLED_REASONS) {
    const button = $(control);
    const source = $(note);
    if (!button || !source) continue;
    button.setAttribute('aria-describedby', note);
    const reason = source.textContent.replace(/\s+/g, ' ').trim();
    if (isUnavailable(button) && reason) button.title = reason;
    else button.removeAttribute('title');
  }
}

function paintWriteState() {
  const set = Boolean(state.operatorToken);
  $('operatorHint').textContent = set ? 'writes: token set for this tab' : 'writes: no operator token yet';
  $('operatorHintBtn').hidden = set;
  $('opState').textContent = set ? 'A token is set for this tab.' : 'No token set: writes will be refused.';
  paintDisabledReasons();
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
  const rows = !instructions
    ? [['treasury', 'not opened yet']]
    : instructions.treasury
      ? [
          ['treasury', short(instructions.treasury, 8)],
          ['memo', `${instructions.memo} (${instructions.memo_type})`],
          ['amount', `${instructions.amount} ${instructions.asset_code}`],
          ['transaction', instructions.transaction_id],
        ]
      : [
          ['treasury', 'held by the anchor until its form is done'],
          ['amount', `${instructions.amount} ${instructions.asset_code}`],
          ['transaction', instructions.transaction_id],
          ['status', instructions.status || 'incomplete'],
        ];
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
  // Upstream's markUnavailable keeps the button pressable so it can answer why
  // it is dark, instead of going silently grey. Kept.
  //
  // The condition is the stricter one: Pay needs a treasury address, not just
  // an open withdrawal. A real anchor opens the withdrawal "incomplete" and
  // withholds the address until its own form is done, so gating on
  // `instructions` alone would offer to send money nowhere.
  markUnavailable($('cashoutPayBtn'), !(instructions && instructions.treasury));
  markUnavailable($('cashoutStatusBtn'), !CASHOUT.transactionId);
  // The note the two buttons point at is written for the state they are in:
  // with an open withdrawal it is the anchor's own instruction (pay this
  // address, with this memo), and without one it is why they are grey.
  if (!instructions) {
    $('cashoutActionNote').textContent =
      'Read the anchor and open a withdrawal first: the payment address, the memo and the amount all come from the anchor, so there is nothing to pay or poll until it has answered.';
  } else if (!instructions.treasury) {
    $('cashoutActionNote').textContent =
      `The anchor opened withdrawal ${instructions.transaction_id} but will not name a payment address until you finish its own form. Open the link above, complete it, then press Check status: the address and memo appear here the moment the anchor releases them.`;
  } else if (!CASHOUT.transactionId) {
    $('cashoutActionNote').textContent =
      "The withdrawal is open but the anchor has not returned a transaction id yet, so there is nothing to poll: pay first, then check the status.";
  } else {
    $('cashoutActionNote').textContent = `Pay ${instructions.amount} ${instructions.asset_code} to ${instructions.treasury} with memo ${instructions.memo} (${instructions.memo_type}), then poll the anchor for this withdrawal.`;
  }
  if (instructions && instructions.extra_info && instructions.extra_info.message) {
    $('cashoutPayHint').textContent = instructions.extra_info.message;
  }
  paintDisabledReasons();
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
  if (!(await requireFreighter())) return null;
  const challenge = await cashoutApi(`?action=challenge&account=${encodeURIComponent(state.wallet)}`);
  if (!challenge.ok) {
    log(`No challenge: ${failureText(challenge.payload)}`, 'bad');
    return null;
  }
  const freighter = freighterProvider();
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
  if (result.payload.treasury) {
    log(`Withdrawal ${result.payload.transaction_id} is open: pay ${result.payload.amount} ${result.payload.asset_code} to ${short(result.payload.treasury, 8)} with memo ${result.payload.memo}.`, 'ok');
  } else {
    // Not a failure: this is the anchor doing its job. Say what it wants and
    // where, rather than reporting an open withdrawal as if it were payable.
    log(`Withdrawal ${result.payload.transaction_id} is open but not payable yet: the anchor collects its own details first.`, 'warn');
    if (result.payload.interactive_url) {
      log(`Finish it at ${result.payload.interactive_url}`, '');
      const link = $('cashoutPayHint');
      if (link) link.textContent = `The anchor's form: ${result.payload.interactive_url}`;
    }
  }
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
    const freighter = freighterProvider();
    if (!freighter || typeof freighter.signTransaction !== 'function') {
      throw new Error('Freighter is not available to sign');
    }
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
  if (!CASHOUT.transactionId) {
    log('No withdrawal to check yet: read the anchor, authenticate and open a withdrawal first - until it answers there is no transaction to poll.', 'warn');
    return;
  }
  const result = await cashoutApi(`?action=status&id=${encodeURIComponent(CASHOUT.transactionId)}`, {
    anchorToken: CASHOUT.anchorToken,
  });
  if (!result.ok) return log(`Status check failed: ${failureText(result.payload)}`, 'bad');
  const payload = result.payload;
  log(`Anchor reports ${payload.status}${payload.amount_out ? `, paid out ${payload.amount_out}` : ''}${payload.external_transaction_id ? `, reference ${payload.external_transaction_id}` : ''}.`, payload.status === 'completed' ? 'ok' : '');
  // The address can arrive on any poll. When it does, fold it into the open
  // withdrawal so Pay becomes live without the user starting again.
  if (payload.treasury && CASHOUT.instructions && !CASHOUT.instructions.treasury) {
    CASHOUT.instructions = { ...CASHOUT.instructions, treasury: payload.treasury, memo: payload.memo, memo_type: payload.memo_type };
    cashoutPaintInstructions(CASHOUT.instructions);
    log(`The anchor released its payment address: ${short(payload.treasury, 8)} with memo ${payload.memo}. Pay is now live.`, 'ok');
  }
}

function wire() {
  $('lockBtn').addEventListener('click', () => withBusy($('lockBtn'), () => lock().catch((error) => log(String(error), 'bad'))));
  $('settleBtn').addEventListener('click', () => withBusy($('settleBtn'), () => settle().catch((error) => log(String(error), 'bad'))));
  $('copyCmdBtn').addEventListener('click', () => copyCommand());
  $('clearLogBtn').addEventListener('click', () => showLogPlaceholder());
  // The version switch. 1.0 is this repository's system, so pressing it means
  // "the thing below" - it marks itself and goes to the wallet. 2.0 is disabled
  // with its reason stated; when its design lands it becomes a real switch
  // rather than being quietly enabled.
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
  if ($('fundBtn')) {
    $('fundBtn').addEventListener('click', () => withBusy($('fundBtn'), () => fundWithFriendbot()));
  }
  watchForFreighter();
  // Connecting needs the Freighter extension; this does not. The deployment
  // manifest names the gasless demo account, so the card can show that account's
  // live balances to anyone, signed by nobody. It is read-only and says so: the
  // chip and the note both carry the word, and burning still routes through
  // connectWallet(), which will ask for Freighter because signing needs it.
  $('demoWalletBtn').addEventListener('click', () => withBusy($('demoWalletBtn'), async () => {
    const demo = state.status?.accounts?.gasless_recipient || state.status?.accounts?.end_user;
    if (!demo) {
      log('The manifest in this deployment carries no demo account to read.', 'warn');
      return;
    }
    if (state.wallet && state.wallet !== demo) {
      log(`The card is showing ${short(state.wallet)}; switching to the demo account ${short(demo)}.`, 'warn');
    }
    state.wallet = demo;
    state.walletSource = 'demo-read-only';
    $('walletChip').textContent = `read-only: ${short(demo, 6)}`;
    $('walletKind').textContent = 'read-only demo view';
    log(`Reading the demo account ${demo}. This view is read-only: nothing here signs, and burning still needs your own wallet.`, 'info');
    await refreshWallet();
    $('walletKind').textContent = 'read-only demo view';
    $('walletNote').textContent = 'This is the deployment manifest\'s demo account, read straight from Horizon. It is read-only: connecting your own wallet is still the only way to sign a burn.';
  }));
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
wireWindows();
watchSections();
buildLattice();
initLatticeFrame();
paintDisabledReasons();
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
  .catch((error) => log(`Startup failed: ${error}`, 'bad'))
  .finally(() => {
    // A page whose handlers are attached and a page whose handlers are not yet
    // attached look identical from the outside: both render, both are full of
    // buttons, and only one of them answers a click. That ambiguity cost a
    // browser check a false failure against the live deployment, where the
    // first click landed before wire() had run. The flag below is the page
    // saying it is ready, for the tools that drive it.
    document.documentElement.dataset.lumenReady = 'ready';
  });
