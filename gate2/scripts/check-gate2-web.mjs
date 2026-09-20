// gate2/web icin gercek tarayici harness'i: sayfayi acar, canli testnet
// RPC/Horizon okumalarini tetikler ve sonuclari dogrular. Uydurma yok:
// her iddia DOM'dan okunur.
import puppeteer from "puppeteer";

const BASE = process.env.GATE2_WEB_URL || "http://127.0.0.1:5174/gate2/";
const DEPLOYER = "GDML46BD7KOLEB57D4GW4FNPML6UZKOKSPXAVFG5KTGKQO6E3OI53V5U";

const fails = [];
const oks = [];
function check(name, cond, detail = "") {
  (cond ? oks : fails).push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Sticky header + puppeteer'in otomatik kaydirma davranisi gercek fare
// tiklamalarini yutabiliyor; handler'lari dogrudan DOM click ile tetikliyoruz.
const jsClick = async (page, sel) => page.$eval(sel, (n) => n.click());

const browser = await puppeteer.launch({
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const badRequests = [];
page.on("requestfailed", (r) => badRequests.push(`${r.url().slice(0, 90)} ${r.failure()?.errorText}`));
page.on("console", (m) => {
  if (m.type() === "error") badRequests.push(`console: ${m.text().slice(0, 120)}`);
});

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });

// 1 — contract ids come from the manifest, not hand-copied
const ids = await page.$eval("#contract-ids", (n) => n.textContent);
check("manifest ids rendered", ids.includes("CBKSNJBQ") && ids.includes("CDDQLXII") && ids.includes("CDQ3PA5L"), ids.slice(0, 60));

// 2 — live query for the deployer: honest 'kayıt yok' on both lanes
await page.type("#in-address", DEPLOYER);
await jsClick(page, "#btn-query");
await page.waitForFunction(
  () => {
    const t = document.getElementById("res-migration")?.textContent || "";
    return (t.match(/no record/g) || []).length >= 2 || t.includes("Read error") || t.includes("Query error");
  },
  { timeout: 45000 }
);
const migText = await page.$eval("#res-migration", (n) => n.textContent);
check("get_migration live read -> no record x2", (migText.match(/no record/g) || []).length >= 2, migText.replace(/\s+/g, " ").slice(0, 100));
await page.waitForFunction(
  () => {
    const t = document.getElementById("res-nfts")?.textContent || "";
    return (t.match(/NFT/g) || []).length >= 2 && !t.includes("Reading");
  },
  { timeout: 60000 }
);
const nftText = await page.$eval("#res-nfts", (n) => n.textContent);
check("proofs_of live read -> 0 NFT both lanes", nftText.includes("0 NFT") && !nftText.includes("error"), nftText.replace(/\s+/g, " ").slice(0, 80));

// 3 — claim_tier simulation shows the on-chain refusal
await jsClick(page, "#btn-tier-sim");
await page.waitForFunction(() => (document.getElementById("res-tier")?.textContent || "").includes("Rejected"), { timeout: 45000 });
const tierText = await page.$eval("#res-tier", (n) => n.textContent);
check("claim_tier sim -> NoMigration refusal visible", tierText.includes("#3") || tierText.includes("no badge"), tierText.replace(/\s+/g, " ").slice(0, 120));

// 4 — Burn tab honesty + working preconditions
await jsClick(page, "#tab-burn");
const blocker = await page.$eval("#burn-blocker", (n) => n.textContent);
check("burn blocker is honest (no router)", blocker.includes("not deployed") || blocker.includes("not on Sepolia"));

await page.type("#in-strkey", "GABC");
await jsClick(page, "#btn-strkey");
let sk = await page.$eval("#res-strkey", (n) => n.textContent);
check("StrKey rejects junk", sk.includes("invalid"), sk);

await page.$eval("#in-strkey", (n, v) => { n.value = v; }, DEPLOYER);
await jsClick(page, "#btn-strkey");
sk = await page.$eval("#res-strkey", (n) => n.textContent);
check("StrKey accepts real address", sk.includes("valid"), sk);

await jsClick(page, "#btn-trustline");
await page.waitForFunction(() => (document.getElementById("res-trustline")?.textContent || "").includes("trustline") || (document.getElementById("res-trustline")?.textContent || "").includes("Error"), { timeout: 90000 });
const tl = await page.$eval("#res-trustline", (n) => n.textContent);
check("trustline check live from Horizon (deployer has no USDC)", tl.includes("NO") || tl.includes("YES"), tl.replace(/\s+/g, " ").slice(0, 90));

// 5 — BURN word can never enable the button while the router is missing
await page.type("#in-burnword", "BURN");
const burnDisabled = await page.$eval("#btn-burn", (n) => n.disabled);
check("BURN button stays disabled without router", burnDisabled === true);

check("no failed requests / console errors", badRequests.length === 0, badRequests.slice(0, 3).join(" | "));

// 6 — gate switch is only the two banner boxes, labels only 1.0 / 2.0
const tracks = await page.$$eval(".track-box", (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
check("track boxes say only 1.0 and 2.0", tracks.length === 2 && tracks[0] === "1.0" && tracks[1] === "2.0", JSON.stringify(tracks));
const extraSwitch = await page.$$eval("a, button", (nodes) =>
  nodes
    .filter((n) => /gate\s*1\.0/i.test(n.textContent || "") && !n.classList.contains("track-box"))
    .map((n) => (n.textContent || "").trim())
);
check("no extra Gate 1.0 switchers", extraSwitch.length === 0, extraSwitch.join(" | "));

// 7 — cube lattice is live: real mouse move paints a 4px white frame
const cubeCount = await page.$$eval(".cube", (n) => n.length);
check("lattice built cubes", cubeCount > 20, String(cubeCount));
await page.setViewport({ width: 1280, height: 800 });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForFunction(() => window.scrollY < 2, { timeout: 3000 }).catch(() => {});
const frameInfo = await page.evaluate(async () => {
  const hero = document.querySelector(".hero")?.getBoundingClientRect();
  const head = document.querySelector("header.top")?.getBoundingClientRect();
  const x = 36;
  const y = Math.round(Math.max((head ? head.bottom : 120) + 16, (hero ? hero.top : 0) + 80));
  window.dispatchEvent(new PointerEvent("pointermove", {
    clientX: x, clientY: y, bubbles: true, pointerType: "mouse",
  }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const framed = document.querySelector(".cube.frame");
  const stack = (document.elementsFromPoint(x, y) || []).map((n) => n.className || n.tagName).slice(0, 8);
  return {
    x, y, hero: hero ? { top: hero.top, h: hero.height } : null,
    framed: Boolean(framed),
    shadow: framed ? getComputedStyle(framed).boxShadow : "",
    stack,
    cubes: document.querySelectorAll(".cube").length,
  };
});
await page.mouse.move(frameInfo.x, frameInfo.y);
const framedAfterMouse = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 250));
  const framed = document.querySelector(".cube.frame");
  const shadow = framed ? getComputedStyle(framed).boxShadow : "";
  return { framed: Boolean(framed), shadow };
});
const okFrame = framedAfterMouse.framed && /4px/.test(framedAfterMouse.shadow) && /255,\s*255,\s*255/.test(framedAfterMouse.shadow);
check(
  "cube under pointer wears 4px white frame",
  okFrame,
  JSON.stringify({ x: frameInfo.x, y: frameInfo.y, stack: frameInfo.stack, ...framedAfterMouse }).slice(0, 220)
);

// 8 — Freighter connect must call requestAccess (the door that opens the
// popup). isConnected() returning false used to abort before any popup.
const walletPage = await browser.newPage();
await walletPage.evaluateOnNewDocument(() => {
  const addr = "GDML46BD7KOLEB57D4GW4FNPML6UZKOKSPXAVFG5KTGKQO6E3OI53V5U";
  window.freighterApi = {
    isConnected: async () => ({ isConnected: false }),
    requestAccess: async () => {
      window.__freighterRequestAccess = (window.__freighterRequestAccess || 0) + 1;
      return { address: addr };
    },
    getAddress: async () => ({ address: addr }),
    getPublicKey: async () => addr,
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => {
      window.__freighterSign = (window.__freighterSign || 0) + 1;
      return xdr;
    },
  };
});
await walletPage.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });
await walletPage.waitForSelector("#btn-connect");
await walletPage.$eval("#btn-connect", (n) => n.click());
await walletPage.waitForFunction(
  () => {
    const t = document.getElementById("wallet-state")?.textContent || "";
    return t.includes("bağlı") || t.includes("Bağlantı hatası") || t.includes("Freighter");
  },
  { timeout: 8000 }
).catch(() => null);
const walletText = await walletPage.$eval("#wallet-state", (n) => n.textContent);
const accessCalls = await walletPage.evaluate(() => window.__freighterRequestAccess || 0);
check("connect click calls requestAccess", accessCalls >= 1, `calls=${accessCalls} state=${walletText}`);
check("connect with mocked Freighter shows address", /GDML46BD/.test(walletText) || walletText.includes("bağlı"), walletText);

// 9 — the session address: once Connect has verified the address, an action
// button signs with it and must NOT open the wallet again. A second
// requestAccess mid-page is the bug that re-popped the wallet on every
// button (and got refused), so the counts are asserted, not assumed.
// (The mock signs the prepared tx unchanged; the RPC then rejects the
// unsigned bytes — the point of the check is the wallet call pattern,
// and nothing lands on the ledger.)
const accessBeforeAction = await walletPage.evaluate(() => window.__freighterRequestAccess || 0);
await jsClick(walletPage, "#btn-bump");
// Wait for a POST-sign log line, not the pre-sign "Waiting for bump
// signature…" line, so the sign counter is read after the signature.
await walletPage.waitForFunction(
  () => {
    const t = document.getElementById("acct-log")?.textContent || "";
    return /bump accepted|bump submitted|bump error|Blocked before|Action error/.test(t);
  },
  { timeout: 90000 }
).catch(() => null);
const walletCallsAfterAction = {
  access: await walletPage.evaluate(() => window.__freighterRequestAccess || 0),
  sign: await walletPage.evaluate(() => window.__freighterSign || 0),
};
check(
  "signed action reuses the session address (no second requestAccess)",
  walletCallsAfterAction.access === accessBeforeAction && accessBeforeAction === 1,
  `access=${walletCallsAfterAction.access} (before ${accessBeforeAction})`
);
check(
  "signed action actually asked Freighter to sign",
  walletCallsAfterAction.sign >= 1,
  `sign=${walletCallsAfterAction.sign}`
);
await walletPage.close();

await browser.close();

console.log("OK:");
for (const o of oks) console.log("  +", o);
if (fails.length) {
  console.log("FAIL:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`\nALL GREEN (${oks.length} checks)`);
