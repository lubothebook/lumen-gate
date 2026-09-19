'use strict';

// Behavioural check for the lattice pointer frame.
//
// The page background is the source chain: one cube per block, painted from
// the project tile at the tile's own 60px, and moving the pointer snaps a
// 60x60 frame onto the cube beneath it with a literal 4px inner border. That
// behaviour is split between markup, CSS and the watchGrid() function in
// frontend/src/app.js, and a regression in any one of them fails silently:
// the page would still load, look finished and simply stop reacting. This
// check therefore asserts both halves of the contract:
//
//   1. the static contract: the tile's own cell is 60px and the frame's own
//      border is 4px, the tile in frontend/public really is 60x60 and is the
//      file the manifest says it is, the frame is one cell with an inset white
//      border drawn from the ring token, one asset pixel is one screen pixel
//      (the cell and the ring are divided by the device pixel ratio, never
//      multiplied), and the hiding rules (touch devices, reduced motion) exist;
//   2. the behaviour: watchGrid() is extracted and driven with synthetic
//      pointer events against a stub DOM, and must snap the frame to the
//      right cube, account for the scrolled lattice, stay off interactive
//      surfaces, and hide when the pointer leaves, scrolls or blurs. The same
//      run asserts the density contract on the tokens it sets: at dpr 2 a 60px
//      tile becomes a 30px cell with a 2px ring, at dpr 1 it stays 60/4.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend', 'src', 'app.js'), 'utf8');

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

// ---------------------------------------------------- 1. static contract
const cellToken = /--cell:\s*(\d+)px/.exec(html);
expect(cellToken && Number(cellToken[1]) === 60, 'the --cell token must default to the tile\'s own 60px');
const ringToken = /--ring:\s*(\d+)px/.exec(html);
expect(ringToken && Number(ringToken[1]) === 4, 'the --ring token must default to 4px, the frame the pointer draws');

const tile = fs.readFileSync(path.join(root, 'frontend', 'public', 'grid-tile.png'));
expect(tile.slice(1, 4).toString() === 'PNG', 'grid-tile.png is not a PNG');
expect(tile.readUInt32BE(16) === 60 && tile.readUInt32BE(20) === 60, 'grid-tile.png must be exactly 60x60 pixels');

// The tile is a submitted artwork, so its provenance is part of the contract:
// the hash the manifest records and the bytes on disk must not drift apart.
// The page embeds those same bytes as a data URI (tools/check-console.js
// compares the encoded copy), which is why a redrawn tile cannot ship quietly.
const crypto = require('crypto');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deployments', 'testnet.json'), 'utf8'));
const recorded = /sha256 ([0-9a-f]{64})/.exec(String((manifest.interface_state || {}).lattice || ''));
expect(Boolean(recorded), 'interface_state.lattice must record the tile\'s sha256 so the artwork has a provenance');
if (recorded) {
  const actual = crypto.createHash('sha256').update(tile).digest('hex');
  expect(actual === recorded[1], `grid-tile.png is not the file the manifest records (on disk ${actual.slice(0, 12)}, recorded ${recorded[1].slice(0, 12)})`);
}

// One asset pixel is one screen pixel: the cell and the ring are derived from
// the device, never from a fixed size that a 2x display would stretch.
expect(/const TILE_PX = 60;/.test(app) && /const FRAME_PX = 4;/.test(app), 'app.js must size the lattice from TILE_PX/FRAME_PX');
expect(/root\.style\.setProperty\('--cell'/.test(app), 'app.js must set --cell on the document element');
expect(/TILE_PX \/ dpr/.test(app), 'the cell must be the tile divided by the device pixel ratio (one asset px per screen px)');
expect(/FRAME_PX \/ dpr/.test(app), 'the frame must be the ring divided by the device pixel ratio');
expect(/Math\.round\([^)]*dpr\)|\/ dpr\) \* dpr/.test(app), 'the frame transform must snap to whole device pixels, not fractional css pixels');

const bodyRule = /body\s*\{[^}]*\}/.exec(html);
expect(bodyRule && bodyRule[0].includes('background-image: var(--grid-tile)'), 'the body must paint the lattice from --grid-tile');
expect(bodyRule && bodyRule[0].includes('background-size: var(--cell) var(--cell)'), 'the lattice must be painted at cell size, never resampled');
expect(bodyRule && bodyRule[0].includes('image-rendering: pixelated'), 'the lattice must not be smoothed (image-rendering: pixelated)');

const frameRule = /\.grid-frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(frameRule), '.grid-frame rule missing');
if (frameRule) {
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(frameRule[0]), 'the frame must be an inset white border drawn from the --ring token (4px on a 1x display)');
  expect(/width:\s*var\(--cell\);\s*height:\s*var\(--cell\)/.test(frameRule[0]), 'the frame must cover exactly one cube');
  expect(/pointer-events:\s*none/.test(frameRule[0]), 'the frame must stay paint, never a control');
  expect(/z-index:\s*-\d+/.test(frameRule[0]), 'the frame must sit below the page surfaces so cards and the band hide it');
  expect(/opacity:\s*0/.test(frameRule[0]), 'the frame must start hidden');
}
expect(/\.grid-frame\.on\s*\{\s*opacity:\s*1\s*;?\s*\}/.test(html), '.grid-frame.on must reveal the frame');
expect(html.includes('<div class="grid-frame" id="gridFrame" aria-hidden="true"></div>'), 'the frame element is missing or no longer aria-hidden paint');
expect(/@media \(hover: none\), \(pointer: coarse\)[^}]*\.grid-frame[^}]*display:\s*none/.test(html), 'touch devices must not get the pointer frame');
expect(/prefers-reduced-motion: reduce[^}]*\.grid-frame[^}]*transition:\s*none/.test(html.replace(/\{ /g, '{')), 'reduced motion must remove the frame transition');

// ---------------------------------------------------- 2. the behaviour
const fnMatch = app.match(/function watchGrid\(\) \{[\s\S]*?\n\}/);
expect(Boolean(fnMatch), 'watchGrid() was not found in frontend/src/app.js');
const sizeMatch = app.match(/function sizeLattice\(\) \{[\s\S]*?\n\}/);
expect(Boolean(sizeMatch), 'sizeLattice() was not found in frontend/src/app.js');
const constMatch = app.match(/const TILE_PX = \d+;\nconst FRAME_PX = \d+;\n\nconst LATTICE_MODES = \{[^}]*\};/);
expect(Boolean(constMatch), 'the lattice constants could not be read out of frontend/src/app.js');
expect(/^\s*watchGrid\(\)/m.test(app), 'watchGrid() is defined but never called, so the frame is dead code');

function drive({ elementFromPoint, scrollY = 0, dpr = 1, latticeScale = 'pixel' }) {
  const calls = { on: [], transform: [], rafQueued: 0, tokens: {} };
  const frameStub = {
    classList: {
      add: (name) => name === 'on' && calls.on.push(true),
      remove: (name) => name === 'on' && calls.on.push(false),
    },
    style: {
      set transform(value) { calls.transform.push(value); },
    },
  };
  const listeners = { window: {}, document: {} };
  let raf = null;
  // Every element app.js touches while sizing the lattice, stubbed to the
  // smallest thing that answers: attributes, the readout text and the root
  // custom properties, which is where the density contract actually lands.
  const elementStub = () => ({
    attrs: {}, dataset: {}, style: {}, textContent: '',
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { add() {}, remove() {} },
  });
  const rootStyle = {
    props: {},
    setProperty(name, value) { this.props[name] = value; calls.tokens[name] = value; },
  };
  const sandbox = {
    $: (id) => (id === 'gridFrame' ? frameStub : (sandbox.__els[id] ||= elementStub())),
    __els: {},
    state: { latticeScale },
    store: { get: () => null, set: () => true, clear: () => true },
    document: {
      documentElement: { style: rootStyle, dataset: {} },
      elementFromPoint,
      addEventListener: (type, fn) => { (listeners.document[type] ||= []).push(fn); },
    },
    window: {
      scrollY,
      devicePixelRatio: dpr,
      addEventListener: (type, fn) => { (listeners.window[type] ||= []).push(fn); },
    },
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--cell' ? ` ${60 / dpr}px` : ' 0px') }),
    requestAnimationFrame: (fn) => { raf = fn; calls.rafQueued += 1; },
  };
  vm.createContext(sandbox);
  const prefix = `${constMatch ? constMatch[0] : ''}\n${sizeMatch ? sizeMatch[0] : ''}\n`;
  vm.runInContext(`${prefix}${fnMatch ? fnMatch[0] : ''}\nwatchGrid();`, sandbox, { filename: 'app.js#watchGrid' });
  const fire = (target, type, event) => { for (const fn of listeners[target][type] || []) fn(event || {}); };
  const paint = () => { const fn = raf; raf = null; if (fn) fn(); };
  return { calls, fire, paint, elements: sandbox.__els, elementStub };
}

const bare = { closest: () => null };
const overCard = { closest: (sel) => (sel.includes('.card') ? {} : null) };

// a pointer over bare lattice frames the cube it is on
let run = drive({ elementFromPoint: () => bare });
run.fire('window', 'pointermove', { clientX: 125, clientY: 75 });
run.paint();
expect(run.calls.transform[0] === 'translate3d(120px, 60px, 0)', `pointer at (125,75) must frame cube (2,1): ${run.calls.transform[0]}`);
expect(run.calls.on.length === 1 && run.calls.on[0] === true, 'the frame must switch on over bare lattice');

// a second event before the paint must not queue a second paint
run = drive({ elementFromPoint: () => bare });
run.fire('window', 'pointermove', { clientX: 10, clientY: 10 });
run.fire('window', 'pointermove', { clientX: 125, clientY: 75 });
expect(run.calls.rafQueued === 1, `pointer input must be rAF-throttled, not one paint per event (queued ${run.calls.rafQueued})`);
run.paint();
expect(run.calls.transform[0] === 'translate3d(120px, 60px, 0)', 'the paint must consume the latest pointer position, not the first');

// the lattice scrolls with the document, so the frame must compensate
run = drive({ elementFromPoint: () => bare, scrollY: 96 });
run.fire('window', 'pointermove', { clientX: 125, clientY: 75 });
run.paint();
expect(run.calls.transform[0] === 'translate3d(120px, 24px, 0)', `with scrollY=96 a pointer at y=75 is on cube row 2 (viewport y=24): ${run.calls.transform[0]}`);

// over a card the frame must go and stay off
run = drive({ elementFromPoint: () => overCard });
run.fire('window', 'pointermove', { clientX: 125, clientY: 75 });
run.paint();
expect(run.calls.transform.length === 0, 'the frame must never paint over an interactive surface');
expect(run.calls.on.length === 1 && run.calls.on[0] === false, 'the frame must switch off over an interactive surface');

// leaving the window, scrolling or blurring hides it
run = drive({ elementFromPoint: () => bare });
run.fire('window', 'pointermove', { clientX: 125, clientY: 75 });
run.paint();
run.fire('window', 'pointerleave');
run.fire('document', 'scroll');
run.fire('window', 'blur');
expect(run.calls.on.filter((v) => v === false).length >= 3, 'pointerleave, scroll and blur must each hide the frame');

// the density contract, asserted on the tokens the run actually sets
run = drive({ elementFromPoint: () => bare, dpr: 1 });
expect(run.calls.tokens['--cell'] === '60px', `at dpr 1 the cell must be 60px, got ${run.calls.tokens['--cell']}`);
expect(run.calls.tokens['--ring'] === '4px', `at dpr 1 the ring must be 4px, got ${run.calls.tokens['--ring']}`);
run = drive({ elementFromPoint: () => bare, dpr: 2 });
expect(run.calls.tokens['--cell'] === '30px', `at dpr 2 the cell must be 30px so one asset pixel stays one screen pixel, got ${run.calls.tokens['--cell']}`);
expect(run.calls.tokens['--ring'] === '2px', `at dpr 2 the ring must be 2px, got ${run.calls.tokens['--ring']}`);
run = drive({ elementFromPoint: () => bare, dpr: 2, latticeScale: '60' });
expect(run.calls.tokens['--cell'] === '60px', `a reader who asks for 60px cells must get 60px cells at any density, got ${run.calls.tokens['--cell']}`);

console.log('lattice contract: 60px cube, 4px inset white frame, pixelated tile, one asset px per screen px (60/4 at dpr 1, 30/2 at dpr 2) | behaviour: snap, throttle, scroll compensation, suppression, hiding');
if (problems.length === 0) {
  console.log('grid fx: the cube under the pointer is framed on its edges, and only there');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
