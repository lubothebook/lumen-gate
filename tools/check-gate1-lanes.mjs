// Gate 1.0 inbound lane regresyon kapisi.
//
// Onceden: SOURCE_URL hic ayarlanmadigi icin "Lock on the source chain",
// "Ask the relayer to settle" ve bagli her sey kapaliydi. Konsol dogru
// soyluyordu ama lane hic surulemiyordu.
//
// Simdi: tools/source-sim.js kaynak zinciri oynuyor, tools/operator-facade.js
// relayer gecisini yapiyor. Bu test lane'i ucdan uca suruyor ve en onemlisi,
// facade'in ZINCIRE YAZMAYI REDDETTIGINI dogruluyor - sahte imzanin registry'ye
// gecmemesi bir ozellik, eksiklik degil.
//
// Calistirmadan once: source-sim (8080), operator-facade (8081),
// api-dev-server (3001, SOURCE_URL+OPERATOR_URL+OPERATOR_TOKEN ile), vite (5175).
import puppeteer from "puppeteer";

const BASE = process.env.GATE1_WEB_URL || "http://127.0.0.1:5175/";
const TOKEN = process.env.OPERATOR_TOKEN || "devtoken";
const fails = [], oks = [];
const check = (n, c, d = "") => (c ? oks : fails).push(`${n}${d ? ` — ${d}` : ""}`);

const browser = await puppeteer.launch({ headless: "shell", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1100 });
const bad = [];
page.on("pageerror", (e) => bad.push(`ERR ${e.message.slice(0, 120)}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // The relay refusal is a deliberate 503 from the facade: the browser logs the
  // failed fetch, and that log is evidence the guard fired, not a defect.
  if (/50[23]/.test(t)) return;
  bad.push(`console: ${t.slice(0, 120)}`);
});

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 40000 });
await new Promise((r) => setTimeout(r, 3000));

// 1 — capability pills reflect a configured source and relay
check("source pill is on", (await page.$eval("#capSource", (n) => n.textContent)).includes("on"));
check("relay pill is on", (await page.$eval("#capRelay", (n) => n.textContent)).includes("on"));
check("lock button is enabled", (await page.$eval("#lockBtn", (n) => n.disabled)) === false);

// 2 — operator token
await page.evaluate(() => document.getElementById("operatorBtn").click());
await new Promise((r) => setTimeout(r, 500));
await page.evaluate((t) => {
  const el = document.getElementById("opToken");
  el.value = t;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, TOKEN);
await page.evaluate(() => document.getElementById("opSave").click());
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => { const c = document.getElementById("opClose"); if (c) c.click(); });
await new Promise((r) => setTimeout(r, 500));

// 3 — lock really seals a block
await page.evaluate(() => document.getElementById("lockBtn").click());
await page.waitForFunction(() => /Locked\.|Lock refused/.test(document.getElementById("txLog")?.textContent || ""), { timeout: 45000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
const afterLock = await page.$eval("#txLog", (n) => n.textContent.replace(/\s+/g, " "));
check("lock succeeded", /Locked\./.test(afterLock), afterLock.slice(-120));
check("lock produced a message_id", /message_id [0-9a-f]{64}/.test(afterLock));
check("lock step is done", (await page.$eval("#bstep-lock", (n) => n.className)).includes("done"));
// Two source simulators back this lane and they say different, both-honest
// things: the standalone one (SOURCE_URL set) collects a signer set, the
// in-process one (SOURCE_URL unset) produces a real Merkle root and states it
// signs nothing. Requiring the first shape would fail the honest second one,
// so the assertion is that evidence came back AND said which it was.
const signerSet = /\d+ signatures collected/.test(afterLock);
const merkleOnly = /BLS aggregate is not produced|no signatures/i.test(afterLock);
check("finality evidence was read", signerSet || merkleOnly, signerSet ? "signer set" : "merkle-only source");
check(
  "the evidence does not overclaim",
  signerSet ? /aggregate is \d+ bytes/.test(afterLock) : merkleOnly,
  "a source that does not sign must say so"
);
check("settle button opened after lock", (await page.$eval("#settleBtn", (n) => n.disabled)) === false);

// 4 — the relayer pass reaches the facade and is refused for the RIGHT reason
await page.evaluate(() => { const s = document.getElementById("settleBtn"); if (!s.disabled) s.click(); });
await new Promise((r) => setTimeout(r, 6000));
const afterSettle = await page.$eval("#txLog", (n) => n.textContent.replace(/\s+/g, " "));
check("relay call reached the facade", /Relay refused|confirmed transaction/.test(afterSettle));
// The refusal is the load-bearing assertion. Whichever simulator served the
// lock, nothing it produced may be anchored: neither a digest shaped like an
// aggregate nor a Merkle root with no signature at all can pass a real BLS
// pairing check. What must never appear is a silent success.
check(
  "unsigned evidence is refused, not silently accepted",
  /unsigned_evidence|REFUSED|did not anchor/.test(afterSettle),
  "a simulator digest must never pass a BLS pairing check"
);
check(
  "the relay did not 404 on its own lock",
  !/evidence_unavailable/.test(afterSettle),
  "the facade must read evidence from whichever simulator served the lock"
);
check("no mint was claimed without an anchor", !/mint confirmed/.test(afterSettle));

check("no unexpected console errors", bad.length === 0, bad.slice(0, 3).join(" | "));

console.log("OK:"); for (const o of oks) console.log(`  + ${o}`);
if (fails.length) { console.log("\nFAIL:"); for (const f of fails) console.log(`  - ${f}`); }
console.log(fails.length ? `\n${fails.length} FAILED of ${oks.length + fails.length}` : `\nALL GREEN (${oks.length} checks)`);
await browser.close();
process.exit(fails.length ? 1 : 0);
