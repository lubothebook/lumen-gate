'use strict';

// Static wiring check for the console.
//
// A single typo in a selector produces an interface that loads, looks finished
// and silently does nothing - the worst failure mode a demo can have, because
// nothing in a test suite or a contract call notices it. This walks the markup
// and the module and insists that:
//
//   1. every element the code looks up exists,
//   2. every navigation target exists as an anchor on the page,
//   3. the images embedded in the page are the images in frontend/public,
//   4. a control that cannot act says why: every disabled button points at the
//      note that explains it, and every button the code disables is covered by
//      the reasons table that copies that note into the button's own title.
//
// The fourth rule came out of clicking the live page rather than reading it:
// four disabled controls, two of them silent. A stylesheet read cannot notice
// that, and neither can a contract test, so it is written down twice here and
// once in tools/check-live-actions.js, which clicks them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'frontend', 'index.html');
const appPath = path.join(root, 'frontend', 'src', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const lookups = new Set(
  [...app.matchAll(/\$\('([^']+)'\)/g), ...app.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])
);
// Element ids the code reaches for through a step table rather than $().
for (const match of app.matchAll(/^\s+(?:lock|finality|mint): '([^']+)',/gm)) lookups.add(match[1]);

const navTargets = [...html.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);

// ---------------------------------------------------------------- rule 4
// A grey button with no explanation is the failure the operator named. Static
// half: the markup must point every disabled button at a note, and the module
// must carry that button in the table that paints the title from the note.
const disabledButtons = [...html.matchAll(/<button[^>]*\bdisabled\b[^>]*>/g)].map((match) => match[0]);
const disabledWithoutNote = disabledButtons.filter((tag) => !/aria-describedby="([^"]+)"/.test(tag));
const reasonsTable = (app.match(/const DISABLED_REASONS = \[[\s\S]*?\];/) || [''])[0];
const painted = new Set([...reasonsTable.matchAll(/control: '([^']+)'/g)].map((match) => match[1]));
// Every button the module can disable has to be in that table.
const switched = new Set([...app.matchAll(/\$\('([A-Za-z0-9_]+)'\)\.disabled\s*=/g)].map((match) => match[1]));

const problems = [];

// The module has to be valid as a module, not just as text. A stray apostrophe
// inside a single-quoted string parse-fails in the browser and leaves a page
// that loads and does nothing - the exact failure this check exists to catch.
// Node can only check ESM syntax from an .mjs path, so copy it there first.
try {
  const temp = path.join(os.tmpdir(), `lumen-gate-app-${process.pid}.mjs`);
  fs.copyFileSync(appPath, temp);
  execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
  fs.unlinkSync(temp);
} catch (error) {
  const detail = String((error.stderr || error.message || error)).split('\n').filter((line) => line.trim()).slice(0, 3).join(' | ');
  problems.push(`frontend/src/app.js is not valid JavaScript: ${detail}`);
}

for (const id of lookups) {
  if (!ids.has(id)) problems.push(`src/app.js looks up #${id}, which the markup does not define`);
}
if (navTargets.length === 0) problems.push('the page has no navigation entries at all');
for (const target of navTargets) {
  if (!ids.has(target)) problems.push(`navigation entry "${target}" points at #${target}, which does not exist`);
}
for (const id of ['top', 'console', 'evidence', 'about']) {
  if (ids.has(id) && !navTargets.includes(id)) problems.push(`section #${id} is not reachable from the navigation`);
}

for (const tag of disabledWithoutNote) {
  const id = (/id="([^"]+)"/.exec(tag) || [])[1] || tag;
  problems.push(`#${id} is disabled in the markup but does not point at the note that explains why (aria-describedby)`);
}
for (const tag of disabledButtons) {
  const described = /aria-describedby="([^"]+)"/.exec(tag);
  if (described && !ids.has(described[1])) {
    problems.push(`a disabled button points at #${described[1]}, which the markup does not define`);
  }
}
for (const id of switched) {
  if (!painted.has(id)) {
    problems.push(`#${id} is disabled by the code but is not in DISABLED_REASONS, so it would sit grey with no stated reason`);
  }
}
if (disabledButtons.length > 0 && painted.size === 0) {
  problems.push('the page disables buttons, so DISABLED_REASONS must exist and cover them');
}

// Regression gate for the 2026-09-20 live-page bug: the decorative lattice
// must not be able to paint over the wallet console. The lift is required on
// .band itself as a standalone rule (position: relative before z-index: 1),
// not only in the combined selector near the hero, so a refactor of that
// selector cannot silently drop it and eat the wallet's clicks again.
const bandLift = [...html.matchAll(/\.band\s*\{[^}]*position\s*:\s*relative\s*;[^}]*z-index\s*:\s*1\s*;/g)];
if (bandLift.length !== 1) {
  problems.push('index.html must lift the wallet band above the lattice: a standalone .band rule carrying position: relative and z-index: 1');
}

// The page carries its two images as base64 so it renders with no network at
// all (a sandboxed preview, an offline reviewer). That guarantee only holds if
// the embedded bytes are still the bytes in frontend/public.
const assetExpectations = [
  { file: 'grid-tile.png', label: 'grid tile' },
  { file: 'logo-mark.png', label: 'logo mark' },
  { file: 'wordmark.png', label: 'wordmark' },
  { file: 'lumen-gate-banner.png', label: 'hero banner' },
  { file: 'favicon.png', label: 'favicon' },
];
let embeddedCount = 0;
for (const { file, label } of assetExpectations) {
  const assetPath = path.join(root, 'frontend', 'public', file);
  if (!fs.existsSync(assetPath)) {
    problems.push(`frontend/public/${file} is missing: the ${label} cannot be embedded or served`);
    continue;
  }
  const wanted = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
  const encoded = Buffer.from(fs.readFileSync(assetPath)).toString('base64');
  if (!html.includes(encoded)) {
    problems.push(`the ${label} embedded in index.html is not frontend/public/${file} (sha256 ${wanted.slice(0, 12)}): regenerate the data URI`);
  } else {
    embeddedCount += 1;
  }
}

console.log(
  `markup ids: ${ids.size} | code lookups: ${lookups.size} | nav targets: ${navTargets.length} | embedded assets verified: ${embeddedCount}/${assetExpectations.length} | disabled controls with a stated reason: ${disabledButtons.length - disabledWithoutNote.length}/${disabledButtons.length}, ${switched.size} code-switched buttons in the reasons table`
);
if (problems.length === 0) {
  console.log('console wiring: every selector resolves, every nav target exists, embedded assets match frontend/public');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
