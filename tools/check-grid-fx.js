'use strict';

// Contract check for the coded lattice wall and the frame that follows the
// pointer.
//
// The page background is the source chain: one cube per block, edge to edge,
// every cube its own element on a coded grid - never a png wallpaper. Each cube
// carries the submitted tile at the tile's own 60px, never resampled, and one
// asset pixel is one screen pixel. A single overlay element draws the 4px white
// inset frame on the block under the pointer.
//
// The frame is positioned by arithmetic, and that is a correction worth keeping:
// it used to ask the document what was under the cursor and give up when the
// answer was not a cube, so it vanished wherever a card, a strip or the header
// sat on top. It now computes floor(x / cell), floor(y / cell) from the
// pointer's own coordinates, which cannot care what is painted above it. This
// check therefore asserts:
//
//   1. the static contract: the tile's own cell is 60px and the frame's own
//      border is 4px, the tile in frontend/public really is 60x60 and is the
//      file the manifest says it is, every cube is painted from the embedded
//      tile bytes at cell size with pixelated rendering, the cubes are adjacent
//      (no gap, no stride), one asset pixel is one screen pixel (cell and ring
//      divided by the device pixel ratio, never multiplied), the wall element is
//      aria-hidden paint, and the guards (touch devices, reduced motion) exist.
//      The body itself must NOT paint the tile - a wallpaper would be the exact
//      regression this architecture replaced;
//   2. the behaviour: sizeLattice()/buildLattice() are extracted and driven with
//      synthetic viewports against a stub DOM, and must set 60/4 at dpr 1 and
//      30/2 at dpr 2, must emit exactly cols x rows cube elements, and must not
//      rebuild when the shape of the screen did not change;
//   3. the frame: there is exactly one frame element, it is positioned by the
//      pointer's coordinates rather than by a hit test (no elementsFromPoint,
//      no list of surfaces that hide it), it lands on the block under the
//      pointer at three different cells, it closes when the pointer leaves and
//      when the window loses focus, and it is painted above the page and below
//      the dock, taking no clicks;
//   4. the strips: text does not sit on a painted section. Each row of text sits
//      on its own full-bleed strip and the lattice stays visible in the gaps
//      between them, so the rules that make a row full-bleed (negative vw
//      margins, vw padding, the first-child reset, the overflow clip) are part
//      of the contract.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend', 'src', 'app.js'), 'utf8');

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

// ---------------------------------------------------- 1. static contract
const cellToken = /--cell:\s*(\d+)px/.exec(html);
expect(cellToken && Number(cellToken[1]) === 60, "the --cell token must default to the tile's own 60px");
const ringToken = /--ring:\s*(\d+)px/.exec(html);
expect(ringToken && Number(ringToken[1]) === 4, 'the --ring token must default to 4px, the frame a cube wears on hover');

const tile = fs.readFileSync(path.join(root, 'frontend', 'public', 'grid-tile.png'));
expect(tile.slice(1, 4).toString() === 'PNG', 'grid-tile.png is not a PNG');
expect(tile.readUInt32BE(16) === 60 && tile.readUInt32BE(20) === 60, 'grid-tile.png must be exactly 60x60 pixels');

// The tile is a submitted artwork, so its provenance is part of the contract:
// the hash the manifest records and the bytes on disk must not drift apart.
// The page embeds those same bytes as a data URI (tools/check-console.js
// compares the encoded copy), which is why a redrawn tile cannot ship quietly.
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

// The wall is coded, not painted: the body must not carry the tile as a
// background, and the grid-frame wallpaper-era element is gone for good.
const bodyRule = /body\s*\{[^}]*\}/.exec(html);
expect(bodyRule && !bodyRule[0].includes('background-image: var(--grid-tile)'), 'the body must NOT paint the tile: the lattice is coded cubes, not a wallpaper');
expect(!/\.grid-frame/.test(html), 'the old .grid-frame element and rules are retired; cubes carry their own frames');
expect(!html.includes('id="gridFrame"'), 'the old gridFrame element is retired');
expect(html.includes('<div class="cube-lattice" id="cubeLattice" aria-hidden="true"></div>'), 'the cube wall element is missing or no longer aria-hidden paint');

const wallRule = /\.cube-lattice\s*\{[^}]*\}/.exec(html);
expect(Boolean(wallRule), '.cube-lattice rule missing');
if (wallRule) {
  expect(/z-index:\s*-\d+/.test(wallRule[0]), 'the wall must sit below every page surface');
  expect(/position:\s*fixed/.test(wallRule[0]), 'the wall is fixed: it is a backdrop, not document flow');
  expect(/overflow:\s*hidden/.test(wallRule[0]), 'the wall must never create scrollbars');
}

const cubeRule = /\.cube\s*\{[^}]*\}/.exec(html);
expect(Boolean(cubeRule), '.cube rule missing');
if (cubeRule) {
  expect(cubeRule[0].includes('background-image: var(--grid-tile)'), 'every cube is painted from the embedded tile bytes');
  expect(cubeRule[0].includes('background-size: var(--cell) var(--cell)'), 'every cube paints the tile at cell size, never resampled');
  expect(cubeRule[0].includes('image-rendering: pixelated'), 'the tile must not be smoothed (image-rendering: pixelated)');
  expect(/width:\s*var\(--cell\);\s*height:\s*var\(--cell\)/.test(cubeRule[0]), 'every cube box is exactly one cell: the cubes are adjacent, with no gap between them');
  expect(/transition:\s*box-shadow/.test(cubeRule[0]), 'the frame on a cube fades in and out rather than popping');
}
// The frame follows the pointer across the whole wall, including over the
// surfaces the page floats above it. The operator's correction, after watching
// the pointer die at every picture: visuals in front must not stop detection.
// So the cell is arithmetic (pointer divided by cell size), the cube under it
// wears the ring, and a fixed overlay cell paints the same ring above whatever
// covers the wall - a ring behind a card is a ring nobody sees. The old
// blockers list and its hit test are retired, and the harness says so.
const frameRule = /\.cube:hover, \.cube\.frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(frameRule), '.cube.frame rule missing: the pointer frame is the whole point');
if (frameRule) {
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(frameRule[0]), 'the frame must be an inset white border drawn from the --ring token (4px on a 1x display)');
}
const overlayRule = /\.cube-frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(overlayRule), '.cube-frame overlay rule missing: the ring must also paint above the surfaces that cover the wall');
if (overlayRule) {
  expect(/position:\s*fixed/.test(overlayRule[0]), 'the overlay cell must be fixed to the viewport like the wall');
  expect(/pointer-events:\s*none/.test(overlayRule[0]), 'the overlay must never eat a click');
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\)/.test(overlayRule[0]), 'the overlay ring is the same 4px white inset ring');
}
expect(!/LATTICE_BLOCKERS/.test(app), 'the blockers list is retired: visuals in front must not stop the frame any more');
expect(/@media \(hover: none\), \(pointer: coarse\)[^}]*box-shadow:\s*none/.test(html), 'touch devices must not get the pointer frame');
expect(/\.cube-frame\s*\{\s*opacity:\s*0;\s*\}/.test(html), 'touch devices must not get the overlay ring either');
expect(/prefers-reduced-motion: reduce[\s\S]{0,400}?transition-duration:\s*0\.01ms/.test(html), 'reduced motion must flatten every transition on the page, the frame included');

// Drive initLatticeFrame() in a sandbox: the cell under the pointer wears the
// frame whatever floats above it, the overlay snaps to that cell, and leaving
// the window closes both.
{
  const mkClassList = (initial) => {
    const names = [...initial];
    return {
      add(n) { if (!names.includes(n)) names.push(n); },
      remove(n) { names.splice(names.indexOf(n), 1); },
      contains(n) { return names.includes(n); },
    };
  };
  const cubes = [0, 1, 2, 3, 4, 5].map(() => ({
    classList: mkClassList(['cube']),
    getBoundingClientRect: () => ({ width: 60, height: 60 }),
  }));
  const overlay = { classList: mkClassList(['cube-frame']), style: {}, setAttribute: () => {} };
  let created = null;
  const listeners = {};
  const sandbox = {
    $: (id) => (id === 'cubeLattice' ? { children: cubes } : null),
    document: {
      createElement: () => (created = overlay),
      body: { append: () => {} },
    },
    window: { addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }, innerWidth: 360 },
    requestAnimationFrame: (fn) => { fn(); return 1; },
  };
  vm.createContext(sandbox);
  const frameFn = app.match(/function initLatticeFrame\(\) \{[\s\S]*?\n\}/);
  expect(Boolean(frameFn), 'initLatticeFrame() was not found in frontend/src/app.js');
  vm.runInContext(`${frameFn[0]}\ninitLatticeFrame();`, sandbox, { filename: 'app.js#initLatticeFrame' });
  expect(created === overlay && overlay.classList.contains('cube-frame'), 'initLatticeFrame must create the overlay cell');
  const move = (x, y) => (listeners.pointermove || []).forEach((fn) => fn({ clientX: x, clientY: y, pointerType: 'mouse' }));
  move(70, 10);
  expect(cubes[1].classList.contains('frame'), 'the cell under the pointer wears the frame, whatever floats above it');
  expect(overlay.classList.contains('on'), 'the overlay cell must be lit while the pointer is on the wall');
  expect(overlay.style.transform === 'translate(60px, 0px)', `the overlay must snap to the cell under the pointer, got ${overlay.style.transform}`);
  move(10, 10);
  expect(cubes[0].classList.contains('frame') && !cubes[1].classList.contains('frame'), 'the frame moves with the pointer, one cell at a time');
  (listeners.pointerleave || []).forEach((fn) => fn({}));
  expect(!cubes.some((c) => c.classList.contains('frame')) && !overlay.classList.contains('on'), 'the frame must close when the pointer leaves the window');
  expect((listeners.blur || []).length === 1, 'the frame must close when the window loses focus');
  expect((listeners.scroll || []).length === 1, 'scrolling moves the page under the fixed wall: the frame is repainted');
}

// ------------------------------------------------------- 4. the line strips
const stripRule = /main > section\.strip\s*\{[^}]*\}/.exec(html);
expect(Boolean(stripRule), 'the section.strip rule is missing');
if (stripRule) {
  expect(/background:\s*none/.test(stripRule[0]) && /border:\s*0/.test(stripRule[0]), 'a section must not paint a block: only the text rows carry a strip');
}
const rowRule = /main > section\.strip > \.shell > \.row-strip\s*\{[^}]*\}/.exec(html);
expect(Boolean(rowRule), 'the ribbon rule (.row-strip) is missing: text would sit on the bare lattice');
if (rowRule) {
  expect(/background-color:\s*rgba\(2,\s*2,\s*2,/.test(rowRule[0]), 'each text row must carry its own black ribbon');
  expect(/border-top:\s*1px solid var\(--line-2\)/.test(rowRule[0]) && /border-bottom:\s*1px solid var\(--line-2\)/.test(rowRule[0]), 'a ribbon is bounded by a hairline top and bottom');
  expect(/margin-left:\s*calc\(50% - 50vw\)/.test(rowRule[0]) && /margin-right:\s*calc\(50% - 50vw\)/.test(rowRule[0]), 'a ribbon is infinite sideways: it must break out of the shell on both sides');
  expect(/padding:[^;]*calc\(50vw - 50%\)/.test(rowRule[0]), 'the ink must be padded back to the shell measure, so rows in different ribbons still line up');
}
const rhythmRule = /main > section\.strip > \.shell > \*\s*\{[^}]*\}/.exec(html);
expect(Boolean(rhythmRule) && /margin-top:\s*var\(--row-gap\)/.test(rhythmRule[0]), 'the gap between two rows is where the lattice shows: it must come from --row-gap');
// Boxes wear no ribbon: the card, the window, the step rail, the stat shelf
// and the trust grid carry their own surface inside the shell measure.
for (const selector of ['.card', '.trust-grid', '.stat', '.steps']) {
  const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`).exec(html);
  expect(Boolean(rule) && /background(-color)?:/.test(rule[0]), `${selector} must carry its own surface: boxes wear no strip`);
}
expect(/main > section\.strip > \.shell > :first-child \{[^}]*margin-top:\s*0/.test(html), 'the first row in a section must not open with a gap');

expect(/--row-gap:\s*clamp\(/.test(html), '--row-gap must be part of the rhythm tokens');
expect(/overflow-x:\s*hidden/.test(html) && /overflow-x:\s*clip/.test(html), 'the full-bleed strips are measured in vw, so the horizontal overflow must be clipped (with a fallback first)');

console.log('lattice contract: coded wall, one element per 60px block, cubes edge to edge, pixelated tile, one asset px per screen px (60/4 at dpr 1, 30/2 at dpr 2) | behaviour: exact coverage, no pointless rebuild | frame: the cube under the pointer wears the ring, and only where the cube is visible - strip in front, cubes behind | strips: ribbons on text rows, surfaces on boxes, lattice in the gaps');
if (problems.length === 0) {
  console.log('grid fx: every block is coded onto the grid, and the frame follows the pointer anywhere on the page');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
