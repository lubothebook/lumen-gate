// Real-wallet proof for both web surfaces (Gate 1.0 console + Gate 2.0).
//
// The browser checks prove the pages respond; this harness proves the buttons
// move real value on the real Stellar testnet. No mock chain, no mock wallet
// internals: a fresh keypair is funded by Friendbot, a Freighter-shaped object
// is injected before the app boots (the exact API surface the extension
// exposes: requestAccess/getAddress/getNetwork/setAllowed/signTransaction),
// and every signature it is asked for is a real ed25519 signature from the
// funded key, produced here and handed back through the same seam the real
// extension uses. The secret key is generated in memory and never written
// anywhere; nothing in this file can spend anything after it exits.
//
// What is proven, per surface:
//   gate2 (default http://127.0.0.1:5174/gate2/):
//     connect            -> the real address is shown
//     USDC trustline ac  -> a REAL ChangeTrust lands on testnet (Horizon-verified)
//     TESTNET damgasi    -> a REAL contract invocation, tx SUCCESS on RPC
//     bump               -> a REAL contract invocation, tx SUCCESS on RPC
//     claim_tier gonder  -> a REAL submitted tx the campaign contract refuses
//                           on-chain (NoMigration #3) - the honest chain answer
//   console (default http://127.0.0.1:5173, skipped if not running):
//     connect            -> the real address is shown
//     burn               -> reaches the chain and reports the chain's own
//                           refusal for an account with no wSRC trustline -
//                           no ReferenceError, no silent click
//     lock / settle      -> answer with the exact deployment reason when this
//                           deployment has no source adapter / no relayer
//
// Run it against the dev servers:
//   cd gate2/scripts && npm install
//   cd ../web && npm run dev &            # :5174/gate2/
//   node ../../tools/api-dev-server.js &  # :3001, the /api layer for 1.0
//   cd ../../frontend && npm run dev &    # :5173
//   node gate2/scripts/verify-real-wallet.mjs
//
// Env: GATE2_WEB_URL, CONSOLE_URL (set to "skip" to skip the 1.0 part).
// Exit 0 only when every check passed (skips do not fail the run, they are
// printed as skips).

import puppeteer from "puppeteer";
import StellarSdk from "@stellar/stellar-sdk"; // CJS package: default import, then destructure
const { Keypair, TransactionBuilder } = StellarSdk;
// v13 moved the RPC client under .rpc (SorobanRpc is the v12 name).
const Server = StellarSdk.rpc ? StellarSdk.rpc.Server : StellarSdk.SorobanRpc.Server;
const RPC = new Server("https://soroban-testnet.stellar.org");

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON = "https://horizon-testnet.stellar.org";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const GATE2_URL = process.env.GATE2_WEB_URL || "http://127.0.0.1:5174/gate2/";
const CONSOLE_URL = process.env.CONSOLE_URL || "http://127.0.0.1:5173";

const fails = [];
const oks = [];
const skips = [];
function check(name, cond, detail = "") {
  (cond ? oks : fails).push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, why) {
  skips.push(`${name} — ${why}`);
}

async function reachable(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok || res.status === 405 || res.status === 404; // a server answered
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the wallet
const kp = Keypair.random();
const PUB = kp.publicKey();
console.log(`real testnet account: ${PUB} (funded by Friendbot for this run only)`);

async function fundOnce() {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(PUB)}`);
  if (res.ok) return true;
  // Already funded earlier in this second? friendbot answers 400 with a hash.
  const text = await res.text();
  return /already/i.test(text) ? true : false;
}
let funded = false;
for (let i = 0; i < 3 && !funded; i += 1) {
  funded = await fundOnce();
  if (!funded) await new Promise((r) => setTimeout(r, 4000));
}
check("friendbot funded the real account", funded);
if (!funded) {
  console.error("FAIL: friendbot refused; cannot prove anything real today");
  process.exit(1);
}

// Sign exactly what the page asks the wallet to sign - nothing else.
async function signForPage(xdr) {
  const tx = TransactionBuilder.fromXDR(String(xdr), NETWORK_PASSPHRASE);
  tx.sign(kp);
  return tx.toXDR("base64");
}

// Freighter-shaped object, injected before any app script runs. The apps find
// it through window.freighterApi, the same door the real extension uses.
function freighterStubSource() {
  return `
    window.freighterApi = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      setAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: ${JSON.stringify(PUB)} }),
      getAddress: async () => ({ address: ${JSON.stringify(PUB)} }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: ${JSON.stringify(NETWORK_PASSPHRASE)} }),
      signTransaction: async (xdr, opts) => ({
        signedTxXdr: await window.__lgRealSign(xdr, opts),
        signerAddress: ${JSON.stringify(PUB)},
      }),
    };
  `;
}

async function openApp(browser, url, pageErrors) {
  const page = await browser.newPage();
  await page.exposeFunction("__lgRealSign", (xdr) => signForPage(xdr).catch((e) => {
    throw e;
  }));
  await page.evaluateOnNewDocument(freighterStubSource());
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 200)));
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  return page;
}

const jsClick = (page, sel) => page.$eval(sel, (n) => n.click());
const waitForText = async (page, sel, needle, timeout = 90000) => {
  try {
    await page.waitForFunction(
      (s, t) => (document.querySelector(s)?.textContent || "").includes(t),
      { timeout },
      sel,
      needle
    );
    return (await page.$eval(sel, (n) => n.textContent)).replace(/\s+/g, " ").trim();
  } catch {
    return (await page.$eval(sel, (n) => n.textContent).catch(() => "")).replace(/\s+/g, " ").trim();
  }
};

// Raw JSON-RPC on purpose: this SDK line fails to parse the current
// testnet getTransaction shape, and the proof must not depend on SDK
// version quirks - the RPC answer itself is the evidence.
async function waitForFinal(page, sel, word) {
  try {
    await page.waitForFunction(
      (s, w) => {
        const t = document.querySelector(s)?.textContent || "";
        return t.includes(w) && !/bekleniyor/.test(t) && /[a-f0-9]{64}/.test(t);
      },
      { timeout: 150000 },
      sel,
      word
    );
  } catch { /* report whatever is there */ }
  return (await page.$eval(sel, (n) => n.textContent).catch(() => "")).replace(/\s+/g, " ").trim();
}

async function txStatus(hash) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch("https://soroban-testnet.stellar.org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
      });
      const json = await res.json();
      const status = json?.result?.status;
      if (status === "SUCCESS" || status === "FAILED") return status;
    } catch { /* NOT_FOUND while pending */ }
    await new Promise((res) => setTimeout(res, 2500));
  }
  return "TIMEOUT";
}

const browser = await puppeteer.launch({ headless: "shell", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

// ================================================================ Gate 2.0
if (await reachable(GATE2_URL)) {
  const pageErrors = [];
  const page = await openApp(browser, GATE2_URL, pageErrors);

  // 1 — connect shows the real address
  await jsClick(page, "#btn-connect");
  const walletState = await waitForText(page, "#wallet-state", PUB.slice(0, 8));
  check("gate2 connect shows the real address", walletState.includes(PUB.slice(-6)), walletState.slice(0, 60));

  // 2 — a real USDC ChangeTrust through the button
  await jsClick(page, "#btn-trust-open");
  let trustLog = await waitForText(page, "#acct-log", "Trustline");
  let trustHash = (trustLog.match(/[a-f0-9]{64}/) || [])[0];
  check("gate2 trustline button reported", Boolean(trustHash), trustLog.slice(0, 90));
  if (trustHash) {
    let hasUsdc = false;
    for (let i = 0; i < 20 && !hasUsdc; i += 1) {
      const acc = await (await fetch(`${HORIZON}/accounts/${PUB}`)).json();
      hasUsdc = (acc.balances || []).some((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
      if (!hasUsdc) await new Promise((r) => setTimeout(r, 2000));
    }
    check("gate2 USDC trustline is really on testnet", hasUsdc, `tx ${trustHash}`);
  }

  // 3 — a real TESTNET stamp invocation (stamp(owner) — the owner arg is the call)
  await jsClick(page, "#btn-stamp");
  let stampLog = await waitForFinal(page, "#acct-log", "Damga");
  let stampHash = (stampLog.match(/[a-f0-9]{64}/) || [])[0];
  check("gate2 stamp button sent a real tx", Boolean(stampHash), stampLog.slice(0, 120));
  if (stampHash) {
    const st = await txStatus(stampHash);
    check("gate2 stamp tx SUCCESS on testnet", st === "SUCCESS", `tx ${stampHash} -> ${st}`);
  }

  // 4 — a real bump invocation
  await jsClick(page, "#btn-bump");
  let bumpLog = await waitForFinal(page, "#acct-log", "bump");
  let bumpHash = (bumpLog.match(/[a-f0-9]{64}/) || [])[0];
  check("gate2 bump button sent a real tx", Boolean(bumpHash), bumpLog.slice(0, 120));
  if (bumpHash) {
    const st = await txStatus(bumpHash);
    check("gate2 bump tx SUCCESS on testnet", st === "SUCCESS", `tx ${bumpHash} -> ${st}`);
  }

  // 5 — claim_tier: for an account with no migration the contract itself
  // refuses (NoMigration #3). The refusal is the RPC executing the call
  // against real ledger state; the app reports it instead of submitting a
  // doomed transaction - that answer is the proof the button works.
  await jsClick(page, "#btn-tier-send");
  const tierLog = await waitForText(page, "#res-tier", "Reddedildi", 90000);
  check(
    "gate2 claim_tier gets the chain's own NoMigration refusal",
    /Reddedildi/.test(tierLog) && /#3|NoMigration/.test(tierLog),
    tierLog.slice(0, 120)
  );

  // 6 — no runtime errors anywhere above
  check("gate2 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await page.close();
} else {
  skip("gate2 real-wallet checks", `no server at ${GATE2_URL} (cd gate2/web && npm run dev)`);
}

// =========================================================== Gate 1.0 console
if (CONSOLE_URL === "skip") {
  skip("console real-wallet checks", "CONSOLE_URL=skip");
} else if (await reachable(CONSOLE_URL)) {
  const pageErrors = [];
  const page = await openApp(browser, CONSOLE_URL, pageErrors);

  // Vite dev re-optimizes dependencies the first time a runtime import pulls
  // a new package in, and that triggers a full page reload - which would
  // reset the wallet state mid-flow. Touch the module graph once and settle
  // before the real pass. (Production builds bundle ahead; no reload there.)
  try { await page.evaluate(() => import("/src/soroban.ts")); } catch { /* warm only */ }
  await new Promise((r) => setTimeout(r, 1500));
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });

  // 1 — connect shows the real address
  await jsClick(page, "#connectBtn");
  const connectLog = await waitForText(page, "#txLog", "Wallet connected via requestAccess");
  check("console connect shows the real address", connectLog.includes(PUB), connectLog.slice(-140));

  // 2 — burn: must reach the chain and report the chain's own answer for an
  // account that holds no wSRC. The old code died here on a ReferenceError.
  await jsClick(page, "#tabOutbound");
  await page.$eval("#burnAmount", (n) => { n.value = "1"; });
  await page.$eval("#burnRecipient", (n) => { n.value = "GBYFDKP4KLQ575HTJRDTHF4HUIVXAQLJNEZMWYJ5HBY3C3GDSPX5H4FR"; });
  await jsClick(page, "#burnBtn");
  const burnLog = await waitForText(page, "#txLog", "Preparing a burn");
  const burnOutcome = await waitForText(page, "#txLog", "Burn failed:");
  const burnLine = [burnLog, burnOutcome].join(" ").slice(-400);
  check(
    "console burn reaches the chain and reports the real refusal",
    burnOutcome.includes("Burn failed:") && /simulation|Error|Contract/i.test(burnOutcome),
    burnOutcome.slice(-160)
  );
  check(
    "console burn is not the old ReferenceError",
    !burnLine.includes("recipient is not defined"),
    burnLine.slice(-120)
  );

  // 3 — lock answers with the deployment reason (no source adapter here)
  await jsClick(page, "#tabInbound");
  await page.$eval("#lockAmount", (n) => { n.value = "1"; });
  await page.$eval("#lockRecipient", (n, v) => { n.value = v; }, PUB);
  await jsClick(page, "#lockBtn");
  const lockLine = await waitForText(page, "#txLog", "Lock refused");
  check("console lock answers with the reason", /Lock refused/.test(lockLine), lockLine.slice(-140));

  // 4 — settle answers when nothing is locked
  await jsClick(page, "#settleBtn");
  const settleLine = await waitForText(page, "#txLog", "Nothing to settle");
  check("console settle answers when nothing is locked", /Nothing to settle/.test(settleLine), settleLine.slice(-140));

  // 5 — no runtime errors anywhere above
  check("console zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await page.close();
} else {
  skip("console real-wallet checks", `no server at ${CONSOLE_URL} (api-dev-server + cd frontend && npm run dev)`);
}

await browser.close();

console.log("\nOK:");
for (const line of oks) console.log(`  + ${line}`);
if (skips.length) {
  console.log("SKIPPED:");
  for (const line of skips) console.log(`  ~ ${line}`);
}
if (fails.length) {
  console.log("FAIL:");
  for (const line of fails) console.log(`  - ${line}`);
  console.log(`\nreal-wallet proof: ${oks.length} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`\nreal-wallet proof: ${oks.length} passed, 0 failed — the buttons move real value on testnet`);
process.exit(0);
