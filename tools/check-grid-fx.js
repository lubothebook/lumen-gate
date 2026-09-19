'use strict';

// Contract check for the coded lattice wall.
//
// The page background is the source chain: one cube per block, and every
// cube is its own element on a coded grid - not a png wallpaper. Each cube
// carries the submitted tile at the tile's own 60px (never resampled), and
// each cube answers the pointer itself: a 4px white inset frame while the
// pointer is over that cube, gone when it leaves. The behaviour is split
// between markup, CSS and buildLattice()/sizeLattice() in frontend/src/app.js,
// and a regression in any one of them fails silently: the page would still
// load, look finished and simply stop reacting, or worse, quietly turn the
// artwork back into a flat background image. This check therefore asserts
// both halves of the contract:
//
//   1. the static contract: the tile's own cell is 60px and the frame's own
//      border is 4px, the tile in frontend/public really is 60x60 and is the
//      file the manifest says it is, every cube is painted from the embedded
//      tile bytes at cell size with pixelated rendering, the hover frame is
//      an inset white border drawn from the ring token, one asset pixel is
//      one screen pixel (cell and ring divided by the device pixel ratio,
//      never multiplied), the wall element is aria-hidden paint, and the
//      guards (touch devices, reduced motion) exist. The body itself must
//      NOT paint the tile - a wallpaper would be the exact regression this
//      architecture replaced;
//   2. the behaviour: sizeLattice()/buildLattice() are extracted and driven
//      with synthetic viewports against a stub DOM, and must set 60/4 at
//      dpr 1 and 30/2 at dpr 2, must emit exactly cols x rows cube elements,
//      each an individual element with the cube class, and must not rebuild
//      when the shape of the screen did not change;
//   3. the correction: the cube CANNOT frame itself with :hover. The wall is
//      painted at z-index -1, so every wrapper above it - section, shell,
//      body - wins the hit test and a :hover on a cube never fires on the
//      live page. The frame is therefore painted by pointer tracking in
//      initLatticeFrame(), which must be wired at boot and must frame exactly
//      one cube, only where that cube is visible: a strip, a card, the
//      wallet band, the header, the footer or a dialog all hide it again.
//      cubeUnderPointer() is driven here with synthetic hit-test stacks,
//      because "the frame appears" is a behaviour, not a rule in a file;
//   4. the strips: text does not sit on a painted section. Each row of text
//      sits on its own full-bleed strip and the lattice stays visible in the
//      gaps between them, so the rules that make a row full-bleed (negative
//      vw margins, vw padding, the first-child reset, the overflow clip) are
//      part of the contract - drop any one and the band becomes a page-wide
//      block again, which is exactly what this round corrected.

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
  expect(/width:\s*var\(--cell\);\s*height:\s*var\(--cell\)/.test(cubeRule[0]), 'every cube is exactly one cell');
  expect(/transition:\s*box-shadow/.test(cubeRule[0]), 'the frame on a cube fades in and out rather than popping');
}
// The frame is one rule with two selectors: :hover for anything that can still
// reach it, .frame for the tracked path the live page actually uses.
const hoverRule = /\.cube:hover,\s*\.cube\.frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(hoverRule), '.cube:hover/.cube.frame rule missing: the pointer frame is the whole point');
if (hoverRule) {
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(hoverRule[0]), 'the frame must be an inset white border drawn from the --ring token (4px on a 1x display)');
}
expect(/@media \(hover: none\), \(pointer: coarse\)[^}]*\.cube:hover[^}]*box-shadow:\s*none/.test(html), 'touch devices must not get the pointer frame');
expect(/prefers-reduced-motion: reduce[^}]*\.cube[^}]*transition:\s*none/.test(html.replace(/\{ /g, '{')), 'reduced motion must remove the frame transition');

// ---------------------------------------------------- 2. the behaviour
const buildMatch = app.match(/function buildLattice\(\) \{[\s\S]*?\n\}/);
expect(Boolean(buildMatch), 'buildLattice() was not found in frontend/src/app.js');
const sizeMatch = app.match(/function sizeLattice\(\) \{[\s\S]*?\n\}/);
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
  vm.runInContext(`${prefix}${sizeMatch ? sizeMatch[0] : ''}\n${buildMatch ? buildMatch[0] : ''}\nbuildLattice();`, sandbox, { filename: 'app.js#buildLattice' });
  calls.cubes = wall.children.map((cube) => cube.className);
  return { calls, wall, sandbox };
}

// the density contract, asserted on the tokens the run actually sets
let run = drive({ width: 1000, height: 700, dpr: 1 });
expect(run.calls.tokens['--cell'] === '60px', `at dpr 1 the cell must be 60px, got ${run.calls.tokens['--cell']}`);
expect(run.calls.tokens['--ring'] === '4px', `at dpr 1 the ring must be 4px, got ${run.calls.tokens['--ring']}`);
expect(run.calls.cubes.length === Math.ceil(1000 / 60) * Math.ceil(700 / 60), `1000x700 at dpr 1 needs exactly ${Math.ceil(1000 / 60) * Math.ceil(700 / 60)} cubes, got ${run.calls.cubes.length}`);
expect(run.calls.cubes.every((name) => name === 'cube'), 'every element on the wall is an individually coded cube');

run = drive({ width: 1000, height: 700, dpr: 2 });
expect(run.calls.tokens['--cell'] === '30px', `at dpr 2 the cell must be 30px so one asset pixel stays one screen pixel, got ${run.calls.tokens['--cell']}`);
expect(run.calls.tokens['--ring'] === '2px', `at dpr 2 the ring must be 2px, got ${run.calls.tokens['--ring']}`);
expect(run.calls.cubes.length === Math.ceil(1000 / 30) * Math.ceil(700 / 30), `1000x700 at dpr 2 needs exactly ${Math.ceil(1000 / 30) * Math.ceil(700 / 30)} cubes, got ${run.calls.cubes.length}`);

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
  vm.runInContext(`const TILE_PX = 60;\nconst FRAME_PX = 4;\n${sizeMatch[0]}\n${buildMatch[0]}\nbuildLattice();\nbuildLattice();`, sandbox, { filename: 'app.js#buildLattice' });
  expect(clears === 1, `an unchanged screen must build the wall once, not on every pass (cleared ${clears} times)`);
}

// ------------------------------------------------- 3. the frame a cube wears
// The class the tracked path adds and the :hover state it stands in for must
// both paint the same ring, and the touch guard must cover both.
const frameRule = /\.cube:hover,\s*\.cube\.frame\s*\{[^}]*\}/.exec(html);
expect(Boolean(frameRule), 'the .cube:hover rule must also accept .cube.frame: the tracked path and the hover path paint the same frame');
if (frameRule) {
  expect(/inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(frameRule[0]), 'the tracked frame must be the same inset white ring as the hover frame');
}
expect(/\.cube:hover,\s*\.cube\.frame[^}]*box-shadow:\s*none/.test(html), 'touch devices must not get the tracked frame either');
expect(/function initLatticeFrame\(\)/.test(app), 'initLatticeFrame() is missing: the frame would only ever be a :hover that cannot fire behind the page');
expect(/^initLatticeFrame\(\);/m.test(app), 'initLatticeFrame() is defined but never called at boot');
for (const gesture of ['pointermove', 'pointerleave', 'blur', 'scroll']) {
  expect(new RegExp(`addEventListener\\s*\\(\\s*'${gesture}'`).test(app), `the frame must be cleared or repainted on ${gesture}`);
}
expect(/LATTICE_BLOCKERS/.test(app) && /\.hero-panel/.test(app) && /\.card/.test(app), 'the blockers list must name the surfaces that hide the lattice (strips, cards, the band, chrome)');

// Drive cubeUnderPointer() with synthetic hit-test stacks: the topmost cube
// wins only when nothing opaque sits above it.
const blockers = [...(app.match(/const LATTICE_BLOCKERS = \[[\s\S]*?\];/) || [''])[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
expect(blockers.length >= 6, 'LATTICE_BLOCKERS should list the page surfaces that cover the lattice');
const underMatch = app.match(/function cubeUnderPointer\([\s\S]*?\n\}/);
expect(Boolean(underMatch), 'cubeUnderPointer() was not found in frontend/src/app.js');
if (underMatch) {
  // A synthetic hit-test stack, topmost first, exactly as elementsFromPoint
  // returns it. Each node answers only the selectors it really matches.
  const node = (name, matched) => ({
    name,
    classList: { values: name.split(' '), contains: (c) => name.split(' ').includes(c) },
    matches: (sel) => matched.includes(sel),
  });
  const cube = node('cube', []);
  const sandbox = { LATTICE_BLOCKERS: blockers };
  vm.createContext(sandbox);
  vm.runInContext(`${underMatch[0]}\ncubeUnderPointer = cubeUnderPointer;`, sandbox, { filename: 'app.js#cubeUnderPointer' });
  const under = sandbox.cubeUnderPointer;
  const section = node('strip', []);
  const shell = node('shell', []);
  expect(under([shell, section, node('main', []), cube, node('cube-lattice', [])]) === cube, 'a cube directly under the pointer in an open gap must be the one framed');
  expect(under([node('card', ['.card']), shell, cube]) === null, 'a card above the cube must hide the frame');
  expect(under([node('hero-panel', ['.hero-panel']), cube]) === null, 'the hero panel must hide the frame');
  expect(under([node('band', ['.band']), cube]) === null, 'the wallet band must hide the frame');
  expect(under([node('top', ['header.top']), cube]) === null, 'the header must hide the frame');
  expect(under([node('boundary', ['.boundary']), cube]) === null, 'the settlement boundary strip must hide the frame');
  expect(under([node('sec-head', ['main > section.strip > .shell > *']), shell, cube]) === null, 'a text strip must hide the frame - the lattice only shows in the gaps');
  expect(under([node('body', [])]) === null, 'a pointer over no cube at all must frame nothing');
}

// The same function, with a live sandbox: one pointermove frames exactly one
// cube, moving to another cube drops the first, and leaving clears it.
{
  const wall = { id: 'cubeLattice' };
  const cubes = [node2('cube', []), node2('cube', []), node2('cube', [])];
  cubes.forEach((c) => c.classes.push('cube'));
  function node2(name, matched) {
    const classes = [];
    return {
      name,
      matched,
      classes,
      matches: (sel) => matched.includes(sel),
      classList: {
        contains: (c) => classes.includes(c),
        add(c) { if (!classes.includes(c)) classes.push(c); },
        remove(c) { const i = classes.indexOf(c); if (i !== -1) classes.splice(i, 1); },
      },
    };
  }
  const openGap = [node2('shell', []), node2('strip', [])];
  let stack = [...openGap, cubes[0]];
  const listeners = {};
  const sandbox = {
    $: () => wall,
    document: { elementsFromPoint: () => stack },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    window: { addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); } },
    LATTICE_BLOCKERS: blockers,
    PointerEvent: function PointerEvent() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${underMatch[0]}\n${app.match(/function initLatticeFrame\(\) \{[\s\S]*?\n\}/)[0]}\ninitLatticeFrame();`, sandbox, { filename: 'app.js#initLatticeFrame' });
  const move = (x, y, type) => (listeners.pointermove || []).forEach((fn) => fn({ clientX: x, clientY: y, pointerType: type }));
  const framed = () => cubes.filter((c) => c.classes.includes('frame')).map((c) => cubes.indexOf(c));
  move(10, 10);
  expect(framed().join() === '0', `a pointermove over cube 0 must frame exactly that cube, got [${framed()}]`);
  stack = [...openGap, cubes[1]];
  move(70, 10);
  expect(framed().join() === '1', `moving to cube 1 must leave exactly it framed, got [${framed()}]`);
  stack = [node2('card', ['.card']), ...openGap, cubes[2]];
  move(130, 10);
  expect(framed().length === 0, 'moving over a card must close the frame entirely');
  expect((listeners.pointerleave || []).length === 1, 'the frame must be closed when the pointer leaves the window');
  expect((listeners.scroll || []).length === 1, 'the frame must be closed on scroll, so it cannot survive a re-layout');
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

console.log('lattice contract: coded wall, one element per 60px cube, per-cube 4px frame (painted by pointer tracking, since the wall lives behind the page), pixelated tile, one asset px per screen px (60/4 at dpr 1, 30/2 at dpr 2) | behaviour: density tokens, exact coverage, no pointless rebuild, one framed cube at a time | strips: text rows are full-bleed and the lattice shows in the gaps');
if (problems.length === 0) {
  console.log('grid fx: every cube is coded onto the grid and frames itself under the pointer, and only itself');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
