'use strict';

// The page, checked in a real browser.
//
// Every other check in tools/ reads files: it can prove that a rule exists,
// that a selector resolves, that a token is spelled the way the contract says.
// None of them can prove that the page *does* the thing, and this round made
// that gap expensive. The lattice frame was written as a `:hover` on the cube;
// the cube is painted at z-index -1, so every wrapper above it wins the hit
// test, and the frame had never once appeared on the live page - a claim in
// the README, a rule in the CSS, a green check, and no frame. The same round
// moved the black strips from the section to the text rows, which is geometry:
// whether a strip really runs edge to edge, and whether the lattice really
// shows in the gap between two of them, is not visible in a stylesheet.
//
// So this harness drives the actual page with an actual browser and asserts
// what a person would see. It is deliberately not wired into the gate or into
// CI: it needs a browser and a running dev server, and a check that cannot run
// must say so rather than pass by default. Without puppeteer installed it
// reports a skip and exits 0, the same way the gate's fmt step does.
//
//   node tools/check-live-page.js [url]      (default http://127.0.0.1:5173)
//
// Start the page first, with the API layer beside it so the console is
// exercised against the real handlers:
//
//   npm i puppeteer --no-save              # a browser, without touching package.json
//   node tools/api-dev-server.js &
//   cd frontend && npx vite --host 0.0.0.0 --port 5173 &
//
// The install is deliberately `--no-save`. Puppeteer is a harness dependency,
// not a project one: the deployed functions never need a browser, and the root
// install command runs on every deployment, where a Chrome download would be
// pure cost. The tool resolves `puppeteer` normally, and falls back to
// LIVE_PAGE_PUPPETEER when the browser lives outside the module path.

const URL_ARG = process.argv[2] || 'http://127.0.0.1:5173/';

// Headless Chrome reports no hover-capable pointer by default, which would
// make the media query that disables the frame - a guard meant for phones -
// suppress the very thing this harness is here to see. The flags tell Blink it
// has one; they are part of the harness, not of the page.
const CHROME_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--force-device-scale-factor=1',
  '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
];

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

async function loadPuppeteer() {
  const candidates = [process.env.LIVE_PAGE_PUPPETEER, 'puppeteer'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      return mod.default || mod;
    } catch (error) {
      // try the next candidate
    }
  }
  return null;
}

async function main() {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    console.log('live page: [skip] no browser is available (puppeteer is not resolvable)');
    console.log('  run: npm i puppeteer --no-save, or point LIVE_PAGE_PUPPETEER at an existing install');
    return;
  }

  const browser = await puppeteer.launch({ headless: 'shell', args: CHROME_FLAGS });
  try {
    const page = await browser.newPage();
    const failed = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    page.on('pageerror', (e) => failed.push(`pageerror ${e.message}`));

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(URL_ARG, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.cube-lattice .cube', { timeout: 15000 });
    // Wait for the page to be wired, not merely parsed: a click that lands
    // before wire() has run does nothing at all, which looks exactly like a
    // dead button - and that ambiguity produced a false failure against the
    // live deployment. Two signals are accepted, newest first: the boot beacon
    // the app sets when it has finished wiring, and, for any build that
    // predates the beacon, the network pill leaving its "connecting" state
    // (which only happens after the boot sequence ran).
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.lumenReady === 'ready' ||
        (() => {
          const pill = document.getElementById('netPill');
          return Boolean(pill) && !/connecting/i.test(pill.textContent || '');
        })(),
      { timeout: 60000 }
    );
    await page.evaluate(() => {
      // Scroll-behavior: smooth turns "scroll then measure" into a race, so the
      // harness measures against instant scrolling. It changes nothing else.
      document.documentElement.style.scrollBehavior = 'auto';
    });

    // ---------------------------------------------------------------- strips
    const layout = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const rows = [];
      for (const section of document.querySelectorAll('main > section.strip')) {
        const kids = [...section.querySelectorAll(':scope > .shell > *')];
        kids.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const prev = kids[i - 1]?.getBoundingClientRect();
          rows.push({
            id: section.id,
            left: Math.round(r.left),
            right: Math.round(r.right),
            gapAbove: prev ? Math.round(r.top - prev.bottom) : null,
            painted: getComputedStyle(el).backgroundColor,
          });
        });
      }
      return {
        vw,
        scrollWidth: document.scrollingElement.scrollWidth,
        rows,
        gapProbe: (() => {
          const section = document.querySelector('#how');
          const kids = [...section.querySelectorAll(':scope > .shell > *')];
          const a = kids[0].getBoundingClientRect();
          const b = kids[1].getBoundingClientRect();
          return Math.round(b.top - a.bottom);
        })(),
      };
    });

    expect(layout.rows.length >= 12, `the page should carry the line strips of every text row, found ${layout.rows.length}`);
    for (const row of layout.rows) {
      expect(row.left <= 1 && row.right >= layout.vw - 1, `#${row.id}: a text row must run edge to edge, got [${row.left},${row.right}] of ${layout.vw}`);
      expect(!/rgba?\(0, 0, 0, 0\)/.test(row.painted), `#${row.id}: a text row must carry its own strip, found ${row.painted}`);
    }
    // The band hugs the text it carries: the padding inside a strip is small,
    // and the air between rows comes from the row gap where the lattice shows.
    const bandPad = await page.evaluate(() =>
      [...document.querySelectorAll('main > section.strip > .shell > *')]
        .map((el) => Math.round(parseFloat(getComputedStyle(el).paddingTop)))
    );
    expect(Math.max(...bandPad) <= 24, `a strip must hug its text, found up to ${Math.max(...bandPad)}px of padding inside the band`);
    const gaps = layout.rows.map((r) => r.gapAbove).filter((g) => g !== null);
    expect(gaps.every((g) => g > 0), `every pair of rows must leave a gap for the lattice, found ${JSON.stringify(gaps)}`);
    expect(layout.gapProbe > 0, 'the gap between two strips must be a visible opening, not zero');
    expect(layout.scrollWidth <= layout.vw, `the full-bleed strips must not create a horizontal scrollbar (${layout.scrollWidth} > ${layout.vw})`);

    // The frame, in the places that matter. It is one element, positioned by
    // the pointer's own coordinates, so it must appear on the block under the
    // pointer anywhere on the page - over open lattice, over a card, over a
    // strip - and never twice.
    const hold = async (x, y) => {
      await page.mouse.move(x, y, { steps: 2 });
      await new Promise((r) => setTimeout(r, 220));
      return page.evaluate(() => {
        const frames = [...document.querySelectorAll('.lattice-frame.on')];
        return {
          count: frames.length,
          shadow: frames[0] ? getComputedStyle(frames[0]).boxShadow : null,
          cell: frames[0] ? Math.round(frames[0].getBoundingClientRect().width) : 0,
          at: frames[0]
            ? `${Math.round(frames[0].getBoundingClientRect().left)},${Math.round(frames[0].getBoundingClientRect().top)}`
            : null,
        };
      });
    };

    const openLattice = await hold(60, 560);
    expect(openLattice.count === 1, `the pointer on the open lattice must frame exactly one block, got ${openLattice.count}`);
    expect(/inset/.test(openLattice.shadow || ''), `the frame must be an inset ring, got ${openLattice.shadow}`);
    expect(openLattice.count !== 1 || /4px/.test(openLattice.shadow), `the frame must be the 4 screen pixel ring at 1x, got ${openLattice.shadow}`);

    // The first area carries no strip, so the lattice reads through it and the
    // frame lands over the hero's own text column too.
    const inHero = await hold(720, 430);
    expect(inHero.count === 1, `the first area must carry no strip: the frame must still land under the hero, got ${inHero.count}`);

    // The correction, measured: a card used to hide the frame completely,
    // because the frame asked what was under the pointer and gave up when the
    // answer was not a cube.
    await page.evaluate(() => document.getElementById('console').scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 250));
    const cardPoint = await page.evaluate(() => {
      const r = document.querySelector('#console .card').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) };
    });
    const onCard = await hold(cardPoint.x, cardPoint.y);
    expect(onCard.count === 1, `the frame must follow the pointer over a card too, got ${onCard.count} at ${onCard.at}`);

    // and the block it lands on is the block the pointer is inside - one cell,
    // at the cell's own size
    expect(onCard.cell === 60, `the frame is one block: 60px at dpr 1, got ${onCard.cell}`);

    // it closes when the pointer leaves the window
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerleave')));
    await new Promise((r) => setTimeout(r, 200));
    expect((await page.evaluate(() => document.querySelectorAll('.lattice-frame.on').length)) === 0, 'leaving the window must close the frame');
    await page.mouse.move(60, 560, { steps: 2 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await page.evaluate(() => document.querySelectorAll('.lattice-frame.on').length)) === 1, 'the frame must come back on the next move');
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 250));

    // ------------------------------------------------- the interface panel
    const panel = await page.evaluate(() => ({
      present: Boolean(document.getElementById('interfacePanel')),
      strips: document.getElementById('ifaceStripCount')?.textContent.trim(),
      gap: document.getElementById('ifaceStripGap')?.textContent.trim(),
      framed: document.getElementById('ifaceFramedCount')?.textContent.trim(),
      ring: document.getElementById('ifaceRing')?.textContent.trim(),
      demoStrips: document.querySelectorAll('.iface-strip-row').length,
    }));
    expect(panel.present, 'the interface panel is missing from the page');
    expect(Number(panel.strips) === layout.rows.length, `the panel reports ${panel.strips} strips while the page has ${layout.rows.length}`);
    expect(/\(\d+px\)|px at/.test(panel.gap || ''), `the panel's gap readout is not a measurement: ${panel.gap}`);
    expect(panel.demoStrips === 2, 'the strip row demo is not rendered');
    expect(/4px|2px/.test(panel.ring || ''), `the panel must state the ring it measured from the live frame, got ${panel.ring}`);

    // -------------------------------------------------------------- the banner
    const banner = await page.evaluate(() => {
      const img = document.querySelector('.hero-banner');
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return { complete: img.complete, natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(r.width), Math.round(r.height)] };
    });
    expect(Boolean(banner), 'the hero banner is missing from the page');
    if (banner) {
      expect(banner.complete && banner.natural[0] > 0, 'the embedded hero banner did not decode: the data URI is broken');
      const aspect = banner.natural[0] / banner.natural[1];
      expect(Math.abs(banner.box[0] / banner.box[1] - aspect) < 0.02, `the banner must keep its own aspect ratio (${banner.natural} -> ${banner.box})`);
    }

    // ------------------------------------------------------------- the console
    const console_ = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('a.btn, button')];
      return {
        count: controls.length,
        unreachable: controls.filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const top = document.elementFromPoint(Math.min(r.left + r.width / 2, document.documentElement.clientWidth - 1), r.top + r.height / 2);
          return top && !el.contains(top) && top !== el;
        }).length,
        disabled: controls.filter((el) => el.disabled === true).map((el) => el.id || el.textContent.trim().slice(0, 24)),
      };
    });
    expect(console_.count >= 15, `the page should render its controls, found ${console_.count}`);
    expect(console_.unreachable === 0, `${console_.unreachable} control(s) are covered by something else and cannot be clicked`);

    expect(failed.length === 0, `the page made ${failed.length} failing request(s): ${failed.slice(0, 3).join(' | ')}`);

    console.log(
      `live page: ${layout.rows.length} strips full-bleed with ${layout.gapProbe}px of open lattice between them, ` +
        `the frame follows the pointer over open lattice, over the hero's text and over a card alike, ` +
        `banner ${banner ? banner.natural.join('x') : '?'} drawn ${banner ? banner.box.join('x') : '?'}, ` +
        `${console_.count} controls all reachable, ${failed.length} failing requests`
    );
  } finally {
    await browser.close();
  }

  if (problems.length === 0) {
    console.log('live page: the page behaves the way it is described - in a browser, not in a stylesheet');
    process.exit(0);
  }
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`live page check failed to run: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
