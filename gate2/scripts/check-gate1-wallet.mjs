// Gate 1.0 cuzdan bolumu icin regresyon kapisi.
//
// Hata neydi: .cube-lattice position:fixed + z-index:0 ile ciziliyor. 1.0'in
// kartlari varsayilan (auto) katmanda kaldigi icin desenin ALTINDA kaliyordu -
// okunuyordu ama elementFromPoint kartin yerine .cube donuyordu, yani kart
// kendi tiklamalarini yutuyordu. Gate 2.0 ayni icerigi z-index:1 ile yukari
// aliyor (gate2/web/src/style.css); 1.0'a bu satir hic girmemisti.
//
// Bu test sadece "eleman var mi" demiyor - piksel duzeyinde ustte mi diye
// bakiyor, cunku hata tam olarak "var ama ulasilamiyor" seklindeydi.
import puppeteer from "puppeteer";

const BASE = process.env.GATE1_WEB_URL || "http://127.0.0.1:5175/";
const fails = [], oks = [];
const check = (n, c, d = "") => (c ? oks : fails).push(`${n}${d ? ` — ${d}` : ""}`);

const browser = await puppeteer.launch({ headless: "shell", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });
const bad = [];
page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(0, 60)}`); });
page.on("pageerror", (e) => bad.push(`ERR ${e.message.slice(0, 120)}`));
page.on("console", (m) => { if (m.type() === "error") bad.push(`console: ${m.text().slice(0, 120)}`); });

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 40000 });
await new Promise((r) => setTimeout(r, 2500));

const reach = await page.evaluate(async () => {
  const out = {};
  for (const id of ["walletKv", "walletChip", "demoWalletBtn", "walletNote", "walletKind"]) {
    const el = document.getElementById(id);
    if (!el) { out[id] = "MISSING"; continue; }
    el.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 200));
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    out[id] = !top ? "OFFSCREEN"
      : (el.contains(top) || top === el || top.contains(el)) ? "ok"
      : `covered by ${top.className || top.tagName}`;
  }
  return out;
});
for (const [id, state] of Object.entries(reach)) {
  check(`wallet part is on top of the lattice: ${id}`, state === "ok", state);
}

const ownsClicks = await page.evaluate(() => {
  const el = document.getElementById("demoWalletBtn");
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return top === el || el.contains(top);
});
check("demo button receives its own clicks", ownsClicks);

await page.evaluate(() => document.getElementById("demoWalletBtn").click());
await new Promise((r) => setTimeout(r, 3000));
const kv = await page.$eval("#walletKv", (n) => n.textContent.replace(/\s+/g, " ").trim());
check("demo account fills real balances", /\d/.test(kv.replace(/wSRC|XLM|after reserve|Spendable|wrapped asset/gi, "")), kv.slice(0, 80));

for (const ep of ["/api/status", "/api/finality", "/api/audit"]) {
  const s = await page.evaluate(async (u) => (await fetch(u)).status, ep);
  check(`${ep} answers 200`, s === 200, `status ${s}`);
}

check("no console or network errors", bad.length === 0, bad.slice(0, 3).join(" | "));

console.log("OK:"); for (const o of oks) console.log(`  + ${o}`);
if (fails.length) { console.log("\nFAIL:"); for (const f of fails) console.log(`  - ${f}`); }
console.log(fails.length ? `\n${fails.length} FAILED of ${oks.length + fails.length}` : `\nALL GREEN (${oks.length} checks)`);
await browser.close();
process.exit(fails.length ? 1 : 0);
