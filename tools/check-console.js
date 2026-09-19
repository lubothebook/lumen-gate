'use strict';

// Static wiring check for the console.
//
// A single typo in a selector produces an interface that loads, looks finished
// and silently does nothing - the worst failure mode a demo can have, because
// nothing in a test suite or a contract call notices it. This walks the markup
// and the module and insists that every element the code looks up exists, that
// every navigation entry has a section, and that every section is reachable.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'frontend', 'index.html');
const appPath = path.join(root, 'frontend', 'src', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const lookups = new Set(
  [...app.matchAll(/\$\('([^']+)'\)/g), ...app.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])
);
const stepLookups = Object.keys(
  Object.fromEntries([...app.matchAll(/^\s+(lock|finality|mint): '([^']+)',/gm)].map((m) => [m[1], m[2]]))
).map((key) => app.match(new RegExp(`${key}: '([^']+)'`))[1]);

const navTargets = new Set([...html.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]));
const sections = new Set([...html.matchAll(/\sid="view-([^"]+)"/g)].map((match) => match[1]));

const problems = [];
for (const id of [...lookups, ...stepLookups]) {
  if (!ids.has(id)) problems.push(`src/app.js looks up #${id}, which the markup does not define`);
}
for (const target of navTargets) {
  if (!sections.has(target)) problems.push(`navigation entry "${target}" has no #view-${target} section`);
}
for (const section of sections) {
  if (!navTargets.has(section)) problems.push(`section "#view-${section}" is not reachable from the navigation`);
}

console.log(`markup ids: ${ids.size} | code lookups: ${lookups.size + stepLookups.length} | sections: ${sections.size}`);
if (problems.length === 0) {
  console.log('console wiring: every selector resolves and every section is reachable');
  process.exit(0);
}
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
