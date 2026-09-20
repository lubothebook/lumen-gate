import "./style.css";
import { StrKey } from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";
import {
  readContract,
  addrScVal,
  hasUsdcTrustline,
  getFreighter,
  watchFreighter,
  detectFreighter,
  freighterConnect,
  sendWithFreighter,
  friendbot,
  openUsdcTrustline,
  embeddedFrame,
  EXPLORER_TX,
  EXPLORER_ACCOUNT,
} from "./stellar.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const pill = (text, cls = "pill") => el("span", cls, text);
const fmtUsdc6 = (v) => (typeof v === "bigint" ? Number(v) : v ?? 0).toLocaleString("tr-TR", { maximumFractionDigits: 6 }) ;
const div6 = (v) => (Number(typeof v === "bigint" ? v : v ?? 0) / 1e6).toFixed(6);

let connectedAddress = null;
let currentQueryAddress = null;

// An unavailable action is not a dead button. A hard `disabled` swallows the
// click before any handler runs, so the control can never say why it is grey;
// aria-disabled keeps it focusable and clickable, and the handler is where
// the honest reason lands. The handlers below all answer when they cannot act.
function markAction(id, available) {
  const b = $(id);
  if (!b) return;
  if (available) b.removeAttribute("aria-disabled");
  else b.setAttribute("aria-disabled", "true");
}

// ---------- tabs (1.0 Move-value pattern: one card, the pane below switches) ----------
const TAB_NAMES = ["proof", "burn", "battery", "tickets"];
function showTab(name) {
  for (const n of TAB_NAMES) {
    const tab = $(`tab-${n}`);
    const page = $(`page-${n}`);
    const on = n === name;
    if (tab) {
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    if (page) page.classList.toggle("hidden", !on);
  }
  if (name === "burn" || name === "proof") {
    const consoleEl = $("console");
    if (consoleEl && window.matchMedia("(max-width: 720px)").matches) {
      /* keep the working pane in view on a phone after a tab change */
    }
  }
}
$("tab-proof").addEventListener("click", () => showTab("proof"));
$("tab-burn").addEventListener("click", () => showTab("burn"));
$("tab-battery")?.addEventListener("click", () => showTab("battery"));
$("tab-tickets")?.addEventListener("click", () => showTab("tickets"));

// 2.0 kutucuğu: 1.0'daki gibi alttaki bandı bu sürümün çalışma alanı yapar.
$("gate2Select")?.addEventListener("click", () => {
  $("console")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- static honesty ----------
$("contract-ids").textContent =
  `gate_claim (kanonik/sertlestirilmis): ${CONFIG.gateClaimCanonical} · ` +
  `gate_claim (F3 kulvari, kampanya buna bagli): ${CONFIG.gateClaimPreHardening} · ` +
  `kampanya: ${CONFIG.campaign} · ` +
  `testnet damga: ${CONFIG.stamp}`;
$("burn-blocker").textContent = CONFIG.burnRouterBlocker;
$("iris-url").textContent = CONFIG.irisApi;

// ---------- freighter ----------
function setWalletState(text, cls = "muted") {
  const s = $("wallet-state");
  s.textContent = text;
  s.className = cls;
}
function paintEmbedGate() {
  const framed = embeddedFrame();
  const tab = $("btn-open-tab");
  if (tab) {
    tab.href = window.location.href;
    tab.target = "_blank";
    tab.classList.toggle("hidden", !framed);
  }
  if (framed) {
    setWalletState("Bu çerçevede uzantı yok. Sekmede aç, sonra bağlan.", "error");
  }
}
async function connectWallet() {
  paintEmbedGate();
  const found = await detectFreighter();
  if (!found.installed) {
    const note = embeddedFrame()
      ? "Freighter bu çerçeveye giremez. Sekmede aç, sonra bağlan."
      : "Freighter yok. chrome.google.com/webstore’dan Freighter kur, sayfayı yenile, bağlan.";
    setWalletState(note, "error");
    acctLog(note);
    return null;
  }
  setWalletState("Freighter açılıyor…", "muted");
  try {
    const addr = await freighterConnect(found.api, { installed: found.installed });
    connectedAddress = addr;
    setWalletState(`${addr.slice(0, 8)}…${addr.slice(-6)} bağlı`, "ok");
    $("in-address").value = addr;
    $("in-strkey").value = addr;
    markAction("btn-tier-send", true);
    markAction("btn-trustline", true);
    setWalletActions(true);
    await refreshBalances(addr);
    acctLog(`Bağlandı. Expert: ${addr.slice(0, 8)}…`);
    if (typeof found.api.getNetwork === "function") {
      try {
        const net = await found.api.getNetwork();
        const name = typeof net === "string" ? net : net && (net.network || net.networkPassphrase);
        if (name && !/test/i.test(String(name))) {
          setWalletState(`Bağlı ama Freighter ${name} üzerinde. Mainnet’te işlem düğmeleri kapalı.`, "error");
          markAction("btn-tier-send", false);
          markAction("btn-burn", false);
          setWalletActions(false);
        }
      } catch {
        /* getNetwork is advisory; some builds refuse it until unlocked */
      }
    }
    return addr;
  } catch (e) {
    setWalletState(`Bağlantı hatası: ${e.message || e}`, "error");
    return null;
  }
}
function onFreighter(f) {
  if (embeddedFrame()) {
    paintEmbedGate();
    return;
  }
  if (!f) {
    setWalletState("Freighter bulunamadı. Uzantıyı kur, sayfayı yenile, bağlan.", "muted");
    return;
  }
  setWalletState("Freighter hazır — bağlanmak için tıkla", "ok");
}
function acctLog(text, hash) {
  const box = $("acct-log");
  if (!box) return;
  box.textContent = "";
  box.appendChild(el("div", "muted", text));
  if (hash) {
    const a = document.createElement("a");
    a.href = EXPLORER_TX + hash;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = hash;
    a.className = "contracts";
    box.appendChild(a);
  }
}

function setWalletActions(on) {
  for (const id of ["btn-fund", "btn-trust-open", "btn-bump", "btn-trust-open-burn", "btn-stamp"]) {
    markAction(id, on);
  }
}

async function refreshBalances(g) {
  const kv = $("walletKv");
  if (!kv || !g) return;
  try {
    const r = await hasUsdcTrustline(g);
    kv.innerHTML = "";
    if (!r.exists) {
      kv.appendChild(el("tr", null, null));
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>Hesap</td><td>zincirde yok — Friendbot ile XLM al</td>";
      kv.appendChild(tr);
      return;
    }
    const xlm = (r.balances || []).find((b) => b.asset_type === "native");
    const usdc = (r.balances || []).find((b) => b.asset_code === "USDC" && b.asset_issuer === CONFIG.usdcIssuer);
    const row = (k, v) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", null, k));
      tr.appendChild(el("td", "mono", v));
      kv.appendChild(tr);
    };
    row("XLM", xlm ? Number(xlm.balance).toFixed(7) : "—");
    row("USDC", usdc ? `${Number(usdc.balance).toFixed(7)} (trustline var)` : "trustline yok");
    const link = document.createElement("a");
    link.href = EXPLORER_ACCOUNT + g;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Stellar Expert’te aç";
    link.className = "link-btn";
    $("walletNote")?.append?.("");
  } catch (e) {
    acctLog(`Bakiye okunamadı: ${e.message || e}`);
  }
}

paintEmbedGate();
watchFreighter(onFreighter);
$("btn-connect").addEventListener("click", () => connectWallet());

// ---------- Taşıma Kanıtım ----------
async function queryAddress(g) {
  currentQueryAddress = g;
  $("res-which").textContent = `${g.slice(0, 8)}…${g.slice(-6)}`;
  $("results").classList.remove("hidden");
  const migBox = $("res-migration");
  const nftBox = $("res-nfts");
  migBox.textContent = "Zincirden okunuyor…";
  nftBox.textContent = "";

  // Both live gate_claim deployments are queried — the canonical hardened
  // one and the F3-lane one the campaign is wired to. Nothing is hidden.
  const lanes = [
    { name: "kanonik (sertlestirilmis)", id: CONFIG.gateClaimCanonical },
    { name: "F3 kulvari (kampanya buna bagli)", id: CONFIG.gateClaimPreHardening },
  ];
  migBox.innerHTML = "";
  for (const lane of lanes) {
    const head = el("h3", "muted", `${lane.name} — ${lane.id.slice(0, 10)}…`);
    migBox.appendChild(head);
    const r = await readContract(lane.id, "get_migration", [{ scVal: addrScVal(g) }]);
    if (!r.ok) {
      migBox.appendChild(el("div", "error", `Okuma hatası: ${r.error}`));
      continue;
    }
    if (r.value == null) {
      migBox.appendChild(pill("kayıt yok"));
      continue;
    }
    const t = el("table");
    const rows = [
      ["Toplam USDC (6 ondalık)", div6(r.value.total_usdc)],
      ["Claim sayısı", String(r.value.claim_count)],
      ["İlk / son ledger", `${r.value.first_ledger} / ${r.value.last_ledger}`],
      ["Kaynak domainler", (r.value.sources || []).join(", ") || "—"],
    ];
    for (const [k, v] of rows) {
      const tr = el("tr");
      tr.appendChild(el("th", null, k));
      tr.appendChild(el("td", null, v));
      t.appendChild(tr);
    }
    migBox.appendChild(t);
  }

  // NFTs from the F3-lane gate (the campaign reads this one; the hardened
  // lane has no claims yet either — both are queried, both are honest).
  try {
    const st = await readContract(CONFIG.stamp, "stamp_of", [{ scVal: addrScVal(g) }]);
    if (st.ok && st.value !== null && st.value !== undefined) {
      migBox.appendChild(el("div", "muted", `TESTNET damga (CCTP değil): id=${st.value}`));
    } else if (st.ok) {
      migBox.appendChild(el("div", "muted", "TESTNET damga: yok"));
    }
  } catch { /* stamp is additive */ }

  nftBox.textContent = "NFT listesi okunuyor…";
  nftBox.innerHTML = "";
  for (const lane of lanes) {
    const r = await readContract(lane.id, "proofs_of", [{ scVal: addrScVal(g) }]);
    if (!r.ok) {
      nftBox.appendChild(el("div", "error", `${lane.name}: okuma hatası ${r.error}`));
      continue;
    }
    const ids = r.value || [];
    nftBox.appendChild(el("div", "muted", `${lane.name}: ${ids.length} NFT`));
    for (const id of ids) {
      const card = el("div", "nft");
      card.appendChild(el("h3", null, `Taşıma Kanıtı #${id}`));
      const [proof, meta, owner] = await Promise.all([
        readContract(lane.id, "get_proof", [{ value: id, type: "u64" }]),
        readContract(lane.id, "get_meta", [{ value: id, type: "u64" }]),
        readContract(lane.id, "owner_of", [{ value: id, type: "u64" }]),
      ]);
      const p = proof.value || {};
      const t = el("table");
      const rows = [
        ["Sahip (owner_of)", owner.ok && owner.value ? String(owner.value) : "—"],
        ["Kaynak domain", String(p.source_domain ?? "—")],
        ["Nonce", String(p.nonce ?? "—")],
        ["Tutar (USDC 6 ondalık)", div6(p.amount_6)],
        ["Yürütülen ücret", div6(p.fee_executed_6)],
        ["Ledger", String(p.ledger ?? "—")],
        ["Mesaj hash", p.message_hash ? String(p.message_hash) : "—"],
        ["Meta (domain/nonce/tutar/ücret/ledger)", meta.ok && meta.value ? JSON.stringify(meta.value, (k, v) => typeof v === "bigint" ? String(v) : v) : "—"],
      ];
      for (const [k, v] of rows) {
        const tr = el("tr");
        tr.appendChild(el("th", null, k));
        tr.appendChild(el("td", null, v));
        t.appendChild(tr);
      }
      card.appendChild(t);
      nftBox.appendChild(card);
    }
  }
}

$("btn-query").addEventListener("click", () => {
  const g = $("in-address").value.trim();
  const box = $("addr-error");
  if (!StrKey.isValidEd25519PublicKey(g)) {
    box.textContent = "Geçersiz Stellar adresi — StrKey doğrulaması başarısız.";
    box.classList.remove("hidden");
    return;
  }
  box.classList.add("hidden");
  queryAddress(g).catch((e) => {
    box.textContent = `Sorgu hatası: ${e.message || e}`;
    box.classList.remove("hidden");
  });
});

// ---------- claim_tier ----------
function renderTier(box, label, r) {
  box.innerHTML = "";
  box.appendChild(el("div", "muted", label));
  if (!r.ok) {
    box.appendChild(el("div", "error", `Reddedildi: ${String(r.error).slice(0, 300)}`));
    box.appendChild(pill("rozet yok → sözleşme reddetti", "pill bad"));
    return;
  }
  const names = { 1: "Bronze", 2: "Silver", 3: "Gold" };
  const v = r.value;
  const name = names[v] || (v && names[v.value]) || JSON.stringify(v, (k, x) => typeof x === "bigint" ? String(x) : x);
  box.appendChild(pill(`Kademe: ${name}`, "pill ok"));
}

$("btn-tier-sim").addEventListener("click", async () => {
  const g = currentQueryAddress || connectedAddress || $("in-address").value.trim();
  if (!StrKey.isValidEd25519PublicKey(g)) {
    renderTier($("res-tier"), "Önce geçerli bir adres sorgula.", { ok: true, value: null });
    return;
  }
  $("res-tier").textContent = "Simüle ediliyor (tx gönderilmez)…";
  const r = await readContract(CONFIG.campaign, "claim_tier", [{ scVal: addrScVal(g) }]);
  renderTier($("res-tier"), `claim_tier simülasyonu — ${g.slice(0, 8)}…`, r);
});

$("btn-tier-send").addEventListener("click", async () => {
  const f = getFreighter();
  if (!f || !connectedAddress) {
    const box = $("res-tier");
    box.innerHTML = "";
    box.appendChild(el("div", "muted", "Once Freighter ile baglan: claim_tier, gercek bir imzali islemdir ve imza cüzdandan gelir."));
    return;
  }
  $("res-tier").textContent = "Freighter imzası bekleniyor…";
  try {
    const r = await sendWithFreighter(f, CONFIG.campaign, "claim_tier", [
      { scVal: addrScVal(connectedAddress) },
    ]);
    $("res-tier").innerHTML = "";
    if (r.ok) {
      $("res-tier").appendChild(pill(`tx: ${r.hash}`, "pill ok"));
    } else {
      $("res-tier").appendChild(el("div", "error", `Reddedildi: ${String(r.error).slice(0, 300)}`));
    }
  } catch (e) {
    renderTier($("res-tier"), "Gönderim hatası", { ok: false, error: e.message || String(e) });
  }
});

// ---------- Burn Ekranı ön koşulları ----------
$("btn-strkey").addEventListener("click", () => {
  const g = $("in-strkey").value.trim();
  const box = $("res-strkey");
  box.innerHTML = "";
  const ok = StrKey.isValidEd25519PublicKey(g);
  box.appendChild(pill(ok ? "StrKey geçerli" : "StrKey geçersiz", ok ? "pill ok" : "pill bad"));
  if (ok) {
    markAction("btn-trustline", true);
    if (connectedAddress) markAction("btn-trust-open-burn", true);
  }
});

async function runTrustOpen() {
  const f = getFreighter();
  if (!f || !connectedAddress) {
    acctLog("Önce Freighter ile bağlan.");
    return;
  }
  acctLog("Freighter imzası bekleniyor (USDC trustline)…");
  try {
    const r = await openUsdcTrustline(f);
    if (r.ok && r.hash) {
      acctLog("Trustline açıldı — Freighter ve Expert’te görünür.", r.hash);
      await refreshBalances(connectedAddress);
    } else {
      acctLog(`Trustline reddedildi: ${JSON.stringify(r).slice(0, 180)}`);
    }
  } catch (e) {
    acctLog(`Trustline hatası: ${e.message || e}`);
  }
}

$("btn-fund")?.addEventListener("click", async () => {
  if (!connectedAddress) {
    acctLog("Once Freighter ile baglan: Friendbot, bagli hesabin adresini fonlar.");
    return;
  }
  acctLog("Friendbot çağrılıyor…");
  const r = await friendbot(connectedAddress);
  if (r.ok) {
    acctLog("Friendbot XLM gönderdi (testnet).", r.hash);
    await refreshBalances(connectedAddress);
  } else {
    acctLog(`Friendbot: ${r.status} — hesap zaten dolu olabilir.`);
    await refreshBalances(connectedAddress);
  }
});
$("btn-trust-open")?.addEventListener("click", () => runTrustOpen());
$("btn-trust-open-burn")?.addEventListener("click", () => runTrustOpen());
$("btn-stamp")?.addEventListener("click", async () => {
  const f = getFreighter();
  if (!f || !connectedAddress) {
    acctLog("Once Freighter ile baglan: damga, bagli adrese basilan imzali bir islemdir.");
    return;
  }
  acctLog("TESTNET damgası — Freighter imzası bekleniyor (CCTP Pasaportu değil).");
  try {
    // stamp(owner: Address) — the receipt says "caller mints to self via
    // stamp(owner)". Called without the owner argument the VM refuses with
    // MismatchingParameterLen before anything happens on chain, so the owner
    // IS the call: the connected address, require_auth'd by the contract.
    const r = await sendWithFreighter(f, CONFIG.stamp, "stamp", [
      { scVal: addrScVal(connectedAddress) },
    ]);
    if (r.ok) acctLog(`Damga ${r.status}`, r.hash);
    else acctLog(`Damga: ${String(r.error || r.status).slice(0, 220)}`, r.hash);
  } catch (e) {
    acctLog(`Damga hatası: ${e.message || e}`);
  }
});
$("btn-bump")?.addEventListener("click", async () => {
  const f = getFreighter();
  if (!f || !connectedAddress) {
    acctLog("Once Freighter ile baglan: bump, TTL'i uzatan imzali bir islemdir.");
    return;
  }
  acctLog("bump imzası bekleniyor…");
  try {
    const r = await sendWithFreighter(f, CONFIG.gateClaimCanonical, "bump", [
      { scVal: addrScVal(connectedAddress) },
    ]);
    if (r.ok) {
      acctLog(`bump ${r.status}`, r.hash);
    } else {
      acctLog(`bump: ${String(r.error || r.status).slice(0, 220)}`, r.hash);
    }
  } catch (e) {
    acctLog(`bump hatası: ${e.message || e}`);
  }
});

$("btn-trustline").addEventListener("click", async () => {
  const g = $("in-strkey").value.trim();
  const box = $("res-trustline");
  if (!StrKey.isValidEd25519PublicKey(g)) {
    box.textContent = "Üstteki alana geçerli bir G… adresi gir: kontrol, Horizon'a tek bir gerçek istek yapar.";
    return;
  }
  box.textContent = "Horizon’a soruluyor…";
  try {
    const r = await hasUsdcTrustline(g);
    box.innerHTML = "";
    if (!r.exists) {
      box.appendChild(pill("hesap zincirde yok — trustline da yok, burn butonu kapalı kalırdı", "pill warn"));
      return;
    }
    box.appendChild(pill(r.trusted ? "USDC trustline VAR" : "USDC trustline YOK — burn butonu kapalı kalırdı", r.trusted ? "pill ok" : "pill bad"));
    const t = el("table");
    for (const b of r.balances || []) {
      const tr = el("tr");
      const name = b.asset_type === "native" ? "XLM (native)" : `${b.asset_code}:${(b.asset_issuer || "").slice(0, 8)}…`;
      tr.appendChild(el("th", null, name));
      tr.appendChild(el("td", null, Number(b.balance).toFixed(7)));
      t.appendChild(tr);
    }
    box.appendChild(t);
  } catch (e) {
    box.textContent = `Hata: ${e.message || e}`;
  }
});

// BURN word gate: the word must be typed AND a router must exist before the
// action becomes available. There is no router yet, so it never opens — by
// design. The control still answers when pressed: the reason is the answer.
$("in-burnword").addEventListener("input", (ev) => {
  const typed = ev.target.value.trim().toUpperCase() === "BURN";
  markAction("btn-burn", typed && Boolean(CONFIG.burnRouter));
});
$("btn-burn").addEventListener("click", () => {
  if (!CONFIG.burnRouter) {
    $("res-burn").textContent =
      "Yakma yapılmadı: BurnRouter Sepolia'de kurulu degil (F2, Sepolia testnet fonu bekleniyor). " +
      "Bu dugme sahte bir yakma islemi yapmaz; router kurulup makbuza yazildiginda kelime kapisi ve gercek burn akisi burada acilir.";
    return;
  }
  $("res-burn").textContent =
    "Router makbuzda kayitli ama burn akisi (F2) henuz baglanmadi; bu tik bir islem gondermedi.";
});

// ---------- lattice (same wall as Gate 1.0; pointer frame only on visible cubes)
const TILE_PX = 60;
const FRAME_PX = 4;
const LATTICE_BLOCKERS = [
  "header.top",
  "footer",
  "nav.foot-nav",
  ".testnet-band",
  ".boundary",
  ".band",
  ".card",
  ".hero-banner",
  ".track-box",
  ".row-strip",
  ".trust-grid",
];

function sizeLattice() {
  const dpr = window.devicePixelRatio || 1;
  const root = document.documentElement;
  const cell = TILE_PX / dpr;
  root.style.setProperty("--cell", `${cell}px`);
  root.style.setProperty("--pitch", `${cell}px`);
  root.style.setProperty("--ring", `${FRAME_PX / dpr}px`);
  return cell;
}

function buildLattice() {
  const wall = $("cubeLattice");
  if (!wall) return;
  const pitch = sizeLattice();
  const cols = Math.max(1, Math.ceil(window.innerWidth / pitch));
  const rows = Math.max(1, Math.ceil(window.innerHeight / pitch));
  const wanted = Math.min(cols * rows, 6000);
  if (buildLattice.wanted === wanted) return;
  buildLattice.wanted = wanted;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < wanted; i += 1) {
    const cube = document.createElement("div");
    cube.className = "cube";
    frag.append(cube);
  }
  wall.textContent = "";
  wall.append(frag);
}

function cubeUnderPointer(stack) {
  const at = stack.findIndex((node) => node.classList && node.classList.contains("cube"));
  if (at === -1) return null;
  const hidden = stack
    .slice(0, at)
    .some((node) => node.matches && LATTICE_BLOCKERS.some((selector) => node.matches(selector)));
  return hidden ? null : stack[at];
}

function initLatticeFrame() {
  const wall = $("cubeLattice");
  if (!wall || typeof document.elementsFromPoint !== "function") return;
  let framed = null;
  let queued = false;
  let x = 0;
  let y = 0;
  let seen = false;
  const clear = () => {
    if (!framed) return;
    framed.classList.remove("frame");
    framed = null;
  };
  const paint = () => {
    queued = false;
    if (!seen) return;
    const cube = cubeUnderPointer(document.elementsFromPoint(x, y));
    if (cube === framed) return;
    clear();
    if (cube) {
      cube.classList.add("frame");
      framed = cube;
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    x = event.clientX;
    y = event.clientY;
    seen = true;
    schedule();
  }, { passive: true });
  window.addEventListener("pointerleave", clear);
  window.addEventListener("blur", clear);
  window.addEventListener("scroll", () => { if (seen) schedule(); }, { passive: true });
  window.addEventListener("resize", () => { if (seen) schedule(); }, { passive: true });
}

let latticeQueued = false;
function queueLattice() {
  if (latticeQueued) return;
  latticeQueued = true;
  requestAnimationFrame(() => {
    latticeQueued = false;
    buildLattice();
  });
}

function watchSections() {
  const targets = [...document.querySelectorAll("nav.main a[data-nav]")];
  const sections = targets.map((link) => $(link.dataset.nav)).filter(Boolean);
  if (!("IntersectionObserver" in window) || sections.length === 0) return;
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    for (const link of targets) {
      link.setAttribute("aria-current", link.dataset.nav === visible.target.id ? "true" : "false");
    }
  }, { rootMargin: "-84px 0px -60% 0px", threshold: [0.05, 0.25] });
  for (const section of sections) observer.observe(section);
}

window.addEventListener("resize", queueLattice);
buildLattice();
initLatticeFrame();
watchSections();
