// F5/F6 panellerinin CANLI testnet'ten okuduğunu kanıtlar. Uydurma yok:
// her iddia DOM'dan okunur ve zincirdeki gerçek değerle karşılaştırılır.
import puppeteer from "puppeteer";
const BASE = process.env.GATE2_WEB_URL || "http://127.0.0.1:5174/gate2/";
const DEPLOYER = "GCXY2QUBCVBP4J7V3O6HMTCLWJ4YOMEDAWFTLTSYQ5SHOY2L4UVKLAS2";
const BATTERY = "CCU3242HDFXVJCHD6MU6YA5MJF62OX6EVGIVQ7I4LKKEJ2Y6HNJDNBJG";
const TICKET  = "CAAZBV6QTKAPOWEHWF7B7Z7Z7ABBIDPEE434IFIORZ3WRROKASEPDPN7";
const fails=[], oks=[];
const check=(n,c,d="")=>(c?oks:fails).push(`${n}${d?` — ${d}`:""}`);
const jsClick=(p,s)=>p.$eval(s,n=>n.click());

const browser = await puppeteer.launch({ headless:"shell", args:["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage();
const bad=[];
page.on("requestfailed",r=>bad.push(`${r.url().slice(0,80)} ${r.failure()?.errorText}`));
page.on("console",m=>{ if(m.type()==="error") bad.push(`console: ${m.text().slice(0,140)}`); });
await page.goto(BASE,{waitUntil:"networkidle2",timeout:30000});

// 1 - ids come from the receipt, not hardcoded in the page
await jsClick(page,"#tab-battery");
const bId = await page.$eval("#battery-id",n=>n.textContent.trim());
check("battery id from receipt", bId===BATTERY, bId.slice(0,20));
await jsClick(page,"#tab-tickets");
const tId = await page.$eval("#ticket-id",n=>n.textContent.trim());
check("ticket id from receipt", tId===TICKET, tId.slice(0,20));

// 2 - ticket supply is read live on tab open
await page.waitForFunction(()=>{
  const t=document.getElementById("ticketKv")?.textContent||"";
  return t.includes("USDC")||t.includes("read failed");
},{timeout:30000});
const tkv = await page.$eval("#ticketKv",n=>n.textContent.replace(/\s+/g," ").trim());
check("ticket supply read live", tkv.includes("0.000000 USDC"), tkv.slice(0,90));
check("ticket read did not fail", !tkv.includes("read failed"), tkv.slice(0,60));

// 3 - listing a real address returns an honest empty answer
await page.type("#in-ticket-addr", DEPLOYER);
await jsClick(page,"#btn-ticket-read");
await page.waitForFunction(()=>{
  const t=document.getElementById("ticketKv")?.textContent||"";
  return t.includes("Tickets held");
},{timeout:30000});
const tkv2 = await page.$eval("#ticketKv",n=>n.textContent.replace(/\s+/g," ").trim());
check("tickets_of live -> none", tkv2.includes("none"), tkv2.slice(0,110));

// 4 - battery balance for a real address
await jsClick(page,"#tab-battery");
await page.type("#in-battery-addr", DEPLOYER);
await jsClick(page,"#btn-battery-read");
await page.waitForFunction(()=>{
  const t=document.getElementById("batteryKv")?.textContent||"";
  return t.includes("USDC")||t.includes("failed");
},{timeout:30000});
const bkv = await page.$eval("#batteryKv",n=>n.textContent.replace(/\s+/g," ").trim());
check("battery balance_of live", bkv.includes("0.000000 USDC"), bkv.slice(0,90));
check("battery read did not fail", !bkv.includes("failed"), bkv.slice(0,60));

// 5 - write buttons stay shut without a wallet, and say why
// Unavailable is asserted the way the app now expresses it. A hard `disabled`
// swallows the click before any handler runs, so the button can never say why
// it is grey; the app marks it aria-disabled instead, which keeps it focusable
// and lets the press answer. Either spelling counts as shut here - what must
// not happen is the control looking live without a wallet.
const dep = await page.$eval("#btn-battery-deposit",n=>({
  d:n.disabled, aria:n.getAttribute("aria-disabled"), t:n.title,
}));
check("top-up unavailable without wallet", dep.d===true || dep.aria==="true",
  `disabled=${dep.d} aria-disabled=${dep.aria}`);

// The attribute alone proves nothing: it is also written statically in the
// HTML, so it stays "true" even if the script that maintains it is broken.
// What actually matters is the behaviour - press it with no wallet connected
// and it must refuse in words, not move money and not sit silent.
await page.$eval("#in-battery-amount", n => { n.value = "1"; });
await page.evaluate(() => document.getElementById("btn-battery-deposit").click());
await new Promise(r => setTimeout(r, 1200));
const pressed = await page.evaluate(() => {
  const parts = ["res-battery", "acct-log"].map((id) => document.getElementById(id)?.textContent || "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
});
check("pressing top-up without a wallet answers instead of signing",
  /connect|wallet|freighter/i.test(pressed), pressed.slice(0,70) || "(said nothing)");
check("top-up explains itself", (dep.t||"").length>20, (dep.t||"").slice(0,50));

// 6 - minting is honestly closed
const mint = await page.$eval("#ticketMintNote",n=>n.textContent.replace(/\s+/g," ").trim());
check("minting honestly closed", /init_minter|Minting is closed/.test(mint), mint.slice(0,70));

// 7 - the old lie is gone
const body = await page.$eval("body",n=>n.textContent);
check("no 'not written yet' claim left", !body.includes("not written yet"));

check("no failed requests / console errors", bad.length===0, bad.slice(0,2).join(" | "));

console.log("OK:"); for(const o of oks) console.log("  + "+o);
if(fails.length){ console.log("\nFAIL:"); for(const f of fails) console.log("  - "+f); }
console.log(fails.length?`\n${fails.length} FAILED of ${oks.length+fails.length}`:`\nALL GREEN (${oks.length} checks)`);
await browser.close();
process.exit(fails.length?1:0);
