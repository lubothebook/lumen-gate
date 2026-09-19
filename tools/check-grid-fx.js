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
//      when the shape of the screen did not change.

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
const hoverRule = /\.cube:hover\s*\{[^}]*\}/.exec(html);
expect(Boolean(hoverRule), '.cube:hover rule missing: the pointer frame is the whole point');
if (hoverRule) {
  expect(/box-shadow:\s*inset 0 0 0 var\(--ring\) rgba\(255,\s*255,\s*255/.test(hoverRule[0]), 'the hover frame must be an inset white border drawn from the --ring token (4px on a 1x display)');
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

console.log('lattice contract: coded wall, one element per 60px cube, per-cube 4px hover frame, pixelated tile, one asset px per screen px (60/4 at dpr 1, 30/2 at dpr 2) | behaviour: density tokens, exact coverage, no pointless rebuild');
if (problems.length === 0) {
  console.log('grid fx: every cube is coded onto the grid and frames itself under the pointer, and only itself');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
