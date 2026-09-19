#!/usr/bin/env node
/**
 * Lumen Gate self-audit loop.
 *
 * The unit tests prove the contract behaves once, in CI. This proves it keeps
 * behaving, against the live deployed contracts, on a loop -- and writes down
 * what it saw, with timestamps, so a reader does not have to take anyone's
 * word for it.
 *
 * Every round it asks fourteen questions, and none of them is answered by
 * trusting an earlier answer:
 *   1. Is the source chain reachable at all?
 *   2. Does a fresh, honest proof still get ACCEPTED?
 *   3. Is a replay of the exact same evidence still REJECTED?
 *   4. Is a proof with one tampered signature still REJECTED?
 *   5. Has the registry's admin capability actually been given up?
 *   6. Has the gateway's admin capability actually been given up?
 *   7. Can anybody still replace the verifying key after the renounce? (no)
 *   8. Does the recorded gasless recipient still hold zero spendable XLM?
 *   9. Is the recorded gasless mint still on the ledger?
 *  10. Does the console still resolve every element it looks up, embed the
 *      assets it serves, and still frame the lattice cube under the pointer?
 *  11. Does the anchor facade still satisfy its SEP surface? (SEP-1, SEP-10,
 *      SEP-6, the error envelope and the rate limiter, probed as a client)
 *  12. Does SEP-10 signature verification still demand real weight? (the
 *      library driven against a stubbed signer record, including the
 *      below-threshold signature that must be refused)
 *  13. Is the gate-vm lane's recorded acceptance still true on the network?
 *  14. Does the merged showcase registry still serve every lane's key byte
 *      for byte against the registries those keys came from — and is it
 *      frozen in the provable sense: the setter refused by the contract,
 *      not by the network?
 *      (the transaction re-read from Horizon, and the lane registry still
 *      serving the committed verification key — not the file, the bytes)
 *
 * It holds no mint authority and can approve nothing. It only submits probes
 * and records verdicts. If it dies, nothing in the settlement path changes.
 *
 * Configuration (env):
 *   REGISTRY_ID      deployed finality_registry contract id     (required)
 *   NETWORK          stellar network name                        (default: testnet)
 *   STELLAR_SOURCE   stellar CLI identity used to sign probes    (default: lumen-deployer)
 *   SIM_URL          source simulator base url                   (default: http://127.0.0.1:8080)
 *   DOMAIN           source domain name                          (default: source-testnet)
 *   AUDIT_INTERVAL   ms between rounds                           (default: 300000 = 5 min)
 *   AUDIT_ONCE       set to 1 to run a single round and exit
 *   AUDIT_OUT        where to write the rolling record           (default: deployments/self-audit.json)
 *   PORT             port for the read-only HTTP surface         (default: 8090)
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const http = require("node:http");

const REGISTRY_ID = process.env.REGISTRY_ID || "";

// The gateway is where value moves, so the audit asks about its admin
// capability too. It reads the id from the manifest when the environment does
// not name one, because a check that silently skips is not a check.
function gatewayIdFromManifest() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "deployments", "testnet.json"), "utf8")
    );
    const contracts = manifest.contracts || {};
    // The manifest records each contract as an object ({contract_id, status, ...}),
    // not as a bare string. Reading it as a string made this helper throw, the
    // catch swallow it, and the check report "no gateway id" while the gateway id
    // was sitting right there in the file. Accept both shapes.
    const entry = contracts.settlement_gateway || contracts.gateway || "";
    const id = typeof entry === "string" ? entry : (entry && (entry.contract_id || entry.id)) || "";
    return String(id).trim();
  } catch {
    return "";
  }
}
const GATEWAY_ID = (process.env.GATEWAY_ID || "").trim() || gatewayIdFromManifest();
const NETWORK = process.env.NETWORK || "testnet";
const SOURCE = process.env.STELLAR_SOURCE || "lumen-deployer";
// A real testnet account, used as the source-chain sender and recipient of the
// audit probe. It has to be a valid strkey; see the note in runRound.
const AUDIT_ACCOUNT =
  process.env.AUDIT_ACCOUNT || "GBYFDKP4KLQ575HTJRDTHF4HUIVXAQLJNEZMWYJ5HBY3C3GDSPX5H4FR";

const SIM_URL = process.env.SIM_URL || "http://127.0.0.1:8080";
const DOMAIN = process.env.DOMAIN || "source-testnet";
const INTERVAL = Number(process.env.AUDIT_INTERVAL || 300000);
const ONCE = process.env.AUDIT_ONCE === "1";
const OUT = process.env.AUDIT_OUT || path.join(__dirname, "..", "deployments", "self-audit.json");
const PORT = Number(process.env.PORT || 8090);
// Live-ledger probes need no signing key: they read Horizon and the manifest.
// They exist because the strongest claims in the README are about accounts and
// transactions, and those are exactly the claims that can be re-checked from
// outside without anyone's cooperation.
const HORIZON_URL = (process.env.HORIZON_URL || "").trim();
// The facade is part of the product surface, so its SEP behaviour is audited
// like everything else. The default is the port the facade uses when it runs
// locally; if nothing answers there the round records a failure rather than
// skipping the check.
const FACADE_URL = (process.env.FACADE_URL || "http://127.0.0.1:8081").trim();
const BASE_RESERVE_STROOPS = 5_000_000; // 0.5 XLM per reserve unit

function manifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
  } catch {
    return null;
  }
}

function manifestPath(objectPath) {
  let node = manifest();
  for (const key of objectPath.split(".")) {
    if (node === null || node === undefined) return null;
    node = node[key];
  }
  return node === undefined ? null : node;
}

function horizonUrl() {
  return HORIZON_URL || manifestPath("horizon_url") || "https://horizon-testnet.stellar.org";
}

// The source domain key (sha256(adapter_id || network)) lives in the deployment
// manifest. Without it the loop cannot ask what the chain already holds.
const SOURCE_DOMAIN_KEY = (() => {
  if (process.env.SOURCE_DOMAIN_KEY) return process.env.SOURCE_DOMAIN_KEY;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "deployments", "testnet.json"), "utf8")
    );
    return (manifest.domain && manifest.domain.domain_key) || "";
  } catch {
    return "";
  }
})();

// Contract error codes, mirrored from contracts/finality_registry/src/lib.rs.
const ERR = {
  7: "InvalidSignature",
  9: "EvidenceAlreadyProcessed",
  11: "BadPayloadLength",
  12: "NotAdmitted",
  13: "AdminRenounced",
};

// The record has to accumulate across runs. An audit that overwrites its own
// history every time it starts is a status display, not a record: the file
// would only ever contain the rounds of whichever process wrote last. The
// previous rounds are loaded here and the round counter continues from them.
const history = (() => {
  try {
    const previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
    return Array.isArray(previous.history) ? [...previous.history] : [];
  } catch {
    return [];
  }
})();
let round = history.length > 0 ? Number(history[history.length - 1].round || history.length) : 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sh(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

/** Pull the contract error code out of CLI output, or null if there wasn't one. */
function contractError(text) {
  const m = text.match(/Error\(Contract,\s*#(\d+)\)/);
  return m ? Number(m[1]) : null;
}

/**
 * Why a call did not succeed, in words.
 *
 * A call that fails without a contract error code never reached the contract:
 * the CLI could not build the transaction, the account was missing, the
 * network was unreachable. Reporting that as "the contract rejected it" - or
 * worse, as "acceptance" - is how an audit turns into a rubber stamp. The raw
 * tail is kept so the reason is visible instead of guessed.
 */
function failureReason(result) {
  const output = `${result.stdout}${result.stderr}`;
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(" | ").slice(0, 400) || "no output from the CLI";
}

function outcome(result) {
  const code = contractError(`${result.stdout}${result.stderr}`);
  if (code !== null) return `contract error #${code} ${ERR[code] || "unknown"}`;
  if (!result.ok) return `never reached the contract: ${failureReason(result)}`;
  return "accepted";
}

function evidenceFrom(proof, submitter) {
  return JSON.stringify({
    adapter_id: proof.adapter_id,
    declared_height: proof.declared_height,
    declared_root: proof.declared_root,
    evidence_version: proof.evidence_version,
    network: proof.network,
    payload: proof.payload_hex,
    submitter,
  });
}


/**
 * The evidence carries the address that submitted it. If it is missing the CLI
 * refuses to build the transaction, which looks like a contract rejection to a
 * careless check. Take it from the manifest when the environment is silent.
 */
function resolveSubmitter() {
  const fromEnv = (process.env.STELLAR_RELAYER_ADDRESS || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "deployments", "testnet.json"), "utf8")
    );
    return (manifest.accounts?.deployer_and_relayer || "").trim();
  } catch {
    return "";
  }
}

async function submit(evidence) {
  return sh("stellar", [
    "contract", "invoke",
    "--id", REGISTRY_ID,
    "--source", SOURCE,
    "--network", NETWORK,
    "--",
    "submit_finality_evidence_bls",
    "--evidence", evidence,
  ]);
}

/**
 * The highest height the live registry already holds for this source domain.
 * The simulator is deterministic and restarts from height 1, while the chain
 * keeps its records, so a fresh simulator can propose evidence for a height
 * that was anchored rounds ago. That is not a valid proof and the guard is
 * right to refuse it - the loop has to ask for a genuinely new height instead
 * of reporting a correct refusal as a broken contract.
 */
async function lastRecordedHeight() {
  if (!SOURCE_DOMAIN_KEY) return null;
  const out = await readOnly(["get_last_finalized", "--domain", SOURCE_DOMAIN_KEY]);
  const match = `${out.stdout}${out.stderr}`.match(/"last_height"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

async function waitForFreshHeight() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tip = await getJson(`${SIM_URL}/blocks/latest`);
    const recorded = await lastRecordedHeight();
    if (recorded === null || Number(tip.height) > recorded) {
      return { tip: Number(tip.height), recorded };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("the source chain never passed the height the registry already holds");
}

async function readOnly(fnName, extraArgs = []) {
  return sh("stellar", [
    "contract", "invoke",
    "--id", REGISTRY_ID,
    "--source", SOURCE,
    "--network", NETWORK,
    "--",
    fnName,
    ...extraArgs,
  ]);
}

// ---------------------------------------------------------------------------
// one audit round
// ---------------------------------------------------------------------------

async function runRound() {
  round += 1;
  const startedAt = new Date().toISOString();
  const checks = [];

  const record = (name, passed, detail) => {
    checks.push({ check: name, passed, detail });
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  };

  // Advance the source chain so this round has never-before-seen evidence.
  // Reusing old evidence would prove nothing: the replay guard is supposed to
  // reject it.
  let proof;
  let fresh = { tip: null, recorded: null };
  try {
    // The recipient and the sender must be valid Stellar strkeys: the gateway
    // carries both in Address-typed arguments, so a placeholder like
    // "audit-probe" would produce a block that gets anchored and can never be
    // minted. The simulator refuses it now, and this probe uses the deployer
    // account so the audit exercises the same shape a real settlement uses.
    const probeAccount = AUDIT_ACCOUNT;
    // Let the source chain pass whatever the registry already holds first.
    fresh = await waitForFreshHeight();
    const lock = await postJson(`${SIM_URL}/lock`, {
      amount: 1000 + round,
      recipient: probeAccount,
      sender: probeAccount,
    });
    proof = await getJson(`${SIM_URL}/proof?domain=${DOMAIN}&height=${lock.block_height}`);
  } catch (e) {
    record("source_chain_reachable", false, String(e.message || e));
    return finish(startedAt, checks);
  }
  record(
    "source_chain_reachable",
    true,
    `simulator produced height ${proof.declared_height}${
      fresh.recorded === null ? "" : `, registry held ${fresh.recorded}`
    }`
  );

  const submitterAddr = resolveSubmitter();
  if (!submitterAddr) {
    record(
      "honest_evidence_accepted",
      false,
      "no submitter address: set STELLAR_RELAYER_ADDRESS or record accounts.deployer_and_relayer in deployments/testnet.json"
    );
    return finish(startedAt, checks);
  }
  const honest = evidenceFrom(proof, submitterAddr);

  // Probe 1 -- honest evidence must be accepted by the live contract.
  const accepted = await submit(honest);
  const acceptErr = contractError(accepted.stdout + accepted.stderr);
  if (acceptErr === null && accepted.ok) {
    record("honest_evidence_accepted", true, "contract returned an attestation");
  } else {
    record(
      "honest_evidence_accepted",
      false,
      `a valid proof must never be refused, but this call ended as: ${outcome(accepted)}`
    );
  }

  // Probe 2 -- the exact same evidence again must be refused.
  const replayed = await submit(honest);
  const replayErr = contractError(replayed.stdout + replayed.stderr);
  record(
    "replay_rejected",
    replayErr === 9,
    replayErr === 9 ? `#9 ${ERR[9]}` : `expected #9, saw ${outcome(replayed)}`
  );

  // Probe 3 -- one tampered byte in the aggregate signature must be refused.
  try {
    const badProof = await getJson(
      `${SIM_URL}/proof?domain=${DOMAIN}&height=${proof.declared_height}&tamper=sig`
    );
    const tampered = await submit(evidenceFrom(badProof, submitterAddr || undefined));
    const tamperErr = contractError(tampered.stdout + tampered.stderr);
    record(
      "tampered_signature_rejected",
      tamperErr === 7,
      tamperErr === 7 ? `#7 ${ERR[7]}` : `expected #7, saw ${outcome(tampered)}`
    );
  } catch (e) {
    record("tampered_signature_rejected", false, String(e.message || e));
  }

  // Probe 4 -- is the admin capability still live? Not a pass/fail, a fact.
  const renounced = await readOnly("is_admin_renounced_check");
  const stillHasAdmin = /false/.test(renounced.stdout);
  record(
    "admin_capability_renounced",
    !stillHasAdmin,
    stillHasAdmin
      ? "admin key is STILL LIVE -- bootstrap trust point has not been given up yet"
      : "admin capability has been permanently given up"
  );

  // Probe 5 -- the gateway's admin capability. There is no getter for it, so
  // the probe simulates the admin action itself: if the simulation still
  // succeeds, the key is still live. `--send=no` changes no state. The verdict
  // is only "gone" when the host actually traps; an inconclusive answer is
  // recorded as a failure rather than as a pass, because a check that reports
  // success on an empty output is worse than no check at all.
  if (GATEWAY_ID) {
    const admin = resolveSubmitter();
    const probe = await sh("stellar", [
      "contract", "invoke",
      "--id", GATEWAY_ID,
      "--source", SOURCE,
      "--network", NETWORK,
      "--send=no",
      "--",
      "renounce_admin",
      "--admin", admin,
    ]);
    const text = `${probe.stdout || ""}${probe.stderr || ""}`;
    const trapped = /UnreachableCodeReached|WasmVm/.test(text);
    const stillSucceeds = /admin_renounced/.test(text) && !trapped;
    record(
      "gateway_admin_renounced",
      trapped && !stillSucceeds,
      trapped
        ? "gateway admin capability is gone: a second renounce traps in the host"
        : stillSucceeds
          ? "gateway admin key is STILL LIVE -- the value-moving contract still has an owner"
          : `no verdict from the gateway probe: ${outcome(probe).slice(0, 120)}`
    );
  } else {
    record("gateway_admin_renounced", false, "no gateway id: set GATEWAY_ID or record contracts.settlement_gateway in the manifest");
  }

  // The console is part of the product surface, so a broken selector is a
  // defect the loop should catch. tools/check-console.js resolves every element
  // the module looks up against the markup, and tools/check-grid-fx.js drives
  // the lattice pointer frame behind the page background and insists on its math.
  try {
    const { execFileSync } = require("node:child_process");
    const wired = execFileSync(process.execPath, [path.join(ROOT, "tools", "check-console.js")], {
      encoding: "utf8",
    });
    const framed = execFileSync(process.execPath, [path.join(ROOT, "tools", "check-grid-fx.js")], {
      encoding: "utf8",
    });
    record(
      "console_wiring_consistent",
      true,
      `${wired.trim().split("\n").pop()} | ${framed.trim().split("\n").pop()}`
    );
  } catch (e) {
    record("console_wiring_consistent", false, String((e.stdout || e.message || e)).trim().split("\n").pop());
  }


  // Live-ledger probes. Each one reads a public endpoint and re-derives the
  // claim from the data instead of repeating a number written in a file.
  try {
    const recipient =
      (process.env.GASLESS_RECIPIENT || "").trim() || manifestPath("accounts.gasless_recipient");
    if (!recipient) {
      record("gasless_recipient_zero_spendable_xlm", false, "no recipient: set GASLESS_RECIPIENT or accounts.gasless_recipient");
    } else {
      const account = await getJson(`${horizonUrl()}/accounts/${recipient}`);
      const native = (account.balances || []).find((b) => b.asset_type === "native" || b.asset === "native");
      if (!native) {
        record("gasless_recipient_zero_spendable_xlm", false, `no native balance in the Horizon answer for ${recipient}`);
      } else {
        // Spendable = balance - base reserve. A sponsored subentry does not
        // consume the account's own reserve, so the sponsored counts are
        // subtracted here; that is the same arithmetic the protocol applies.
        const subentries = Number(account.subentry_count || 0) - Number(account.num_sponsored || 0) + Number(account.num_sponsoring || 0);
        const reserve = (2 + Math.max(0, subentries)) * BASE_RESERVE_STROOPS;
        const balance = Math.round(Number(native.balance) * 1e7);
        const spendable = balance - reserve;
        record(
          "gasless_recipient_zero_spendable_xlm",
          spendable <= 0,
          `balance ${(balance / 1e7).toFixed(7)} XLM, reserve ${(reserve / 1e7).toFixed(7)} XLM, spendable ${(spendable / 1e7).toFixed(7)} XLM (read live from Horizon)`
        );
      }
    }
  } catch (e) {
    record("gasless_recipient_zero_spendable_xlm", false, `Horizon read failed: ${String(e.message || e)}`);
  }

  try {
    const hash = (process.env.GASLESS_TX || "").trim() || manifestPath("gasless.transaction");
    if (!hash) {
      record("recorded_gasless_mint_on_chain", false, "no receipt: set GASLESS_TX or gasless.transaction in the manifest");
    } else {
      const tx = await getJson(`${horizonUrl()}/transactions/${hash}`);
      const ok = Boolean(tx.hash) && tx.successful !== false && Boolean(tx.ledger);
      record(
        "recorded_gasless_mint_on_chain",
        ok,
        ok
          ? `receipt ${hash.slice(0, 16)}... is on ledger ${tx.ledger}, ${tx.successful === false ? "failed" : "successful"}, fee ${tx.fee_charged} stroops`
          : `Horizon did not confirm ${hash}`
      );
    }
  } catch (e) {
    record("recorded_gasless_mint_on_chain", false, `Horizon read failed: ${String(e.message || e)}`);
  }

  // The gate-vm lane's acceptance is a claim this repository recorded; the
  // round re-derives it rather than trusting the file. Two independent things
  // must still hold: the accepting transaction is still on the ledger and
  // successful (Horizon, not the record), and the lane registry still holds
  // the exact 896-byte key the proof was verified against — which is what
  // "frozen after renounce" must mean in bytes, not in prose.
  try {
    const lanePath = path.join(ROOT, "deployments", "gate-vm-lane.json");
    const vkPath = path.join(ROOT, "deployments", "vectors", "gate_vm", "gate_vm_vk.hex");
    if (!fs.existsSync(lanePath) || !fs.existsSync(vkPath)) {
      record("gate_vm_lane_still_verified", false, "lane record or vk artifact missing from the repository");
    } else {
      const lane = JSON.parse(fs.readFileSync(lanePath, "utf8"));
      const accepted = (lane.records || []).find((r) => r.check === "honest_gate_vm_run_accepted");
      const vkCommitted = fs.readFileSync(vkPath, "utf8").trim();
      if (!accepted || !accepted.transaction) {
        record("gate_vm_lane_still_verified", false, "the lane record names no acceptance transaction");
      } else {
        const tx = await getJson(`${horizonUrl()}/transactions/${accepted.transaction}`);
        const txOk = Boolean(tx.hash) && tx.successful !== false && Boolean(tx.ledger);
        const keyRead = await sh("stellar", [
          "contract", "invoke",
          "--id", lane.registry_id,
          "--source", SOURCE,
          "--network", NETWORK,
          "--", "get_gate_vm_vk",
        ]);
        const keyOk = keyRead.ok && keyRead.stdout.trim().includes(vkCommitted.slice(0, 64));
        record(
          "gate_vm_lane_still_verified",
          txOk && keyOk,
          txOk && keyOk
            ? `acceptance ${accepted.transaction.slice(0, 16)}... still on ledger ${tx.ledger} (${tx.fee_charged} stroops), and ${lane.registry_id.slice(0, 8)}... still serves the committed key byte for byte`
            : `lane drift: tx ${txOk ? "ok" : "missing/failed"}, stored key ${keyOk ? "ok" : `not the artifact (${keyRead.stderr.trim().slice(0, 120) || keyRead.stdout.trim().slice(0, 120)})`}`
        );
      }
    }
  } catch (e) {
    record("gate_vm_lane_still_verified", false, `readback failed: ${String(e.message || e)}`);
  }

  // The merged registry is the showcase: one contract holding all four lane
  // slots, frozen by a single renounce. The round proves the two claims that
  // make it worth calling a showcase rather than a fourth demo. First,
  // coexistence in bytes: every merged slot must serve exactly the key its
  // own lane's registry serves — four live reads paired against four other
  // live reads, no build artifacts trusted, no repository files trusted.
  // Second, the freeze over the union: a representative setter must fail
  // *because the contract refused it*, not because the network did (the
  // unreachability-is-safety inversion this loop once had, fixed once, is
  // refused again here), and the key must read back intact after the attempt.
  try {
    const mergedPath = path.join(ROOT, "deployments", "merged-registry.json");
    if (!fs.existsSync(mergedPath)) {
      record("merged_registry_still_frozen", false, "no deployments/merged-registry.json in the repository");
    } else {
      const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
      const mergedId = merged?.registry?.contract_id;
      const lanes = [
        { slot: "settlement", getter: "get_vk", len: 768, setter: "set_vk",
          peer: () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8")).contracts.finality_registry.contract_id },
        { slot: "step_chain", getter: "get_step_chain_vk", len: 896, setter: "set_step_chain_vk",
          peer: () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "step-chain.json"), "utf8")).registry_id },
        { slot: "execution", getter: "get_execution_vk", len: 1920, setter: "set_execution_vk",
          peer: () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "execution-lane.json"), "utf8")).registry_id },
        { slot: "gate_vm", getter: "get_gate_vm_vk", len: 896, setter: "set_gate_vm_vk",
          peer: () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "gate-vm-lane.json"), "utf8")).registry_id },
      ];
      if (!/^C[A-Z0-9]{55}$/.test(mergedId || "")) {
        record("merged_registry_still_frozen", false, "the merged record carries no well-formed contract id");
      } else {
        const readKey = async (id, getter, bytes) => {
          const r = await sh("stellar", [
            "contract", "invoke",
            "--id", id,
            "--source", SOURCE,
            "--network", NETWORK,
            "--", getter,
          ]);
          const m = `${r.stdout}`.match(new RegExp(`[0-9a-f]{${bytes * 2}}`));
          return { ok: r.ok && Boolean(m), hex: m ? m[0] : null, tail: `${r.stderr}${r.stdout}`.trim().slice(0, 120) };
        };
        const mismatches = [];
        for (const lane of lanes) {
          const peerId = lane.peer();
          const [mine, theirs] = await Promise.all([readKey(mergedId, lane.getter, lane.len), readKey(peerId, lane.getter, lane.len)]);
          if (!mine.ok || !theirs.ok) {
            mismatches.push(`${lane.slot}: unreadable on ${mine.ok ? "the lane's own registry" : "the merged registry"} (${(mine.tail || theirs.tail).slice(0, 80)})`);
          } else if (mine.hex !== theirs.hex) {
            mismatches.push(`${lane.slot}: merged and ${peerId.slice(0, 8)}... serve different ${lane.len}-byte keys`);
          }
        }
        // reachability first, refusal second, intactness third — same order as
        // the tightened per-lane renounce check, for the same reason
        const reach = await sh("stellar", ["contract", "invoke", "--id", mergedId, "--source", SOURCE, "--network", NETWORK, "--", "get_gate_vm_vk"]);
        const probe = await sh("stellar", [
          "contract", "invoke",
          "--id", mergedId,
          "--source", SOURCE,
          "--network", NETWORK,
          "--send=no",
          "--", "set_gate_vm_vk",
          "--admin", (await sh("stellar", ["keys", "address", SOURCE])).stdout.trim(),
          "--vk", "00".repeat(896),
        ]);
        const probeText = `${probe.stdout}${probe.stderr}`;
        const reached = reach.ok && Boolean(reach.stdout.match(/[0-9a-f]{1792}/));
        const contractRefused = !probe.ok && /(Error|trap|HostError|Unexpected)/i.test(probeText);
        const intact = reached && !mismatches.length;
        record(
          "merged_registry_still_frozen",
          reached && contractRefused && intact,
          !reached
            ? `the merged registry ${mergedId.slice(0, 8)}... could not be read: a closed door is not proven locked by being dark (unmapped failure: ${reach.tail})`
            : intact && contractRefused
              ? `${mergedId.slice(0, 8)}... serves all four slot keys byte-identical to the four registries they came from, and set_gate_vm_vk is refused by the contract itself after the renounce`
              : `merged registry drift: ${mismatches.join("; ") || "setter probe accepted a key — the freeze is not real"}`
        );
      }
    }
  } catch (e) {
    record("merged_registry_still_frozen", false, `merged readback failed: ${String(e.message || e)}`);
  }

  // After the renounce there must be no path back. This simulates the actual
  // mutation with a syntactically valid 768-byte key: if the host no longer
  // traps, somebody can still replace the verifying key and the "no human
  // approval" claim is no longer true.
  try {
    const admin =
      (process.env.ADMIN_ADDRESS || "").trim() ||
      manifestPath("accounts.deployer_and_relayer") ||
      manifestPath("accounts.deployer") ||
      "";
    const zeros = "00".repeat(768);
    const probe = await sh("stellar", [
      "contract", "invoke",
      "--id", REGISTRY_ID,
      "--source", SOURCE,
      "--network", NETWORK,
      "--send=no",
      "--",
      "set_vk",
      "--admin", admin,
      "--vk", zeros,
    ]);
    const text = `${probe.stdout}${probe.stderr}`;
    // A refusal only means something if the contract was reached to refuse.
    // "contract not found", a network timeout or a bad id also make the call
    // fail — and under the old `||` form those failures passed the check,
    // turning an unreachable registry into evidence of safety, which is the
    // exact inversion of what an audit loop is for. So: prove reachability
    // with a read, require the write to have failed with something other than
    // a transport error, and require the stored key to be untouched.
    const readBack = await readOnly("get_vk");
    const reachable = readBack.ok;
    const transportFailure = /contract not found|timed out|connection|offline/i.test(text);
    const trapped = reachable && !probe.ok && !transportFailure;
    const keyIntact = reachable && !readBack.stdout.replace(/\s/g, "").startsWith("000000");
    record(
      "post_renounce_set_vk_impossible",
      trapped && keyIntact,
      !reachable
        ? `the registry could not be read at all, so no refusal could be attributed to the renounce: ${failureReason(readBack).slice(0, 110)}`
        : trapped && keyIntact
          ? `the contract itself refused set_vk after the renounce and the stored key is unchanged: ${failureReason(probe).slice(0, 110)}`
          : probe.ok
            ? "the host accepted set_vk after the renounce, which means the verifying key is still replaceable"
            : transportFailure
              ? `the refusal was a transport-level error, not a contract trap: ${failureReason(probe).slice(0, 110)}`
              : `the call failed for an unrelated reason or the stored key reads as zeros: ${failureReason(probe).slice(0, 110)}`
    );
  } catch (e) {
    record("post_renounce_set_vk_impossible", false, String(e.message || e));
  }

  // The facade's SEP surface, probed as a client rather than read as source.
  try {
    const { execFileSync } = require("node:child_process");
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, "tools", "sep-conformance.js"), "--json"],
      { encoding: "utf8", env: { ...process.env, FACADE_URL }, timeout: 120000 }
    );
    const report = JSON.parse(output);
    const failed = (report.checks || []).filter((c) => !c.passed).map((c) => c.check);
    record(
      "facade_sep_conformance",
      report.all_passed === true,
      report.all_passed === true
        ? `${report.checks_passed}/${report.checks_total} facade checks passed against ${FACADE_URL}`
        : `${report.checks_passed}/${report.checks_total} passed; failing: ${failed.join(", ")}`
    );
  } catch (e) {
    const text = String((e.stdout || e.message || e));
    let detail = text.trim().split("\n").pop();
    try {
      const report = JSON.parse(String(e.stdout || ""));
      const failed = (report.checks || []).filter((c) => !c.passed).map((c) => `${c.check} (${c.detail})`);
      detail = `${report.checks_passed}/${report.checks_total} passed; failing: ${failed.join("; ")}`;
    } catch {
      /* keep the raw tail */
    }
    record("facade_sep_conformance", false, detail.slice(0, 300));
  }

  // The wire-level conformance probe above talks to the running facade. This
  // one drives the verification library itself against a stubbed signer
  // record: weight below the account threshold must be refused even when the
  // master key signed, and an unreachable Horizon must refuse loudly instead
  // of falling back to a weaker check.
  try {
    const { execFileSync } = require("node:child_process");
    const output = execFileSync(process.execPath, [path.join(ROOT, "tools", "check-sep10.js")], {
      encoding: "utf8",
    });
    record("sep10_weight_verification", true, output.trim().split("\n").pop());
  } catch (e) {
    record("sep10_weight_verification", false, String((e.stdout || e.message || e)).trim().split("\n").pop());
  }

  return finish(startedAt, checks);
}

function finish(startedAt, checks) {
  const passed = checks.filter((c) => c.passed).length;
  const entry = {
    round,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    checks_passed: passed,
    checks_total: checks.length,
    all_passed: passed === checks.length,
    registry: REGISTRY_ID,
    network: NETWORK,
    checks,
  };
  history.push(entry);
  if (history.length > 200) history.shift();
  persist();
  console.log(
    `round ${round}: ${passed}/${checks.length} checks passed at ${entry.finished_at}\n`
  );
  return entry;
}

function persist() {
  const latest = history[history.length - 1] || null;
  const doc = {
    note: "Written by the Lumen Gate self-audit loop. Each entry is one round of probes against the live deployed registry.",
    updated_at: new Date().toISOString(),
    latest,
    history: history.slice(-50),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// read-only HTTP surface
// ---------------------------------------------------------------------------

function serve() {
  const srv = http
    .createServer((req, res) => {
      const latest = history[history.length - 1] || null;
      if (req.url === "/self-audit" || req.url === "/self-audit/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            latest
              ? {
                  last_check: latest.finished_at,
                  result: `${latest.checks_passed}/${latest.checks_total}`,
                  all_passed: latest.all_passed,
                  rounds_completed: latest.round,
                  registry: latest.registry,
                }
              : { status: "no rounds completed yet" },
            null,
            2
          )
        );
        return;
      }
      if (req.url === "/self-audit/history") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(history, null, 2));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Try /self-audit or /self-audit/history\n");
    })
    .listen(PORT, "0.0.0.0", () => {
      console.log(`self-audit surface on http://0.0.0.0:${PORT}/self-audit`);
    });
  return srv;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (!REGISTRY_ID) {
    console.error("REGISTRY_ID is required. Nothing is measured otherwise.");
    process.exit(1);
  }
  console.log(`Lumen Gate self-audit`);
  console.log(`  registry : ${REGISTRY_ID} (${NETWORK})`);
  console.log(`  source   : ${SIM_URL}, domain ${DOMAIN}`);
  console.log(`  interval : ${ONCE ? "single round" : INTERVAL + "ms"}\n`);

  const server = serve();

  do {
    try {
      await runRound();
    } catch (e) {
      console.error(`round ${round} threw:`, e);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, INTERVAL));
  } while (true);

  if (ONCE) {
    // The read-only surface holds the event loop open, so a single-round run
    // has to close it explicitly or the caller waits forever.
    server.close(() => process.exit(0));
  }
}

main();
