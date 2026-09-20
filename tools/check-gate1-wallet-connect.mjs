// Gate 1.0 cuzdan baglama kapisi.
//
// Onceden iki ayri sey bozuktu:
//   1. connectWallet yalnizca `window`a bakiyordu. Son Freighter surumleri
//      oraya hicbir sey enjekte etmiyor, npm modulu uzerinden postMessage ile
//      konusuyor - yani kurulu bir cuzdan "yuklu degil" diye reddediliyordu.
//   2. Baglanti kurulsa bile bakiye okuma cokuyordu: Horizon 404 disinda bir
//      hata dondugunde (400, 429, 504) cevapta `balances` yok, ve
//      account.balances.find(...) "Cannot read properties of undefined" ile
//      patliyordu. Kullanici gecerli bir cuzdanla TypeError goruyordu.
//
// Bu kapi ucunu de suruyor: enjekte edilmis cuzdan, hic cuzdan olmamasi ve
// Horizon'un reddi. Hicbirinde sayfa hatasi olmamali ve hicbirinde "undefined"
// bir adres ya da ham TypeError gorunmemeli.
import puppeteer from "puppeteer";

const BASE = process.env.GATE1_WEB_URL || "http://127.0.0.1:5175/";
// Friendbot ile fonlanmis gercek bir testnet hesabi; sadece okunur.
const FUNDED = process.env.GATE1_TEST_ACCOUNT || "GCL7DKN5H5YJPDROZ3EVIVOFP4CKQEGBNPP5CLITRQ2T4YMNAKR7CTNL";
const BAD = "GDMLNFBXQ3W6AVQWXKLM2DUOU44ZEVPWRSVBMS4ZDFGKAWTMLNS5I53V"; // Horizon buna 400 der

const fails = [], oks = [];
const check = (n, c, d = "") => (c ? oks : fails).push(`${n}${d ? ` — ${d}` : ""}`);

const browser = await puppeteer.launch({ headless: "shell", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function session(setup) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  if (setup) await page.evaluateOnNewDocument(setup.fn, setup.arg);
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2200));
  await page.evaluate(() => document.getElementById("connectBtn").click());
  // The official path is slower than the injected one by design: isConnected()
  // is raced against a 2.5s timeout before the address is even requested, and
  // then Horizon is read. Waiting less than that measures the timeout, not the
  // wallet.
  await page.waitForFunction(
    () => {
      const chip = document.getElementById("walletChip");
      const note = document.getElementById("walletNote");
      return (chip && !/not connected/i.test(chip.textContent)) ||
        (note && /not installed|frame|would not return/i.test(note.textContent));
    },
    { timeout: 20000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const read = async (id) => (await page.$eval(id, (n) => n.textContent.replace(/\s+/g, " ").trim()));
  const out = {
    chip: await read("#walletChip"),
    kind: await read("#walletKind"),
    note: await read("#walletNote"),
    kv: await read("#walletKv"),
    errors,
  };
  await page.close();
  return out;
}

const inject = (addr) => {
  window.freighterApi = {
    isConnected: async () => ({ isConnected: true }),
    requestAccess: async () => ({ address: addr }),
    getAddress: async () => ({ address: addr }),
    getNetwork: async () => ({ network: "TESTNET" }),
    signTransaction: async (x) => ({ signedTxXdr: x }),
  };
};

// 1 - gercek, fonlanmis hesap: baglanmali ve gercek bakiyeyi okumali
const good = await session({ fn: inject, arg: FUNDED });
check("an injected wallet connects", good.chip.startsWith(FUNDED.slice(0, 6)), good.chip);
check("it reports itself connected", /connected/i.test(good.kind), good.kind);
check("real balances are read from Horizon", /XLM/.test(good.kv) && /\d/.test(good.kv), good.kv.slice(0, 60));
check("the reserve is accounted for", /Spendable/i.test(good.kv));
check("no page error while connecting", good.errors.length === 0, good.errors[0] || "");

// 2 - SADECE npm modulu: `window`da hicbir sey yok, cuzdan content-script
// uzerinden konusuyor. Eski kod buna "Freighter yuklu degil" diyordu; bu
// kontrol o regresyonu geri gelirse yakalar.
const official = await session({
  fn: (addr) => {
    window.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      let payload = {};
      if (d.type === "REQUEST_CONNECTION_STATUS") payload = { isConnected: true };
      else if (d.type === "REQUEST_ACCESS" || d.type === "REQUEST_PUBLIC_KEY") payload = { publicKey: addr, address: addr };
      else if (d.type === "REQUEST_NETWORK") payload = { network: "TESTNET" };
      // The correlation field the module matches on is spelled `messagedId`
      // (sic) in @stellar/freighter-api; replying with `messageId` is ignored
      // and the call times out looking like "no wallet".
      window.postMessage({ source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: d.messageId, ...payload }, "*");
    });
  },
  arg: FUNDED,
});
check(
  "a wallet that only speaks over the npm module still connects",
  official.chip.startsWith(FUNDED.slice(0, 6)),
  `${official.chip} — nothing was injected on window`
);
check("no page error on the official path", official.errors.length === 0, official.errors[0] || "");

// 3 - Horizon reddi: duzgun cumle, cig TypeError degil
const bad = await session({ fn: inject, arg: BAD });
check("a Horizon refusal is explained, not thrown", !/undefined|TypeError/i.test(bad.note), bad.note.slice(0, 80));
check("the refusal names Horizon's own reason", /Horizon|invalid|balances/i.test(bad.note), bad.note.slice(0, 80));
check("no page error on a refused balance read", bad.errors.length === 0, bad.errors[0] || "");

// 4 - hic cuzdan yok: durust ve suclayici olmayan mesaj
const none = await session(null);
check("no wallet leaves the chip untouched", /not connected/i.test(none.chip), none.chip);
check("the absence is explained", /not installed|frame/i.test(none.note), none.note.slice(0, 70));
check("receiving is still described as keyless", /receiv/i.test(none.note));
check("no page error without a wallet", none.errors.length === 0, none.errors[0] || "");

console.log("OK:"); for (const o of oks) console.log(`  + ${o}`);
if (fails.length) { console.log("\nFAIL:"); for (const f of fails) console.log(`  - ${f}`); }
console.log(fails.length ? `\n${fails.length} FAILED of ${oks.length + fails.length}` : `\nALL GREEN (${oks.length} checks)`);
await browser.close();
process.exit(fails.length ? 1 : 0);
