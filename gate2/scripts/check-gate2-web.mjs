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
    return (t.match(/kayıt yok/g) || []).length >= 2 || t.includes("Okuma hatası") || t.includes("Sorgu hatası");
  },
  { timeout: 45000 }
);
const migText = await page.$eval("#res-migration", (n) => n.textContent);
check("get_migration live read -> kayıt yok x2", (migText.match(/kayıt yok/g) || []).length >= 2, migText.replace(/\s+/g, " ").slice(0, 100));
await page.waitForFunction(
  () => {
    const t = document.getElementById("res-nfts")?.textContent || "";
    return (t.match(/NFT/g) || []).length >= 2 && !t.includes("okunuyor");
  },
  { timeout: 60000 }
);
const nftText = await page.$eval("#res-nfts", (n) => n.textContent);
check("proofs_of live read -> 0 NFT both lanes", nftText.includes("0 NFT") && !nftText.includes("hata"), nftText.replace(/\s+/g, " ").slice(0, 80));

// 3 — claim_tier simulation shows the on-chain refusal
await jsClick(page, "#btn-tier-sim");
await page.waitForFunction(() => (document.getElementById("res-tier")?.textContent || "").includes("Reddedildi"), { timeout: 45000 });
const tierText = await page.$eval("#res-tier", (n) => n.textContent);
check("claim_tier sim -> NoMigration refusal visible", tierText.includes("#3") || tierText.includes("rozet yok"), tierText.replace(/\s+/g, " ").slice(0, 120));

// 4 — Burn tab honesty + working preconditions
await jsClick(page, "#tab-burn");
const blocker = await page.$eval("#burn-blocker", (n) => n.textContent);
check("burn blocker is honest (no router)", blocker.includes("kurulu degil") || blocker.includes("kurulu değil"));

await page.type("#in-strkey", "GABC");
await jsClick(page, "#btn-strkey");
let sk = await page.$eval("#res-strkey", (n) => n.textContent);
check("StrKey rejects junk", sk.includes("geçersiz"), sk);

await page.$eval("#in-strkey", (n, v) => { n.value = v; }, DEPLOYER);
await jsClick(page, "#btn-strkey");
sk = await page.$eval("#res-strkey", (n) => n.textContent);
check("StrKey accepts real address", sk.includes("geçerli"), sk);

await jsClick(page, "#btn-trustline");
await page.waitForFunction(() => (document.getElementById("res-trustline")?.textContent || "").includes("trustline") || (document.getElementById("res-trustline")?.textContent || "").includes("Hata"), { timeout: 90000 });
const tl = await page.$eval("#res-trustline", (n) => n.textContent);
check("trustline check live from Horizon (deployer has no USDC)", tl.includes("YOK") || tl.includes("VAR"), tl.replace(/\s+/g, " ").slice(0, 90));

// 5 — BURN word can never enable the button while the router is missing
await page.type("#in-burnword", "BURN");
const burnDisabled = await page.$eval("#btn-burn", (n) => n.disabled);
check("BURN button stays disabled without router", burnDisabled === true);

check("no failed requests / console errors", badRequests.length === 0, badRequests.slice(0, 3).join(" | "));

await browser.close();

console.log("OK:");
for (const o of oks) console.log("  +", o);
if (fails.length) {
  console.log("FAIL:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`\nALL GREEN (${oks.length} checks)`);
