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
//   1. the static contract: the cell token is 60px, the frame is one cell
//      with a 4px inset white frame, the tile in frontend/public really is
//      60x60, and the hiding rules (touch devices, reduced motion) exist;
//   2. the behaviour: watchGrid() is extracted and driven with synthetic
//      pointer events against a stub DOM, and must snap the frame to the
//      right cube, account for the scrolled lattice, stay off interactive
//      surfaces, and hide when the pointer leaves, scrolls or blurs.

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
expect(cellToken && Number(cellToken[1]) === 60, 'the --cell token must be 60px so one cube is one submitted block');

const tile = fs.readFileSync(path.join(root, 'frontend', 'public', 'grid-tile.png'));
expect(tile.slice(1, 4).toString() === 'PNG', 'grid-tile.png is not a PNG');
expect(tile.readUInt32BE(16) === 60 && tile.readUInt32BE(20) === 60, 'grid-tile.png must be exactly 60x60 pixels');

const bodyRule = /body\s*\{[^}]*\}/.exec(html);
expect(bodyRule && bodyRule[0].includes('background-image: var(--grid-tile)'), 'the body must paint the lattice from --grid-tile');
expect(bodyRule && bodyRule[0].includes('background-size: var(--cell) var(--cell)'), 'the lattice must be painted at cell size, never resampled');
expect(bodyRule && bodyRule[0].includes('image-rendering: pixelated'), 'the lattice must not be smoothed (image-rendering: pixelated)');

const frameRule = /\.grid-frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(frameRule), '.grid-frame rule missing');
if (frameRule) {
  expect(/box-shadow:\s*inset 0 0 0 4px rgba\(255,\s*255,\s*255/.test(frameRule[0]), 'the frame must be a 4px inset white border on the cube edges');
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
expect(/^\s*watchGrid\(\)/m.test(app), 'watchGrid() is defined but never called, so the frame is dead code');

function drive({ elementFromPoint, scrollY = 0 }) {
  const calls = { on: [], transform: [], rafQueued: 0 };
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
  const sandbox = {
    $: () => frameStub,
    document: {
      documentElement: {},
      elementFromPoint,
      addEventListener: (type, fn) => { (listeners.document[type] ||= []).push(fn); },
    },
    window: {
      scrollY,
      addEventListener: (type, fn) => { (listeners.window[type] ||= []).push(fn); },
    },
    getComputedStyle: () => ({ getPropertyValue: () => ' 60px' }),
    requestAnimationFrame: (fn) => { raf = fn; calls.rafQueued += 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnMatch ? fnMatch[0] : ''}\nwatchGrid();`, sandbox, { filename: 'app.js#watchGrid' });
  const fire = (target, type, event) => { for (const fn of listeners[target][type] || []) fn(event || {}); };
  const paint = () => { const fn = raf; raf = null; if (fn) fn(); };
  return { calls, fire, paint };
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

console.log('lattice contract: 60px cube, 4px inset white frame, pixelated tile | behaviour: snap, throttle, scroll compensation, suppression, hiding');
if (problems.length === 0) {
  console.log('grid fx: the cube under the pointer is framed on its edges, and only there');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
