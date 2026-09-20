'use strict';

// Behavioural proof that the console connects a wallet.
//
// "It works" is easy to say and tedious to verify by hand, so this harness
// boots the real frontend/src/app.js - the same file the browser downloads -
// in a vm against a stub DOM built from the real index.html ids, stubs the
// network exactly where the app expects it (status payload, audit record,
// manifest, Horizon account) and installs a Freighter-shaped object on the
// window. It then performs the exact click a user performs and asserts the
// complete connected state, plus the refusal path, plus the review
// properties (rounded amounts with exact values on hover, full renounce
// hashes, live audit badge, coded cube wall).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
let app = fs.readFileSync(path.join(root, 'frontend', 'src', 'app.js'), 'utf8');

const PUB = 'GDEVWALLETXWHATEVERXRESULTXRETURNEDXBYXFREIGHTERX00000ABCD';
const RENOUNCE_REGISTRY = 'a'.repeat(64);
const RENOUNCE_GATEWAY = 'b'.repeat(64);
const NOW = new Date().toISOString();

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

// Dynamic imports (soroban.ts) are irrelevant to the connect path, and a
// classic vm script cannot parse import() - alias it to a stub that would
// fail loudly if a test ever drove a path that needs it.
app = app.replace(/await import\(/g, 'await __import(');

// ------------------------------------------------------------------ DOM stub
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.text = '';
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get classList() {
    const el = this;
    const tokens = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => { el.className = [...new Set([...tokens(), ...names])].join(' '); },
      remove: (...names) => { el.className = tokens().filter((t) => !names.includes(t)).join(' '); },
      toggle: (name, force) => {
        const has = tokens().includes(name);
        const want = force === undefined ? !has : force;
        if (want && !has) el.className = [...tokens(), name].join(' ');
        if (!want) el.className = tokens().filter((t) => t !== name).join(' ');
        return want;
      },
      contains: (name) => tokens().includes(name),
    };
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => (c instanceof El ? c.textContent : c.text)).join('');
  }
  set innerHTML(value) {
    this.text = String(value);
    this.children = [];
  }
  get innerHTML() { return this.text; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...nodes) {
    for (const node of nodes) {
      if (node && node.isFragment) this.children.push(...node.children);
      else if (node) this.children.push(node);
    }
  }
  querySelector(selector) {
    // class selectors can be answered honestly; attribute selectors exist in
    // markup the harness does not model (step rails), and the app guards
    // those lookups, so null is the truthful answer there.
    const flat = (list) => list.flatMap((c) => (c instanceof El ? [c, ...flat(c.children)] : []));
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return flat(this.children).find((c) => c.classList.contains(cls)) || null;
    }
    return null;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  focus() {}
  select() {}
  showModal() {}
  close() {}
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

function makeDocument(elsById) {
  const documentListeners = {};
  return {
    documentElement: { style: { setProperty() {} }, dataset: {} },
    getElementById: (id) => elsById.get(id) || null,
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ text: String(text) }),
    createDocumentFragment: () => {
      const frag = new El('#fragment');
      frag.isFragment = true;
      return frag;
    },
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
    readyState: 'complete',
  };
}

// ------------------------------------------------------------------ network
const statusPayload = {
  network: 'testnet',
  chain: { rpc: 'https://rpc', horizon: 'https://horizon-testnet.stellar.org', latest_ledger: 4766000 },
  contracts: {
    registry: 'C' + 'R'.repeat(55),
    gateway: 'C' + 'G'.repeat(55),
    wrapped_asset: 'C' + 'W'.repeat(55),
    asset: 'wSRC',
    issuer: 'G' + 'I'.repeat(55),
  },
  accounts: { gasless_recipient: 'G' + 'E'.repeat(55) },
  domain: { key: 'd'.repeat(64) },
  target_domain: 'e'.repeat(64),
  capabilities: {
    operator_relay: { enabled: false, note: 'no operator configured' },
    source_chain: { configured: false, note: 'no source adapter' },
  },
  audit: { result: '12/12', rounds_recorded: 17, last_check: NOW, all_passed: true },
  receipts: { renounce_admin: RENOUNCE_REGISTRY, gateway_renounce_admin: RENOUNCE_GATEWAY },
  findings: [],
  honesty: { findings_recorded: 3 },
};

const horizonAccount = {
  balances: [
    { asset_type: 'native', balance: '40.8000003' },
    { asset_code: 'wSRC', balance: '12.3456789' },
  ],
  subentry_count: 2,
};

function makeFetch() {
  return async (url) => {
    const u = String(url);
    let payload;
    if (u.endsWith('/api/status')) payload = statusPayload;
    else if (u.endsWith('/api/audit')) payload = { record: { history: [{ round: 17, finished_at: NOW, checks_passed: 12, checks_total: 12, all_passed: true }], latest: { round: 17, finished_at: NOW, checks_passed: 12, checks_total: 12, all_passed: true } } };
    else if (u.includes('/api/finality')) payload = { found: true, query: 'latest', record: { last_height: '306', last_root: 'ab', last_event_root: 'cd', last_security: ['signature_set(3,2)', 'bls'] }, latest_ledger: 4766000 };
    else if (u.includes('deployments/testnet.json')) payload = { receipts: { renounce_admin: RENOUNCE_REGISTRY, gateway_renounce_admin: RENOUNCE_GATEWAY } };
    else if (u.includes('/accounts/')) payload = horizonAccount;
    else return { ok: false, status: 404, json: async () => ({ error: 'not_found' }), text: async () => '{"error":"not_found"}' };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
}

// ------------------------------------------------------------------ boot
async function boot(freighter) {
  const elsById = new Map(ids.map((id) => [id, new El(`#${id}`)]));
  const timeouts = [];
  const session = new Map();
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    scrollY: 0,
    freighterApi: freighter,
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    },
    addEventListener: () => {},
  };
  const sandbox = {
    window: win,
    document: makeDocument(elsById),
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: makeFetch(),
    localStorage: win.sessionStorage,
    IntersectionObserver: class { constructor() {} observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { constructor() {} observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {},
    __import: async () => { throw new Error('dynamic module imports are stubbed in this harness'); },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: 'app.js' });
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      while (timeouts.length) timeouts.shift()();
    }
  };
  await flush();
  return { elsById, sandbox, flush };
}

const flatten = (el) => [el, ...el.children.flatMap((c) => (c instanceof El ? flatten(c) : []))];
const allText = (el) => flatten(el).map((n) => (n instanceof El ? n.text : n.text)).join(' ');

// ------------------------------------------------------- the success path
(async () => {
  const run = await boot({
    requestAccess: async () => ({ address: PUB }),
    getNetwork: async () => ({ network: 'TESTNET' }),
  });
  const els = run.elsById;

  // boot already connected the page to the network through the status API
  const netDot = flatten(els.get('netPill')).find((n) => n instanceof El && n.classList.contains('dot'));
  expect(netDot && netDot.classList.contains('ok'), `the network pill must be green once status answers, got classes "${netDot && netDot.className}"`);
  expect(els.get('statRegistry').textContent === statusPayload.contracts.registry, 'the registry stat must write the contract id in full');
  expect(allText(els.get('footerChain')).includes('horizon-testnet.stellar.org'), 'the footer must show the live horizon');

  // trust evidence, renounce hashes in full, audit badge - all boot-time
  expect(els.get('renounceRegistry').textContent === RENOUNCE_REGISTRY, 'the registry renounce hash must be written in full');
  expect(els.get('renounceGateway').textContent === RENOUNCE_GATEWAY, 'the gateway renounce hash must be written in full');
  expect(((els.get('renounceRegistry').href || '') + (els.get('renounceRegistry').attrs.href || '')).endsWith(RENOUNCE_REGISTRY), 'the registry renounce hash must link to its transaction');
  expect(els.get('auditBadge').textContent === 'Self-audit: 12/12', `the audit badge must read the live result, got "${els.get('auditBadge').textContent}"`);
  expect(els.get('auditBadgeDot').classList.contains('ok'), 'the audit badge dot must be green when the latest round passed');

  // the coded cube wall: 1280x800 at dpr 1 is two tiles apart, so 11 x 7
  // individually coded cubes - one element per pitch, not one per tile
  const stride = 1280 >= 1600 ? 4 : 1280 >= 900 ? 2 : 1;
  const want = Math.ceil(1280 / (60 * stride)) * Math.ceil(800 / (60 * stride));
  const wallChildren = els.get('cubeLattice').children.length;
  expect(wallChildren === want, `the wall must carry exactly ${want} coded cubes for this viewport, got ${wallChildren}`);

  // the demo account can be read without any wallet extension: the card must
  // show live balances and say, in the chip and in the note, that it is read-only
  els.get('demoWalletBtn').click();
  await run.flush();
  expect(/read-only/i.test(els.get('walletChip').textContent), `the demo view must label itself in the chip, got "${els.get('walletChip').textContent}"`);
  const demoKv = flatten(els.get('walletKv')).map((n) => (n.textContent || '').trim()).join(' ').replace(/\s+/g, ' ');
  expect(/\d/.test(demoKv), `the demo view must read real balances, got "${demoKv}"`);
  expect(/read-only/i.test(els.get('walletNote').textContent), `the demo view must say what it cannot do, got "${els.get('walletNote').textContent}"`);

  // amounts are typed the way a wallet shows them, and the base-unit integer is
  // stated rather than silently multiplied
  els.get('lockAmount').value = '13.7';
  els.get('lockAmount').fire('input');
  expect(/\b137,000,000\b/.test(els.get('lockAmountHint').textContent), `13.7 must state its base-unit integer, got "${els.get('lockAmountHint').textContent}"`);
  els.get('lockAmount').value = '12.12345678';
  els.get('lockAmount').fire('input');
  expect(!/base units/.test(els.get('lockAmountHint').textContent), `an eighth decimal place cannot be sent, got "${els.get('lockAmountHint').textContent}"`);

  // the click a user performs
  els.get('connectBtn').click();
  await run.flush();

  expect(els.get('walletChip').textContent.includes(PUB.slice(0, 6)), `the wallet chip must show the connected address, got "${els.get('walletChip').textContent}"`);
  expect(els.get('connectBtn').textContent === 'Reconnect', 'the connect button must reflect the connected state');
  expect(allText(els.get('txLog')).includes(`Wallet connected: ${PUB}`), 'the log must record the connection with the full address');
  expect(els.get('walletKind').textContent.includes('connected'), `walletKind must say connected, got "${els.get('walletKind').textContent}"`);

  // amounts: rounded on the face, exact on hover - the review requirement
  const cells = flatten(els.get('walletKv')).filter((n) => n instanceof El && n.tagName === 'td');
  const rounded = cells.find((c) => c.text === '40.80');
  expect(Boolean(rounded), `a rounded 40.80 cell must exist among ${cells.map((c) => `"${c.text}"`).join(', ')}`);
  expect(cells.some((c) => c.title === 'exact: 40.8000003'), 'the exact seven-decimal value must sit on the cell title');
  expect(cells.some((c) => c.text === '12.35' && c.title === 'exact: 12.3456789'), 'the wrapped asset balance must round the same way');

  // busy state released after the async work finished
  expect(!els.get('connectBtn').classList.contains('busy'), 'the busy state must clear when the connect finished');

  // ------------------------------------------------------- the refusal path
  const refused = await boot({
    requestAccess: async () => ({ error: 'User declined access' }),
    getNetwork: async () => ({ network: 'TESTNET' }),
  });
  refused.elsById.get('connectBtn').click();
  await refused.flush();
  expect(refused.elsById.get('walletNote').textContent.includes('did not share an address'), `a declined popup must say so, got "${refused.elsById.get('walletNote').textContent}"`);
  expect(allText(refused.elsById.get('txLog')).includes('not approved'), 'the refusal must land in the log, not be swallowed');
  expect(!refused.elsById.get('walletChip').textContent.includes('undefined'), 'a refusal must never render "undefined" as the address');

  // ------------------------------------- the two shapes a real extension answers in
  // Freighter's newer builds answer requestAccess() with { address }, older ones
  // answer getPublicKey() with the string itself. Both are the extension talking,
  // and neither may end in "wallet connection failed".
  for (const [label, injected] of [
    ['requestAccess with an address', { requestAccess: async () => ({ address: PUB }), getNetwork: async () => ({ network: 'TESTNET' }) }],
    ['getPublicKey with a string', { getPublicKey: async () => PUB, getNetwork: async () => 'TESTNET' }],
  ]) {
    const run2 = await boot(injected);
    run2.elsById.get('connectBtn').click();
    await run2.flush();
    expect(
      run2.elsById.get('walletChip').textContent.includes(PUB.slice(0, 6)),
      `a wallet answering as "${label}" must connect, got "${run2.elsById.get('walletChip').textContent}"`
    );
    expect(
      !allText(run2.elsById.get('txLog')).includes('Wallet connection failed'),
      `a wallet answering as "${label}" must not be reported as a failure`
    );
  }

  // ------------------------------------------------------- the missing wallet path
  const noWallet = await boot(undefined);
  noWallet.elsById.get('connectBtn').click();
  await noWallet.flush();
  expect(noWallet.elsById.get('walletNote').textContent.includes('Freighter is not installed'), 'without the extension the page must say exactly what is missing');

  console.log(`wallet contract: boot reaches the network (${want} cubes coded), connect click -> address shown for both extension shapes (requestAccess and getPublicKey), demo account readable with no extension at all, balances rounded with exact titles, trust evidence in full, audit badge live | refusal and absence both speak`);
  if (problems.length === 0) {
    console.log('wallet connect: proven against the real app.js and the real markup, not asserted in prose');
    process.exit(0);
  }
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
})().catch((error) => {
  console.error(`harness crashed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
