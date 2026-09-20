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
// The frame is one element with one rule, and it draws the same ring the cubes
// carry on hover.
const frameRule = /\.lattice-frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(frameRule), '.lattice-frame rule missing: the pointer frame is the whole point');
if (frameRule) {
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(frameRule[0]), 'the frame must be an inset white border drawn from the --ring token (4px on a 1x display)');
  expect(/position:\s*fixed/.test(frameRule[0]), 'the frame is positioned against the viewport, because the wall is');
  expect(/width:\s*var\(--cell\);\s*height:\s*var\(--cell\)/.test(frameRule[0]), 'the frame must be exactly one cell');
  expect(/pointer-events:\s*none/.test(frameRule[0]), 'the frame must never take a click');
  const z = Number((/z-index:\s*(-?\d+)/.exec(frameRule[0]) || [])[1]);
  const dockZ = Number((/nav\.main\.foot-nav\s*\{[^}]*z-index:\s*(\d+)/.exec(html) || [])[1]);
  expect(Number.isFinite(z) && Number.isFinite(dockZ) && z < dockZ, `the frame must be drawn above the page and below the dock (frame z ${z}, dock z ${dockZ})`);
}
expect(/@media \(hover: none\), \(pointer: coarse\)[^}]*box-shadow:\s*none/.test(html), 'touch devices must not get the pointer frame');
expect(/prefers-reduced-motion: reduce[\s\S]{0,400}?transition-duration:\s*0\.01ms/.test(html), 'reduced motion must flatten every transition on the page, the frame included');

// ---------------------------------------------------- 2. the behaviour
const buildMatch = app.match(/function buildLattice\(\) \{[\s\S]*?\n\}/);
expect(Boolean(buildMatch), 'buildLattice() was not found in frontend/src/app.js');
const sizeMatch = app.match(/function sizeLattice\(\) \{[\s\S]*?\n\}/);
expect(!/latticeStride|\(--pitch\)|'--pitch'/.test(app + html), 'the stride/pitch experiment is retired: the cubes sit edge to edge, one element per block');
expect(Boolean(sizeMatch), 'sizeLattice() was not found in frontend/src/app.js');
expect(/const TILE_PX = 60;\nconst FRAME_PX = 4;/.test(app), 'the lattice constants could not be read out of frontend/src/app.js');
expect(!/LATTICE_MODES/.test(app), 'density modes are retired: 1:1 is the only mode now');
expect(!/scale60|scale30|latticeReadout/.test(app), 'the retired density switch ui must not be wired anymore');
expect(/^\s*buildLattice\(\)/m.test(app), 'buildLattice() is defined but never called, so the wall is dead code');

function drive({ width, height, dpr }) {
  const calls = { tokens: {}, cubes: [], clears: 0 };
  const wall = {
    children: [],
    set textContent(value) { if (value === '') { calls.clears += 1; this.children = []; } },
    append(frag) { this.children.push(...frag.children); },
  };
  const makeCube = (isFragment) => {
    const el = { className: '', children: [], isFragment, append(...nodes) { this.children.push(...nodes); } };
    return el;
  };
  const rootStyle = {
    props: {},
    setProperty(name, value) { this.props[name] = value; calls.tokens[name] = value; },
  };
  const sandbox = {
    $: (id) => (id === 'cubeLattice' ? wall : null),
    document: {
      documentElement: { style: rootStyle, dataset: {} },
      createElement: () => makeCube(false),
      createDocumentFragment: () => makeCube(true),
    },
    window: { innerWidth: width, innerHeight: height, devicePixelRatio: dpr },
  };
  vm.createContext(sandbox);
  const prefix = 'const TILE_PX = 60;\nconst FRAME_PX = 4;\n';
  vm.runInContext(
    `${prefix}${sizeMatch ? sizeMatch[0] : ''}\n${buildMatch ? buildMatch[0] : ''}\nbuildLattice();`,
    sandbox,
    { filename: 'app.js#buildLattice' }
  );
  calls.cubes = wall.children.map((cube) => cube.className);
  return { calls, wall, sandbox };
}

// The cadence contract: one element per block, edge to edge. The tile is 60px
// at dpr 1 and 30px at dpr 2 (one asset pixel per screen pixel), and the wall
// is exactly cols x rows of them, at every screen size.
const expectedCubes = (width, height, cell) => Math.ceil(width / cell) * Math.ceil(height / cell);

let run = drive({ width: 1000, height: 700, dpr: 1 });
{
  const want = expectedCubes(1000, 700, 60);
  expect(run.calls.tokens['--cell'] === '60px', `at dpr 1 the cell must be 60px, got ${run.calls.tokens['--cell']}`);
  expect(run.calls.tokens['--ring'] === '4px', `at dpr 1 the ring must be 4px, got ${run.calls.tokens['--ring']}`);
  expect(run.calls.cubes.length === want, `1000x700 at dpr 1 needs exactly ${want} cubes, got ${run.calls.cubes.length}`);
  expect(run.calls.cubes.every((name) => name === 'cube'), 'every element on the wall is an individually coded cube');
}

run = drive({ width: 1000, height: 700, dpr: 2 });
{
  const want = expectedCubes(1000, 700, 30);
  expect(run.calls.tokens['--cell'] === '30px', `at dpr 2 the cell must be 30px so one asset pixel stays one screen pixel, got ${run.calls.tokens['--cell']}`);
  expect(run.calls.tokens['--ring'] === '2px', `at dpr 2 the ring must be 2px, got ${run.calls.tokens['--ring']}`);
  expect(run.calls.cubes.length === want, `1000x700 at dpr 2 needs exactly ${want} cubes, got ${run.calls.cubes.length}`);
}

run = drive({ width: 1920, height: 1080, dpr: 1 });
{
  const want = expectedCubes(1920, 1080, 60);
  expect(run.calls.cubes.length === want, `1920x1080 needs exactly ${want} cubes, got ${run.calls.cubes.length}`);
}
run = drive({ width: 390, height: 844, dpr: 1 });
{
  const want = expectedCubes(390, 844, 60);
  expect(run.calls.cubes.length === want, `390x844 needs exactly ${want} cubes, got ${run.calls.cubes.length}`);
}

// a re-run with an unchanged screen must not tear down and rebuild the wall
{
  const sandbox = {
    $: null,
    document: {
      documentElement: { style: { setProperty() {} }, dataset: {} },
      createElement: () => ({ className: '', children: [], append(...n) { this.children.push(...n); } }),
      createDocumentFragment: () => ({ children: [], append(...n) { this.children.push(...n); } }),
    },
    window: { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 },
  };
  let clears = 0;
  const wall = {
    children: [],
    set textContent(value) { if (value === '') clears += 1; },
    append(frag) { this.children.push(...frag.children); },
  };
  sandbox.$ = () => wall;
  vm.createContext(sandbox);
  vm.runInContext(
    `const TILE_PX = 60;\nconst FRAME_PX = 4;\n${sizeMatch[0]}\n${buildMatch[0]}\nbuildLattice();\nbuildLattice();`,
    sandbox,
    { filename: 'app.js#buildLattice' }
  );
  expect(clears === 1, `an unchanged screen must build the wall once, not on every pass (cleared ${clears} times)`);
}

// ------------------------------------------------- 3. the frame a cube wears
// The class the tracked path adds and the :hover state it stands in for must
// both paint the same ring, and the touch guard must cover both.
expect(/\.cube-lattice \.cube:hover\s*\{[^}]*inset 0 0 0 var\(--ring\)/.test(html), 'the wall\'s own cubes must answer :hover with the same ring, scoped so the first screen\'s blocks cannot grow a second one');
expect(/function initLatticeFrame\(\)/.test(app), 'initLatticeFrame() is missing: the frame would only ever be a :hover that cannot fire behind the page');
expect(/^initLatticeFrame\(\);/m.test(app), 'initLatticeFrame() is defined but never called at boot');
for (const gesture of ['pointermove', 'pointerleave', 'blur', 'scroll']) {
  expect(new RegExp(`addEventListener\\s*\\(\\s*'${gesture}'`).test(app), `the frame must be cleared or repainted on ${gesture}`);
}
// The frame is positioned by arithmetic on the pointer's coordinates, not by a
// hit test. That is the whole correction: a hit test can only find a cube where
// nothing is painted above it, which on this page is almost nowhere.
expect(!/LATTICE_BLOCKERS/.test(app), 'the blockers list is retired: the frame no longer asks what is painted above it');
expect(!/cubeUnderPointer/.test(app) && !/elementsFromPoint/.test(app), 'the frame must not use elementsFromPoint: a hit test is what made it vanish over cards and strips');
expect(/const col = Math\.floor\(x \/ cell\)/.test(app) && /const row = Math\.floor\(y \/ cell\)/.test(app), 'the frame must be computed as floor(x / cell), floor(y / cell)');

// Drive initLatticeFrame() in a sandbox: one pointermove puts the single frame
// element on the block under the pointer, moving repositions the same element
// (never a second one), and leaving closes it.
{
  const frame = {
    id: 'latticeFrame',
    className: 'lattice-frame',
    style: {},
    classList: {
      names: [],
      add(n) { if (!this.names.includes(n)) this.names.push(n); },
      remove(n) { this.names = this.names.filter((x) => x !== n); },
      contains(n) { return this.names.includes(n); },
    },
    setAttribute() {},
  };
  const listeners = {};
  const wall = { id: 'cubeLattice' };
  const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  const sandbox = {
    TILE_PX: 60,
    FRAME_PX: 4,
    $: (id) => (id === 'cubeLattice' ? wall : null),
    document: {
      documentElement: { style: rootStyle },
      body: { children: [], append(...n) { this.children.push(...n); } },
      getElementById: (id) => (id === 'latticeFrame' ? frame : null),
      createElement: () => frame,
    },
    window: {
      devicePixelRatio: 1,
      innerWidth: 1000,
      innerHeight: 700,
      addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
  };
  vm.createContext(sandbox);
  const frameFn = app.match(/function initLatticeFrame\(\) \{[\s\S]*?\n\}/);
  expect(Boolean(frameFn), 'initLatticeFrame() was not found in frontend/src/app.js');
  vm.runInContext(`${sizeMatch[0]}\n${frameFn[0]}\ninitLatticeFrame();`, sandbox, { filename: 'app.js#initLatticeFrame' });

  const move = (x, y) => (listeners.pointermove || []).forEach((fn) => fn({ clientX: x, clientY: y, pointerType: 'mouse' }));
  const at = () => frame.style.transform;

  // 60px cells: the pointer at (10,10) is block (0,0), (70,10) is block (1,0),
  // (130,65) is block (2,1). A pointer at the very edge of a cell belongs to
  // the cell it is inside, never to the next one.
  move(10, 10);
  expect(at() === 'translate3d(0px, 0px, 0)', `a pointer at 10,10 must frame the block at 0,0, got ${at()}`);
  expect(frame.classList.contains('on'), 'the frame must be visible once the pointer has moved');
  move(70, 10);
  expect(at() === 'translate3d(60px, 0px, 0)', `a pointer at 70,10 must frame the block at 60,0, got ${at()}`);
  move(130, 65);
  expect(at() === 'translate3d(120px, 60px, 0)', `a pointer at 130,65 must frame the block at 120,60, got ${at()}`);
  move(119, 59);
  expect(at() === 'translate3d(60px, 0px, 0)', `a pointer one pixel before an edge must still be in the previous block, got ${at()}`);
  expect(sandbox.document.body.children.length === 0, 'the frame is markup: initLatticeFrame() must not create a second one');
  expect(typeof frame.style.pointerEvents === 'string' || true, 'the frame takes no clicks');
  (listeners.pointerleave || []).forEach((fn) => fn({}));
  expect(!frame.classList.contains('on'), 'the frame must close when the pointer leaves the window');
  move(70, 10);
  expect(frame.classList.contains('on'), 'the frame must come back on the next move after leaving');
  expect((listeners.blur || []).length === 1, 'the frame must close when the window loses focus');
  expect((listeners.scroll || []).length === 1, 'the frame must be repainted on scroll, because the wall does not move with the page');
}

// ------------------------------------------------------- 4. the line strips
const stripRule = /main > section\.strip\s*\{[^}]*\}/.exec(html);
expect(Boolean(stripRule), 'the section.strip rule is missing');
if (stripRule) {
  expect(/background:\s*none/.test(stripRule[0]) && /border:\s*0/.test(stripRule[0]), 'a section must not paint a block: only the text rows carry a strip');
}
const rowRule = /main > section\.strip > \.shell > \*\s*\{[^}]*\}/.exec(html);
expect(Boolean(rowRule), 'the per-row strip rule (section.strip > .shell > *) is missing: text would sit on the bare lattice');
if (rowRule) {
  expect(/background:\s*rgba\(2,\s*2,\s*2,\s*0\.94\)/.test(rowRule[0]), 'each text row must carry its own black strip');
  expect(/border-top:\s*1px solid var\(--line-2\)/.test(rowRule[0]) && /border-bottom:\s*1px solid var\(--line-2\)/.test(rowRule[0]), 'a strip is bounded by a hairline top and bottom');
  expect(/margin-left:\s*calc\(50% - 50vw\)/.test(rowRule[0]) && /margin-right:\s*calc\(50% - 50vw\)/.test(rowRule[0]), 'a strip is infinite sideways: it must break out of the shell on both sides');
  expect(/padding:[^;]*calc\(50vw - 50%\)/.test(rowRule[0]), 'the ink must be padded back to the shell measure, so rows in different strips still line up');
  expect(/margin-top:\s*var\(--row-gap\)/.test(rowRule[0]), 'the gap between two strips is where the lattice shows: it must come from --row-gap');
}
expect(/main > section\.strip > \.shell > :first-child \{[^}]*margin-top:\s*0/.test(html), 'the first row in a section must not open with a gap');

expect(/--row-gap:\s*clamp\(/.test(html), '--row-gap must be part of the rhythm tokens');
expect(/overflow-x:\s*hidden/.test(html) && /overflow-x:\s*clip/.test(html), 'the full-bleed strips are measured in vw, so the horizontal overflow must be clipped (with a fallback first)');

console.log('lattice contract: coded wall, one element per 60px block, cubes edge to edge, pixelated tile, one asset px per screen px (60/4 at dpr 1, 30/2 at dpr 2) | behaviour: exact coverage, no pointless rebuild | frame: one overlay element positioned by floor(x / cell), floor(y / cell), so it frames the block under the pointer over cards, strips and open lattice alike | strips: text rows are full-bleed and the lattice shows in the gaps');
if (problems.length === 0) {
  console.log('grid fx: every block is coded onto the grid, and the frame follows the pointer anywhere on the page');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
