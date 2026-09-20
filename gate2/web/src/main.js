import "./style.css";
import { StrKey } from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";
import {
  readContract,
  addrScVal,
  hasUsdcTrustline,
  getFreighter,
  watchFreighter,
  freighterConnect,
  sendWithFreighter,
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

// ---------- tabs ----------
const pages = { proof: $("page-proof"), burn: $("page-burn") };
function showTab(name) {
  $("tab-proof").classList.toggle("active", name === "proof");
  $("tab-burn").classList.toggle("active", name === "burn");
  pages.proof.classList.toggle("hidden", name !== "proof");
  pages.burn.classList.toggle("hidden", name !== "burn");
}
$("tab-proof").addEventListener("click", () => showTab("proof"));
$("tab-burn").addEventListener("click", () => showTab("burn"));

// ---------- static honesty ----------
$("contract-ids").textContent =
  `gate_claim (kanonik/sertlestirilmis): ${CONFIG.gateClaimCanonical} · ` +
  `gate_claim (F3 kulvari, kampanya buna bagli): ${CONFIG.gateClaimPreHardening} · ` +
  `kampanya: ${CONFIG.campaign}`;
$("burn-blocker").textContent = CONFIG.burnRouterBlocker;
$("iris-url").textContent = CONFIG.irisApi;

// ---------- freighter ----------
function setWalletState(text, cls = "muted") {
  const s = $("wallet-state");
  s.textContent = text;
  s.className = cls;
}
function onFreighter(f) {
  if (!f) {
    setWalletState("Freighter bulunamadı (geç yüklenirse tekrar denenecek)", "muted");
    return;
  }
  setWalletState("Freighter hazır — bağlanmak için tıkla", "ok");
  $("btn-connect").addEventListener("click", async () => {
    try {
      const addr = await freighterConnect(f);
      connectedAddress = addr;
      setWalletState(`${addr.slice(0, 8)}…${addr.slice(-6)} bağlı`, "ok");
      $("in-address").value = addr;
      $("in-strkey").value = addr;
      $("btn-tier-send").disabled = false;
      $("btn-trustline").disabled = false;
    } catch (e) {
      setWalletState(`Bağlantı hatası: ${e.message || e}`, "error");
    }
  }, { once: false });
}
watchFreighter(onFreighter);
// The watcher only enables the button when a provider shows up; keep a
// manual fallback so the click always tries the current window state.
$("btn-connect").addEventListener("click", async () => {
  const f = getFreighter();
  if (f) return; // the watcher-bound handler takes care of it
  setWalletState("Bu tarayıcıda Freighter sağlayıcısı yok", "error");
});

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
    renderTier($("res-tier"), "Freighter bağlı değil.", { ok: true, value: null });
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
  if (ok) $("btn-trustline").disabled = false;
});

$("btn-trustline").addEventListener("click", async () => {
  const g = $("in-strkey").value.trim();
  const box = $("res-trustline");
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

// BURN word gate: button stays disabled until the word is typed AND a
// router exists. There is no router yet, so it can never enable — by design.
$("in-burnword").addEventListener("input", (ev) => {
  const typed = ev.target.value.trim().toUpperCase() === "BURN";
  $("btn-burn").disabled = !(typed && CONFIG.burnRouter);
});
$("btn-burn").addEventListener("click", () => {
  if (!CONFIG.burnRouter) {
    $("res-burn").textContent = "Router yok — bu butonun açılması imkânsızdı; bu bir hatadır, lütfen bildir.";
  }
});
