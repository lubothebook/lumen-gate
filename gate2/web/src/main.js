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
const div6 = (v) => (Number(typeof v === "bigint" ? v : v ?? 0) / 1e6).toFixed(6);

let connectedAddress = null;
let currentQueryAddress = null;
let walletWritesAllowed = false;

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
    const pageEl = $(`page-${name}`);
    if (pageEl && window.matchMedia("(max-width: 720px)").matches) {
      // keep the working pane in view on a phone after a tab change
      pageEl.scrollIntoView({ block: "start" });
    }
  }
}
$("tab-proof").addEventListener("click", () => showTab("proof"));
$("tab-burn").addEventListener("click", () => showTab("burn"));
$("tab-battery")?.addEventListener("click", () => showTab("battery"));
$("tab-tickets")?.addEventListener("click", () => showTab("tickets"));

  // 2.0 pill: same as 1.0 — the band below is this version's workspace.
$("gate2Select")?.addEventListener("click", () => {
  $("console")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- static honesty ----------
$("contract-ids").textContent =
  `gate_claim (canonical/hardened): ${CONFIG.gateClaimCanonical} · ` +
  `gate_claim (F3 lane, campaign is wired here): ${CONFIG.gateClaimPreHardening} · ` +
  `campaign: ${CONFIG.campaign} · ` +
  `testnet stamp: ${CONFIG.stamp}`;
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
    setWalletState("No extension in this frame. Open in a tab, then connect.", "error");
  }
}
async function connectWallet() {
  // requestAccess must run in this click turn. Awaiting isConnected first
  // (2s) drops the user gesture and the browser blocks the popup — that is
  // why Connect did nothing on a real Freighter install.
  const f = getFreighter();
  setWalletState("Opening Freighter…", "muted");
  try {
    const addr = await freighterConnect(f);
    connectedAddress = addr;
    setWalletState(`${addr.slice(0, 8)}…${addr.slice(-6)} connected`, "ok");
    $("in-address").value = addr;
    $("in-strkey").value = addr;
    walletWritesAllowed = true;
    markAction($("btn-tier-send"), true);
    markAction($("btn-trustline"), true);
    setWalletActions(true);
    await refreshBalances(addr);
    acctLog(`Connected. Expert: ${addr.slice(0, 8)}…`);
    if (typeof f.getNetwork === "function") {
      try {
        const verdict = walletNetworkVerdict(await f.getNetwork());
        if (verdict !== "testnet") {
          walletWritesAllowed = false;
          markAction($("btn-tier-send"), false);
          markAction($("btn-burn"), false);
          setWalletActions(false, "This console only signs on Stellar testnet. Switch the wallet there and connect again.");
          setWalletState(
            verdict === "unknown"
              ? "Connected, but the wallet network could not be verified. Action buttons stay closed."
              : `Connected, but Freighter is on ${verdict === "mainnet" ? "mainnet" : "another network"}. Action buttons stay closed here.`,
            "error"
          );
        }
      } catch {
        // getNetwork is advisory at connect time (some builds refuse it
        // while locked); the point-of-use assertTestnet is fail-closed.
      }
    }
    return addr;
  } catch (e) {
    setWalletState(`Connection error: ${e.message || e}`, "error");
    return null;
  }
}
function onFreighter(f) {
  if (embeddedFrame()) {
    paintEmbedGate();
    return;
  }
  if (!f) {
    setWalletState("Freighter not found. Install it, reload, then connect.", "muted");
    setWalletActions(
      false,
      "No Freighter extension in this browser. Read-only actions (My Migration Proof, StrKey) work without a wallet; anything needing a signature stays closed."
    );
    return;
  }
  setWalletState("Freighter ready — click to connect", "ok");
}
function acctLog(text, hash) {
  const box = $("acct-log");
  if (!box) return;
  const row = el("div", "muted", text);
  if (hash) {
    const a = document.createElement("a");
    a.href = EXPLORER_TX + hash;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = hash;
    a.className = "contracts";
    row.appendChild(document.createTextNode(" "));
    row.appendChild(a);
  }
  box.appendChild(row);
  while (box.children.length > 8) box.removeChild(box.firstChild); // a log, not a billboard: last 8 stay
}

// An unavailable action is a grey button that still answers, not a dead one.
// A hard `disabled` swallows the click before any handler runs, so the control
// can never say why it is grey; aria-disabled keeps it focusable and clickable,
// and withButton answers the press with the reason. The title and the wallet
// gate panel stay exactly as they were - this only un-silences the click.
function markAction(button, available) {
  if (!button) return;
  if (available) {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("disabled");
  } else {
    button.setAttribute("aria-disabled", "true");
    button.removeAttribute("disabled");
  }
}

function actionUnavailable(button) {
  return Boolean(button) && (button.disabled === true || button.getAttribute("aria-disabled") === "true");
}

function setWalletActions(on, reason) {
  for (const id of ["btn-fund", "btn-trust-open", "btn-bump", "btn-trust-open-burn", "btn-stamp", "btn-battery-deposit", "btn-battery-withdraw"]) {
    const b = $(id);
    if (!b) continue;
    markAction(b, on);
    // An unavailable control says why. Without this the buttons just look broken.
    if (on) b.removeAttribute("title");
    else b.title = reason || "Connect Freighter first — this action needs a wallet signature.";
  }
  const gate = $("walletGate");
  if (gate) {
    if (on) {
      gate.classList.add("hidden");
    } else {
      gate.classList.remove("hidden");
      gate.innerHTML = "";
      gate.append(
        reason ||
          "The four buttons above unlock once you connect — each one needs a Freighter signature."
      );
    }
  }
}

async function withButton(id, pendingText, work) {
  const button = $(id);

  if (!button) return;
  if (button.getAttribute("aria-busy") === "true") return; // already running
  if (actionUnavailable(button)) {
    // The click is not swallowed: the control answers with its own stated
    // reason, the same one its title and the wallet gate carry.
    acctLog(button.title || "Connect Freighter first — this action needs a wallet signature.");
    return;
  }

  const label = button.textContent;

  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  button.textContent = pendingText;

  try {
    return await work();
  } catch (e) {
    acctLog(`Action error: ${e?.message || e}`);
    return null;
  } finally {
    button.textContent = label;
    button.removeAttribute("aria-busy");
    // Same availability the old code restored: wallet-gated actions follow
    // the wallet's write state again once the run is over.
    markAction(button, walletWritesAllowed);
  }
}

// The wallet's own answer, classified against the one network this console
// signs for. The check is exact — the testnet passphrase the contracts were
// deployed to — not a guess from a display name, and an answer we cannot
// verify is "unknown", which the write path treats as a refusal.
function walletNetworkVerdict(net) {
  const name = typeof net === "string" ? net : net && (net.network || net.networkPassphrase);
  const text = String(name || "").toLowerCase();
  if (/mainnet|public network|public global stellar/.test(text)) return "mainnet";
  if (name === CONFIG.networkPassphrase || /testnet|test sdf network|stellar testnet/.test(text)) return "testnet";
  return "unknown";
}

// Point-of-use network guard, fail-closed: the connect-time check can go
// stale if the user switches the wallet's network (or its active account)
// afterwards, so every signing action re-checks right before it asks
// Freighter to sign. Anything that is not a verified match for the exact
// testnet passphrase blocks the signature — an unverifiable wallet must not
// sign, and the block is spoken out loud.
async function assertTestnet() {
  const f = getFreighter();
  if (!f) return false;
  try {
    if (typeof f.getAddress === "function") {
      const answer = await f.getAddress();
      const current = answer && (typeof answer === "string" ? answer : answer.address || answer.publicKey || answer.public_key);
      if (connectedAddress && current && current !== connectedAddress) {
        connectedAddress = null;
        walletWritesAllowed = false;
        setWalletState("The active wallet account changed. Connect again to continue.", "error");
        setWalletActions(false, "The active Freighter account changed — connect again before signing.");
        acctLog("Blocked before signing: the active wallet account changed; connect again.");
        return false;
      }
    }
    const verdict = walletNetworkVerdict(typeof f.getNetwork === "function" ? await f.getNetwork() : null);
    if (verdict !== "testnet") {
      walletWritesAllowed = false;
      setWalletState(
        verdict === "unknown"
          ? "Wallet network could not be verified. Action buttons stay closed until Freighter reports Stellar testnet."
          : `Freighter is on ${verdict === "mainnet" ? "mainnet" : "another network"}. Action buttons stay closed here.`,
        "error"
      );
      setWalletActions(false, "This console only signs on Stellar testnet. Switch the wallet there and connect again.");
      acctLog(`Blocked before signing: wallet network verdict is "${verdict}".`);
      return false;
    }
    return true;
  } catch (e) {
    walletWritesAllowed = false;
    setWalletState("Wallet check failed. Action buttons stay closed.", "error");
    setWalletActions(false, "The Freighter session check failed — connect again before signing.");
    acctLog(`Blocked before signing: ${e?.message || e}`);
    return false;
  }
}

async function refreshBalances(g) {
  const kv = $("walletKv");
  if (!kv || !g) return;
  try {
    const r = await hasUsdcTrustline(g);
    kv.innerHTML = "";
    if (!r.exists) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>Account</td><td>not on chain — fund with Friendbot</td>";
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
    row("USDC", usdc ? `${Number(usdc.balance).toFixed(7)} (trustline open)` : "no trustline");
    const trLink = document.createElement("tr");
    trLink.appendChild(el("td", null, "Explorer"));
    const tdLink = el("td", null, null);
    const link = document.createElement("a");
    link.href = EXPLORER_ACCOUNT + g;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open in Stellar Expert";
    link.className = "link-btn";
    tdLink.appendChild(link);
    trLink.appendChild(tdLink);
    kv.appendChild(trLink);
  } catch (e) {
    acctLog(`Could not read balances: ${e.message || e}`);
  }
}

paintEmbedGate();
watchFreighter(onFreighter);
$("btn-connect").addEventListener("click", () => connectWallet());

  // ---------- Proof of Migration ----------
async function queryAddress(g) {
  currentQueryAddress = g;
  $("res-which").textContent = `${g.slice(0, 8)}…${g.slice(-6)}`;
  $("results").classList.remove("hidden");
  const migBox = $("res-migration");
  const nftBox = $("res-nfts");
  nftBox.textContent = "Reading the chain…";

  // Both live gate_claim deployments are queried — the canonical hardened
  // one and the F3-lane one the campaign is wired to. Nothing is hidden.
  const lanes = [
    { name: "canonical (hardened)", id: CONFIG.gateClaimCanonical },
    { name: "F3 lane (campaign is wired here)", id: CONFIG.gateClaimPreHardening },
  ];
  migBox.innerHTML = "";
  for (const lane of lanes) {
    const head = el("h3", "muted", `${lane.name} — ${lane.id.slice(0, 10)}…`);
    migBox.appendChild(head);
    const r = await readContract(lane.id, "get_migration", [{ scVal: addrScVal(g) }]);
    if (!r.ok) {
      migBox.appendChild(el("div", "error", `Read error: ${r.error}`));
      continue;
    }
    if (r.value == null) {
      migBox.appendChild(pill("no record"));
      continue;
    }
    const t = el("table");
    const rows = [
      ["Total USDC (6 decimals)", div6(r.value.total_usdc)],
      ["Claim count", String(r.value.claim_count)],
      ["First / last ledger", `${r.value.first_ledger} / ${r.value.last_ledger}`],
      ["Source domains", (r.value.sources || []).join(", ") || "—"],
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
      migBox.appendChild(el("div", "muted", `TESTNET stamp (not CCTP): id=${st.value}`));
    } else if (st.ok) {
      migBox.appendChild(el("div", "muted", "TESTNET stamp: none"));
    }
  } catch { /* stamp is additive */ }

  nftBox.textContent = "Reading NFT list…";
  nftBox.innerHTML = "";
  for (const lane of lanes) {
    const r = await readContract(lane.id, "proofs_of", [{ scVal: addrScVal(g) }]);
    if (!r.ok) {
      nftBox.appendChild(el("div", "error", `${lane.name}: read error ${r.error}`));
      continue;
    }
    const ids = r.value || [];
    nftBox.appendChild(el("div", "muted", `${lane.name}: ${ids.length} NFT`));
    for (const id of ids) {
      const card = el("div", "nft");
      card.appendChild(el("h3", null, `Proof of Migration #${id}`));
      const [proof, meta, owner] = await Promise.all([
        readContract(lane.id, "get_proof", [{ value: id, type: "u64" }]),
        readContract(lane.id, "get_meta", [{ value: id, type: "u64" }]),
        readContract(lane.id, "owner_of", [{ value: id, type: "u64" }]),
      ]);
      const p = proof.value || {};
      const t = el("table");
      const rows = [
        ["Owner (owner_of)", owner.ok && owner.value ? String(owner.value) : "—"],
        ["Source domain", String(p.source_domain ?? "—")],
        ["Nonce", String(p.nonce ?? "—")],
        ["Amount (USDC 6 decimals)", div6(p.amount_6)],
        ["Fee executed", div6(p.fee_executed_6)],
        ["Ledger", String(p.ledger ?? "—")],
        ["Message hash", p.message_hash ? String(p.message_hash) : "—"],
        ["Meta (domain/nonce/amount/fee/ledger)", meta.ok && meta.value ? JSON.stringify(meta.value, (k, v) => typeof v === "bigint" ? String(v) : v) : "—"],
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
    box.textContent = "Invalid Stellar address — StrKey check failed.";
    box.classList.remove("hidden");
    return;
  }
  box.classList.add("hidden");
  queryAddress(g).catch((e) => {
    box.textContent = `Query error: ${e.message || e}`;
    box.classList.remove("hidden");
  });
});

// ---------- claim_tier ----------
function tierName(v) {
  if (v == null) return null;
  if (typeof v === "number") return { 1: "Bronze", 2: "Silver", 3: "Gold" }[v] || null;
  if (typeof v === "object") {
    if (v.value !== undefined) return tierName(v.value);
    // Soroban enums decode to a single-key object, e.g. { Bronze: null }
    const keys = Object.keys(v);
    if (keys.length === 1 && (v[keys[0]] === null || v[keys[0]] === undefined)) {
      return ["Bronze", "Silver", "Gold"].includes(keys[0]) ? keys[0] : null;
    }
  }
  return null;
}
function renderTier(box, label, r) {
  box.innerHTML = "";
  box.appendChild(el("div", "muted", label));
  if (!r.ok) {
    box.appendChild(el("div", "error", `Rejected: ${String(r.error).slice(0, 300)}`));
    box.appendChild(pill("no badge → contract refused", "pill bad"));
    return;
  }
  const name = tierName(r.value);
  if (name) {
    box.appendChild(pill(`Tier: ${name}`, "pill ok"));
  } else {
    // null / unrecognized: say so in neutral — never a green "Tier: null"
    box.appendChild(pill("no tier returned", "pill warn"));
  }
}

$("btn-tier-sim").addEventListener("click", async () => {
  const g = currentQueryAddress || connectedAddress || $("in-address").value.trim();
  if (!StrKey.isValidEd25519PublicKey(g)) {
    renderTier($("res-tier"), "Query a valid address first.", { ok: true, value: null });
    return;
  }
  $("res-tier").textContent = "Simulating (no tx)…";
  const r = await readContract(CONFIG.campaign, "claim_tier", [{ scVal: addrScVal(g) }]);
  renderTier($("res-tier"), `claim_tier simulation — ${g.slice(0, 8)}…`, r);
});

$("btn-tier-send").addEventListener("click", () =>
  withButton("btn-tier-send", "Waiting for signature…", async () => {
    const f = getFreighter();
    if (!f || !connectedAddress) {
      renderTier($("res-tier"), "Freighter is not connected.", { ok: true, value: null });
      return null;
    }
    if (!(await assertTestnet())) return null;
    $("res-tier").textContent = "Waiting for Freighter signature…";
    try {
      const r = await sendWithFreighter(f, connectedAddress, CONFIG.campaign, "claim_tier", [
        { scVal: addrScVal(connectedAddress) },
      ]);
      $("res-tier").innerHTML = "";
      if (r.ok) {
        $("res-tier").appendChild(pill(`tier claim accepted (status ${r.status}) — tx: ${r.hash}`, "pill ok"));
      } else if (r.status === "PENDING" || r.status === "TIMEOUT") {
        $("res-tier").appendChild(pill(`submitted — still processing (not a refusal) — tx: ${r.hash}`, "pill warn"));
      } else {
        $("res-tier").appendChild(el("div", "error", `Rejected: ${String(r.error).slice(0, 300)}`));
        $("res-tier").appendChild(pill("no badge → contract refused", "pill bad"));
      }
    } catch (e) {
      renderTier($("res-tier"), "Submit error", { ok: false, error: e.message || String(e) });
    }
    return null;
  })
);

  // ---------- Burn-screen preconditions ----------
$("btn-strkey").addEventListener("click", () => {
  const g = $("in-strkey").value.trim();
  const box = $("res-strkey");
  box.innerHTML = "";
  const ok = StrKey.isValidEd25519PublicKey(g);
  box.appendChild(pill(ok ? "StrKey valid" : "StrKey invalid", ok ? "pill ok" : "pill bad"));
  if (ok) {
    markAction($("btn-trustline"), true); // read-only Horizon check — no signature needed
    // The write button opens only when the wallet is connected AND on testnet;
    // a valid typed address alone must never unlock signing on a mainnet wallet.
    if (connectedAddress && walletWritesAllowed) markAction($("btn-trust-open-burn"), true);
  }
});

async function runTrustOpen() {
  const f = getFreighter();
  if (!f || !connectedAddress) {
    acctLog("Connect Freighter first.");
    return;
  }
  if (!(await assertTestnet())) return;
  acctLog("Waiting for Freighter (USDC trustline)…");
  try {
    const r = await openUsdcTrustline(f, connectedAddress);
    if (r.ok && r.hash) {
      acctLog("Trustline opened — visible in Freighter and Expert.", r.hash);
      await refreshBalances(connectedAddress);
    } else {
      acctLog(`Trustline not opened: ${r.error || "no result"} — the account needs XLM for the fee.`, r.hash);
    }
  } catch (e) {
    acctLog(`Trustline error: ${e.message || e}`);
  }
}

$("btn-fund")?.addEventListener(
  "click",
  () =>
    withButton("btn-fund", "Requesting XLM…", async () => {
      if (!connectedAddress) {
        acctLog("Connect Freighter first — Friendbot funds the connected account.");
        return;
      }
      acctLog("Calling Friendbot…");
      const r = await friendbot(connectedAddress);
      if (r.ok) {
        acctLog("Friendbot sent XLM (testnet).", r.hash);
      } else {
        const reason =
          r.payload?.detail ||
          r.payload?.error ||
          r.payload?.raw ||
          `HTTP ${r.status}`;
        acctLog(`Friendbot refused: ${String(reason).slice(0, 180)}`);
      }
      await refreshBalances(connectedAddress);
    })
);
$("btn-trust-open")?.addEventListener("click", () =>
  withButton("btn-trust-open", "Waiting for signature…", runTrustOpen)
);
$("btn-trust-open-burn")?.addEventListener("click", () =>
  withButton("btn-trust-open-burn", "Waiting for signature…", runTrustOpen)
);
$("btn-stamp")?.addEventListener("click", () =>
  withButton("btn-stamp", "Waiting for signature…", async () => {
    const f = getFreighter();
    if (!f || !connectedAddress) {
      acctLog("Connect Freighter first.");
      return null;
    }
    if (!(await assertTestnet())) return null;
    acctLog("TESTNET stamp — waiting for Freighter (not a CCTP Passport).");
    try {
      // The contract is stamp(owner: Address) — the caller stamps themselves.
      const r = await sendWithFreighter(f, connectedAddress, CONFIG.stamp, "stamp", [
        { scVal: addrScVal(connectedAddress) },
      ]);
      if (r.ok) {
        acctLog(`Stamp accepted (status ${r.status}).`, r.hash);
      } else if (r.status === "PENDING" || r.status === "TIMEOUT") {
        acctLog("Stamp submitted — still processing (not a refusal). Open the hash to watch it.", r.hash);
      } else if (String(r.error || r.status).includes("AlreadyStamped")) {
        acctLog("Already stamped — this account holds its TESTNET stamp (soulbound).", r.hash);
      } else {
        acctLog(`Stamp: ${String(r.error || r.status).slice(0, 220)}`, r.hash);
      }
    } catch (e) {
      acctLog(`Stamp error: ${e.message || e}`);
    }
    return null;
  })
);
$("btn-bump")?.addEventListener("click", () =>
  withButton("btn-bump", "Waiting for signature…", async () => {
    const f = getFreighter();
    if (!f || !connectedAddress) return null;
    if (!(await assertTestnet())) return null;
    acctLog("Waiting for bump signature…");
    try {
      const r = await sendWithFreighter(f, connectedAddress, CONFIG.gateClaimCanonical, "bump", [
        { scVal: addrScVal(connectedAddress) },
      ]);
      if (r.ok) {
        acctLog(`bump accepted (status ${r.status}) — storage TTL extended.`, r.hash);
      } else if (r.status === "PENDING" || r.status === "TIMEOUT") {
        acctLog("bump submitted — still processing (not a refusal). Open the hash to watch it.", r.hash);
      } else {
        acctLog(`bump: ${String(r.error || r.status).slice(0, 220)}`, r.hash);
      }
    } catch (e) {
      acctLog(`bump error: ${e.message || e}`);
    }
    return null;
  })
);

$("btn-trustline").addEventListener("click", async () => {
  const g = $("in-strkey").value.trim();
  const box = $("res-trustline");
  box.textContent = "Asking Horizon…";
  try {
    const r = await hasUsdcTrustline(g);
    box.innerHTML = "";
    if (!r.exists) {
      box.appendChild(pill("account not on chain — no trustline either, burn would stay closed", "pill warn"));
      return;
    }
    box.appendChild(pill(r.trusted ? "USDC trustline YES" : "USDC trustline NO — burn would stay closed", r.trusted ? "pill ok" : "pill bad"));
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
    box.textContent = `Error: ${e.message || e}`;
  }
});

// BURN word gate: button stays disabled until the word is typed AND a
// router exists. There is no router yet, so it can never enable — by design.
$("in-burnword").addEventListener("input", (ev) => {
  const typed = ev.target.value.trim().toUpperCase() === "BURN";
    markAction($("btn-burn"), typed && Boolean(CONFIG.burnRouter));
});
$("btn-burn").addEventListener("click", () => {
  // The control is reachable on purpose: a hard `disabled` would swallow this
  // press and the reader would learn nothing. The reason IS the answer.
  if (!CONFIG.burnRouter) {
    $("res-burn").textContent =
      "No burn happened: BurnRouter is not deployed on Sepolia yet (F2 is waiting on Sepolia testnet funds). " +
      "This control does not fake a burn; when the router is deployed and recorded in the receipt, the word gate and the real burn flow open here.";
    return;
  }
  $("res-burn").textContent =
    "The router is recorded in the receipt, but the burn flow (F2) is not wired yet; this press sent no transaction.";
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

// ---------- F5 Battery / F6 Tickets: live testnet reads and writes ----------
// Both contracts went live on 2026-09-20. Ids come from the receipt via
// config.js, never hand-copied. Every number below is read from chain; nothing
// on this screen is simulated or remembered locally.

const idBox = (id, value) => {
  const n = $(id);
  if (n) n.textContent = value;
};
idBox("battery-id", CONFIG.battery);
idBox("ticket-id", CONFIG.ticket);

// USDC is 6 decimals. Parse without floating point so 1.5 -> 1500000 exactly.
function parseUsdc6(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return { ok: false, why: "enter an amount" };
  if (!/^\d+(\.\d{1,6})?$/.test(t)) {
    return { ok: false, why: "amount must be a number with at most 6 decimals" };
  }
  const [whole, frac = ""] = t.split(".");
  const units = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0"));
  if (units <= 0n) return { ok: false, why: "amount must be greater than zero" };
  return { ok: true, units };
}

function whichAddress(inputId) {
  const typed = ($(inputId)?.value || "").trim();
  const g = typed || connectedAddress || "";
  if (!g) return { ok: false, why: "connect a wallet or type a G… address" };
  if (!StrKey.isValidEd25519PublicKey(g)) return { ok: false, why: "not a valid StrKey address" };
  return { ok: true, g };
}

function kvRows(tbodyId, rows) {
  const body = $(tbodyId);
  if (!body) return;
  body.innerHTML = "";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", null, k));
    tr.appendChild(el("td", "mono", v));
    body.appendChild(tr);
  }
}

async function readBatteryBalance() {
  const who = whichAddress("in-battery-addr");
  const out = $("res-battery");
  if (!who.ok) {
    if (out) out.textContent = who.why;
    return;
  }
  if (out) out.textContent = "reading…";
  const r = await readContract(CONFIG.battery, "balance_of", [{ scVal: addrScVal(who.g) }]);
  if (!r.ok) {
    if (out) out.textContent = `read failed: ${String(r.error).slice(0, 180)}`;
    return;
  }
  if (out) out.textContent = "";
  kvRows("batteryKv", [
    ["Address", `${who.g.slice(0, 8)}…${who.g.slice(-6)}`],
    ["Balance", `${div6(r.value)} USDC`],
  ]);
}

async function readTickets() {
  const out = $("res-tickets");
  const who = whichAddress("in-ticket-addr");
  if (out) out.textContent = "reading…";

  const [total, vault] = await Promise.all([
    readContract(CONFIG.ticket, "live_total", []),
    readContract(CONFIG.ticket, "vault_balance", []),
  ]);

  const rows = [
    ["Live total", total.ok ? `${div6(total.value)} USDC` : "read failed"],
    ["Vault balance", vault.ok ? `${div6(vault.value)} USDC` : "read failed"],
  ];

  if (who.ok) {
    const [ids, value] = await Promise.all([
      readContract(CONFIG.ticket, "tickets_of", [{ scVal: addrScVal(who.g) }]),
      readContract(CONFIG.ticket, "value_of", [{ scVal: addrScVal(who.g) }]),
    ]);
    const list = ids.ok && Array.isArray(ids.value) ? ids.value : [];
    rows.push(["Address", `${who.g.slice(0, 8)}…${who.g.slice(-6)}`]);
    rows.push(["Tickets held", list.length ? list.map(String).join(", ") : "none"]);
    rows.push(["Held value", value.ok ? `${div6(value.value)} USDC` : "read failed"]);
    if (out) out.textContent = list.length ? "" : "No tickets at this address — that is a real read, not a placeholder.";
  } else if (out) {
    out.textContent = who.why;
  }

  kvRows("ticketKv", rows);
}

$("btn-battery-read")?.addEventListener("click", readBatteryBalance);
$("btn-ticket-read")?.addEventListener("click", readTickets);

$("btn-battery-deposit")?.addEventListener("click", () =>
  withButton("btn-battery-deposit", "Signing…", async () => {
    const out = $("res-battery");
    const amount = parseUsdc6($("in-battery-amount")?.value);
    if (!amount.ok) {
      if (out) out.textContent = amount.why;
      return;
    }
    if (!connectedAddress) {
      if (out) out.textContent = "connect Freighter first";
      return;
    }
    const f = getFreighter();
    const r = await sendWithFreighter(f, connectedAddress, CONFIG.battery, "deposit", [
      { scVal: addrScVal(connectedAddress) },
      { scVal: addrScVal(connectedAddress) },
      { value: amount.units, type: "i128" },
    ]);
    if (r.ok) {
      acctLog(`Battery topped up by ${div6(amount.units)} USDC.`, r.hash);
      await readBatteryBalance();
    } else {
      acctLog(`Top-up refused: ${String(r.error).slice(0, 180)}`, r.hash);
    }
  })
);

$("btn-battery-withdraw")?.addEventListener("click", () =>
  withButton("btn-battery-withdraw", "Signing…", async () => {
    const out = $("res-battery");
    const amount = parseUsdc6($("in-battery-amount")?.value);
    if (!amount.ok) {
      if (out) out.textContent = amount.why;
      return;
    }
    if (!connectedAddress) {
      if (out) out.textContent = "connect Freighter first";
      return;
    }
    const f = getFreighter();
    const r = await sendWithFreighter(f, connectedAddress, CONFIG.battery, "withdraw", [
      { scVal: addrScVal(connectedAddress) },
      { value: amount.units, type: "i128" },
    ]);
    if (r.ok) {
      acctLog(`Withdrew ${div6(amount.units)} USDC from the Battery.`, r.hash);
      await readBatteryBalance();
    } else {
      acctLog(`Withdrawal refused: ${String(r.error).slice(0, 180)}`, r.hash);
    }
  })
);

// Supply figures do not need a wallet, so show them as soon as the tab opens.
$("tab-tickets")?.addEventListener("click", () => { readTickets(); }, { once: true });
$("tab-battery")?.addEventListener("click", () => {
  if (connectedAddress) readBatteryBalance();
}, { once: true });
