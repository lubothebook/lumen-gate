'use strict';

// Every control on the page, clicked, with the consequence asserted.
//
// This exists because of one sentence from the operator: "the wallet buttons
// don't work - test the whole system and the screen". The repository could
// already show that a selector resolves and that a handler is attached, which
// is not the same thing at all: a handler can be attached to a button that is
// covered by an overlay, a control can be disabled with no stated reason, an
// action can finish by changing nothing on screen. None of that is visible in
// a stylesheet read, and all of it is visible to a person with a mouse.
//
// So the contract here is: every control either DOES something observable, or
// states why it cannot. Concretely, each click is measured against the page's
// own feedback surfaces before and after:
//
//   * the event log (#txLog) - the console's voice, where every action's
//     outcome is written, including refusals and errors;
//   * the note under the control that owns the action (#walletNote,
//     #sourceNote, #settleNote, #cashoutNote);
//   * structural state: which tab pane is visible, whether the operator dialog
//     is open, what the section nav selected, where the page scrolled to;
//   * input values, when the control exists to fill one in.
//
// A disabled control is held to the second half of the rule: it must carry its
// reason, in its own `title` and in an `aria-describedby` target, because a
// grey button with no explanation is the thing the operator called unacceptable.
//
//   node tools/check-live-actions.js [url]     (default http://127.0.0.1:5173)
//   node tools/check-live-actions.js --learn   print what each click changed
//
// Like the page harness, this needs a browser and a running dev server, so it
// is not in the gate or in CI: without puppeteer it prints [skip] and exits 0.

const URL_ARG = process.argv.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:5173/';
const LEARN = process.argv.includes('--learn');

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
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// What the page looks like right now, in the terms the contract is written in.
const SNAPSHOT = () => {
  const text = (id) => (document.getElementById(id)?.textContent || '').trim();
  const visible = (id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return !el.classList.contains('hidden') && r.width > 0 && r.height > 0;
  };
  const log = document.getElementById('txLog');
  return {
    logLines: log ? log.children.length : -1,
    logTail: log && log.lastElementChild ? log.lastElementChild.textContent.trim().slice(0, 120) : '',
    dialogOpen: Boolean(document.getElementById('operatorDialog')?.open),
    panes: ['paneInbound', 'paneOutbound', 'paneCashout'].filter(visible),
    selected: ['tabInbound', 'tabOutbound', 'tabCashout']
      .filter((id) => document.getElementById(id)?.getAttribute('aria-selected') === 'true')
      .join(','),
    hash: location.hash,
    scrollY: Math.round(window.scrollY),
    notes: {
      wallet: text('walletNote'),
      source: text('sourceNote'),
      settle: text('settleNote'),
      cashout: text('cashoutNote'),
    },
    values: {
      lockRecipient: document.getElementById('lockRecipient')?.value || '',
      opToken: document.getElementById('opToken')?.value || '',
    },
    disabled: Object.fromEntries(
      [...document.querySelectorAll('button')].map((b) => [b.id || b.textContent.trim().slice(0, 20), b.disabled === true])
    ),
    openDetails: [...document.querySelectorAll('#about details')].filter((d) => d.open).length,
    // The two read-only tables the console writes answers into. A query button
    // whose whole job is to refresh a table has to be measured on the table,
    // not on the incidental scroll its focus causes.
    tables: ['finalityKv', 'deploymentKv', 'cashoutInstructions']
      .map((id) => (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200))
      .join(' | '),
  };
};

// A click counts as "something happened" when any of these moved.
function diff(before, after) {
  const changes = [];
  // The log changes in both directions: an action that appends says so by
  // growing, and "Clear" says so by collapsing to the placeholder. A check that
  // only looked for growth reported the Clear button as dead when it was not.
  if (after.logLines !== before.logLines) changes.push(`log ${before.logLines}->${after.logLines}`);
  else if (after.logTail && after.logTail !== before.logTail) changes.push('log-text');
  if (after.dialogOpen !== before.dialogOpen) changes.push(`dialog=${after.dialogOpen}`);
  if (after.panes.join() !== before.panes.join()) changes.push(`pane=${after.panes.join()}`);
  if (after.selected !== before.selected) changes.push(`tab=${after.selected}`);
  if (after.hash !== before.hash) changes.push(`hash=${after.hash || '-'}`);
  if (Math.abs(after.scrollY - before.scrollY) > 40) changes.push(`scroll=${after.scrollY}`);
  for (const key of Object.keys(after.notes)) {
    if (after.notes[key] !== before.notes[key]) changes.push(`note.${key}`);
  }
  for (const key of Object.keys(after.values)) {
    if (after.values[key] !== before.values[key]) changes.push(`value.${key}`);
  }
  for (const key of Object.keys(after.disabled)) {
    if (before.disabled[key] !== undefined && after.disabled[key] !== before.disabled[key]) changes.push(`disabled.${key}=${after.disabled[key]}`);
  }
  if (after.openDetails !== before.openDetails) changes.push(`faq=${after.openDetails}`);
  if (after.tables !== before.tables) changes.push('table');
  return changes;
}

async function main() {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    console.log('live actions: [skip] no browser is available (puppeteer is not resolvable)');
    console.log('  run: npm i puppeteer --no-save, or point LIVE_PAGE_PUPPETEER at an existing install');
    return;
  }

  const browser = await puppeteer.launch({ headless: 'shell', args: CHROME_FLAGS });
  const report = [];
  let failures = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(URL_ARG, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#txLog', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));
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

    const snap = () => page.evaluate(SNAPSHOT);
    const settle = async () => {
      // Let the handler's async work finish, so the log line it writes is in
      // the DOM by the time the "after" snapshot is taken.
      await new Promise((r) => setTimeout(r, 450));
    };
    // The pane a control lives in, so a control behind a tab can be reached the
    // way a person reaches it: click the tab first.
    const PANE_TABS = { paneInbound: 'tabInbound', paneOutbound: 'tabOutbound', paneCashout: 'tabCashout' };
    const state = (selector) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { present: false };
        const r = el.getBoundingClientRect();
        const pane = el.closest('[id^="pane"]');
        return {
          present: true,
          disabled: el.disabled === true,
          hidden: el.hidden === true || el.classList.contains('hidden'),
          visible: r.width > 0 && r.height > 0,
          text: el.textContent.trim().slice(0, 30),
          pane: pane ? pane.id : null,
          title: el.getAttribute('title') || '',
          describedBy: el.getAttribute('aria-describedby') || '',
        };
      }, selector);

    const act = async (id, { note = '' } = {}) => {
      const before = await snap();
      let st = await state(`#${id}`);
      if (!st.present) {
        problems.push(`#${id} is not on the page at all`);
        failures += 1;
        return;
      }
      if (st.disabled) {
        // A disabled control is not a click: it is a promise to explain itself.
        const owner = st.describedBy ? await state(`#${st.describedBy}`) : null;
        const explained = Boolean(st.title) && Boolean(owner && owner.present);
        report.push({ id: `disabled ${id}`, result: `title="${st.title}" note=${owner ? 'yes' : 'no'}` });
        expect(explained, `the disabled control "${st.text}" must carry its reason in a title and in an aria-describedby note`);
        return;
      }
      if (!st.visible) {
        // Reach it the way a person would: open the tab its pane belongs to.
        const tab = st.pane && PANE_TABS[st.pane];
        if (tab) {
          const tabState = await state(`#${tab}`);
          if (tabState.present && !tabState.disabled) {
            await page.click(`#${tab}`);
            await settle();
          }
        }
        st = await state(`#${id}`);
      }
      if (!st.visible) {
        problems.push(`#${id} is on the page but cannot be reached: hidden behind ${st.pane || 'an element with no visible state'}`);
        report.push({ id, result: 'UNREACHABLE' });
        failures += 1;
        return;
      }
      try {
        await page.click(`#${id}`);
      } catch (error) {
        problems.push(`#${id} could not be clicked: ${error.message}`);
        report.push({ id, result: 'CLICK FAILED' });
        failures += 1;
        return;
      }
      await settle();
      const after = await snap();
      const changes = diff(before, after);
      report.push({ id, result: changes.length ? changes.join(' ') : 'NOTHING', note });
      if (changes.length === 0) {
        problems.push(`#${id} was clicked and nothing observable happened: no log line, no note, no state change`);
        failures += 1;
      }
      return { before, after, changes };
    };

    // ------------------------------------------------------- section nav links
    for (const target of ['#how', '#console', '#evidence', '#about']) {
      const before = await snap();
      await page.click(`nav.main a[href="${target}"]`);
      await settle();
      const after = await snap();
      const changed = after.hash === target || Math.abs(after.scrollY - before.scrollY) > 40;
      report.push({ id: `nav ${target}`, result: changed ? `hash=${after.hash} scroll=${after.scrollY}` : 'NOTHING' });
      expect(changed, `the nav link to ${target} neither changed the hash nor moved the page`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 200));

    // ---------------------------------------------------------------- hero CTAs
    await act('operatorBtn');
    await page.evaluate(() => document.getElementById('operatorDialog')?.close());
    const ctaWalet = await page.evaluate(() => {
      const link = [...document.querySelectorAll('.hero-panel a.btn')].find((a) => a.getAttribute('href') === '#console');
      return Boolean(link);
    });
    expect(ctaWalet, 'the hero no longer links to the wallet');
    const walletCta = await page.evaluate(async () => {
      const link = [...document.querySelectorAll('a.btn')].find((a) => a.getAttribute('href') === '#console');
      const before = window.scrollY;
      link.click();
      await new Promise((r) => setTimeout(r, 350));
      return { before, after: Math.round(window.scrollY), hash: location.hash };
    });
    report.push({ id: 'hero "Open the wallet"', result: `hash=${walletCta.hash} scroll ${walletCta.before}->${walletCta.after}` });
    expect(walletCta.hash === '#console' || walletCta.after > walletCta.before + 200, 'the hero wallet CTA does not take the reader to the wallet');

    // ---------------------------------------------------------------- the wallet
    await act('connectBtn', { note: 'no Freighter in this browser: a refusal must speak' });
    await act('balanceBtn', { note: 'no wallet connected: the note must say so' });
    await act('useWalletBtn');
    await act('demoRecipientBtn');

    // tabs
    await act('tabOutbound');
    await act('tabCashout');
    await act('tabInbound');
    await act('tabCashout');

    // cash out panel
    await act('cashoutQuoteBtn', { note: 'the anchor facade may be absent; either way it must answer' });
    await act('cashoutAuthBtn');
    await act('cashoutStartBtn');

    // inbound panel
    await act('tabInbound');
    await act('lockBtn');
    await act('burnBtn');

    // evidence + run cards
    await act('queryBtn');
    await act('settleBtn');
    await act('copyCmdBtn', { note: 'clipboard may be denied: a fallback must still say something' });
    await act('clearLogBtn');

    // operator dialog
    await act('operatorHintBtn');
    await page.evaluate(() => {
      document.getElementById('opToken').value = 'demo-token-for-the-check';
    });
    await act('opSave');
    await act('operatorBtn');
    await act('opClear');
    await act('operatorBtn');
    await act('opClose');

    // the FAQ is a control too
    const faq = await page.evaluate(async () => {
      const d = document.querySelector('#about details');
      if (!d) return null;
      const before = d.open;
      d.querySelector('summary').click();
      await new Promise((r) => setTimeout(r, 200));
      const after = d.open;
      d.querySelector('summary').click();
      return { before, after, closed: !d.open };
    });
    expect(Boolean(faq), 'the FAQ details element is missing');
    if (faq) {
      report.push({ id: 'faq summary', result: `open ${faq.before}->${faq.after}, closes again=${faq.closed}` });
      expect(faq.after !== faq.before && faq.closed, 'a FAQ summary click does not toggle its answer');
    }

    // ---------------------------------------------------- disabled controls
    // The rule: a control that cannot act must say why, in its own title and in
    // the note it points at. No silent grey buttons.
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => document.documentElement.dataset.lumenReady === 'ready' || !/connecting/i.test(document.getElementById('netPill')?.textContent || 'connecting'),
      { timeout: 60000 }
    );
    await new Promise((r) => setTimeout(r, 600));
    const disabledReasons = await page.evaluate(() => {
      const out = [];
      for (const button of document.querySelectorAll('button[disabled], button:disabled')) {
        const described = button.getAttribute('aria-describedby');
        const target = described ? document.getElementById(described) : null;
        out.push({
          id: button.id || button.textContent.trim().slice(0, 24),
          title: button.getAttribute('title') || '',
          describedBy: described || '',
          describedText: target ? target.textContent.trim().slice(0, 90) : '',
          text: button.textContent.trim(),
        });
      }
      return out;
    });
    for (const item of disabledReasons) {
      report.push({ id: `disabled ${item.id}`, result: `title="${item.title}"` });
      expect(Boolean(item.title), `the disabled control "${item.text}" carries no title: a grey button must say why it cannot act`);
      expect(
        Boolean(item.describedBy && item.describedText),
        `the disabled control "${item.text}" does not point at the note that explains it (aria-describedby)`
      );
    }

    expect(errors.length === 0, `the page raised ${errors.length} uncaught error(s): ${errors.slice(0, 2).join(' | ')}`);

    // ------------------------------------------------- the interface panel
    // The panel claims to be read out of this page. That is checkable: the
    // controls it lists must be exactly the controls the page is disabling.
    const panel = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#ifaceDisabledRows tr')];
      const listed = rows.map((r) => r.children[0]?.textContent.trim()).filter(Boolean);
      const onPage = [...document.querySelectorAll('button:disabled')].map((b) => b.id);
      return {
        listed,
        onPage,
        strips: document.getElementById('ifaceStripCount')?.textContent.trim(),
        gap: document.getElementById('ifaceStripGap')?.textContent.trim(),
        overflow: document.getElementById('ifaceOverflow')?.textContent.trim(),
        cubes: document.querySelectorAll('#ifaceCubes .iface-cube').length,
      };
    });
    expect(panel.listed.length === panel.onPage.length && panel.onPage.every((id) => panel.listed.includes(id)),
      `the interface panel lists [${panel.listed}] while the page disables [${panel.onPage}]: the panel is not reading the DOM it claims to read`);
    expect(Number(panel.strips) > 0, `the interface panel reports ${panel.strips} strips`);
    expect(/none/.test(panel.overflow || ''), `the interface panel reports horizontal overflow: ${panel.overflow}`);
    expect(panel.cubes === 6, `the demo wall should hold 6 cubes, found ${panel.cubes}`);
    report.push({ id: 'interface panel', result: `${panel.strips} strips, gap ${panel.gap}, overflow ${panel.overflow}, ${panel.listed.length} disabled controls listed, ${panel.cubes} demo cubes` });

    if (LEARN) {
      console.log('what each click changed:');
      for (const row of report) console.log(`  ${String(row.id).padEnd(28)} ${row.result}`);
      console.log(`\ndisabled controls and their stated reasons (${disabledReasons.length}):`);
      for (const item of disabledReasons) {
        console.log(`  ${item.id.padEnd(20)} title: ${item.title || '(none)'}`);
        console.log(`  ${''.padEnd(20)} note : ${item.describedText || '(none)'} ${item.describedBy ? `[${item.describedBy}]` : ''}`);
      }
    }

    const clicked = report.filter((r) => !String(r.id).startsWith('disabled '));
    // A disabled control is met twice in a full pass - once where it would have
    // been clicked, once in the sweep at the end - so the count is by identity.
    const disabledRows = [...new Map(report.filter((r) => String(r.id).startsWith('disabled ')).map((r) => [r.id, r])).values()];
    const silent = clicked.filter((r) => r.result === 'NOTHING').length;
    console.log(
      `live actions: ${clicked.length} controls clicked, each with an observable consequence; ` +
        `${disabledRows.length} disabled controls, each stating its reason in its own title and in the note it points at`
    );
    console.log(`             ${silent} silent controls, ${failures} unexpected outcomes`);
  } finally {
    await browser.close();
  }

  if (problems.length === 0) {
    console.log('live actions: every control either acts or says why it cannot - clicked in a browser, not read in a file');
    process.exit(0);
  }
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`live actions check failed to run: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
