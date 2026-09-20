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
// With no extension at all the official module's postMessage is never
// answered, so the honest state while the door times out is "asking" - the
// console must not sit silent, and must not claim a verdict it does not have.
check("a press with no wallet says what it is waiting on",
  /asking|approve|locked|not installed|did not return/i.test(none.note),
  none.note.slice(0, 80));
check("receiving is still described as keyless", /receiv/i.test(none.note));
check("no page error without a wallet", none.errors.length === 0, none.errors[0] || "");

// 4b - GESTURE VE YAVAS CUZDAN. Bildirilen hatanin asil sebebi buydu:
// tiklama ile requestAccess arasinda await varsa tarayici kullanici hareketini
// harcanmis sayar ve cuzdan popup'ini ENGELLER - tusa basilir, hicbir sey
// olmaz. Ayrica isConnected() yavas ya da sessizse kurulu cuzdan "kurulu
// degil" sayiliyordu.
//
// Iki senaryo da gercek bir fare tiklamasiyla surulur ve olculen sey niyet
// degil davranistir: requestAccess GERCEKTEN gonderildi mi, ve gonderildigi
// anda navigator.userActivation hala aktif miydi.
for (const [label, delay, payload] of [
  ["a silent content script", 0, null],
  ["a content script that answers in 4s", 4000, { isConnected: true }],
]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.evaluateOnNewDocument((addr, d, pl) => {
    window.__probe = { order: [], activation: null };
    window.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      window.__probe.order.push(msg.type);
      const reply = (body, ms) => setTimeout(() => window.postMessage(
        { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: msg.messageId, ...body }, "*"), ms);
      if (msg.type === "REQUEST_CONNECTION_STATUS") { if (pl !== null) reply(pl, d); }
      else if (msg.type === "REQUEST_ACCESS") {
        window.__probe.activation = navigator.userActivation ? navigator.userActivation.isActive : "unsupported";
        reply({ publicKey: addr, address: addr }, 50);
      } else if (msg.type === "REQUEST_NETWORK") reply({ network: "TESTNET" }, 20);
    });
  }, FUNDED, delay, payload);

  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.click("#connectBtn"); // gercek tiklama, sentetik degil
  await new Promise((r) => setTimeout(r, 9000));

  const probe = await page.evaluate(() => window.__probe);
  const chip = await page.$eval("#walletChip", (n) => n.textContent.trim());
  check(`requestAccess is attempted despite ${label}`,
    probe.order.includes("REQUEST_ACCESS"),
    `sent: ${probe.order.join(" -> ") || "nothing"}`);
  check(`the user gesture survives to the popup with ${label}`,
    probe.activation === true || probe.activation === "unsupported",
    String(probe.activation));
  check(`the wallet connects despite ${label}`, chip.startsWith(FUNDED.slice(0, 6)), chip);
  await page.close();
}

// 5 - CERCEVE. Bu, konsolun onizlemede gercekten calistigi durum ve
// "cuzdan baglanmiyor" sikayetinin asil sebebi: eklenti content script'leri
// all_frames: false ile gelir, yani bir iframe'e HIC enjekte olmazlar. Kod ne
// kadar dogru olursa olsun cerceve icinde baglanti mumkun degil. O yuzden
// kontrol edilen sey "baglandi mi" degil, "cikis yolu sunuluyor mu".
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  // Gercek eklenti davranisi: sadece ust cerceveye enjekte et.
  await page.evaluateOnNewDocument((addr) => {
    if (window.top === window.self) {
      window.freighterApi = {
        isConnected: async () => ({ isConnected: true }),
        requestAccess: async () => ({ address: addr }),
        getAddress: async () => ({ address: addr }),
        getNetwork: async () => ({ network: "TESTNET" }),
        signTransaction: async (x) => ({ signedTxXdr: x }),
      };
    }
  }, FUNDED);
  await page.setContent(
    `<!doctype html><html><body style="margin:0"><iframe src="${BASE}" style="width:100%;height:900px;border:0"></iframe></body></html>`,
    { waitUntil: "networkidle2" }
  );
  await new Promise((r) => setTimeout(r, 3500));
  const frame = page.frames().find((f) => f.url().includes(new URL(BASE).port || "5175"));
  check("the framed console loads", Boolean(frame));

  if (frame) {
    const label = await frame.$eval("#connectBtn", (n) => n.textContent.trim());
    const link = await frame.evaluate(() => Boolean(document.getElementById("walletTabLink")));
    const note = await frame.$eval("#walletNote", (n) => n.textContent.replace(/\s+/g, " "));

    // Tiklamadan ONCE soylenmeli: tiklayip basarisiz olmayi beklemek degil.
    check("a framed console offers the tab before any click", /tab/i.test(label), label);
    check("a clickable link is present as a popup-blocker fallback", link);
    check("the note explains frames, not a missing wallet",
      /frame/i.test(note) && !/not installed in this browser/i.test(note), note.slice(0, 80));

    const before = (await browser.pages()).length;
    await frame.evaluate(() => document.getElementById("connectBtn").click());
    await new Promise((r) => setTimeout(r, 3000));
    check("pressing it opens a top-level tab", (await browser.pages()).length > before);
    check("no page error in a frame", errors.length === 0, errors[0] || "");
  }
  await page.close();
}

console.log("OK:"); for (const o of oks) console.log(`  + ${o}`);
if (fails.length) { console.log("\nFAIL:"); for (const f of fails) console.log(`  - ${f}`); }
console.log(fails.length ? `\n${fails.length} FAILED of ${oks.length + fails.length}` : `\nALL GREEN (${oks.length} checks)`);
await browser.close();
process.exit(fails.length ? 1 : 0);
