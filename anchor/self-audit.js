#!/usr/bin/env node
/**
 * Lumen Gate self-audit loop.
 *
 * The unit tests prove the contract behaves once, in CI. This proves it keeps
 * behaving, against the live deployed contracts, on a loop -- and writes down
 * what it saw, with timestamps, so a reader does not have to take anyone's
 * word for it.
 *
 * Every round it asks six questions:
 *   1. Is the source chain reachable at all?
 *   2. Does a fresh, honest proof still get ACCEPTED?
 *   3. Is a replay of the exact same evidence still REJECTED?
 *   4. Is a proof with one tampered signature still REJECTED?
 *   5. Has the admin capability actually been given up yet?
 *   6. Does the console still resolve every element it looks up?
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
  try {
    // The recipient and the sender must be valid Stellar strkeys: the gateway
    // carries both in Address-typed arguments, so a placeholder like
    // "audit-probe" would produce a block that gets anchored and can never be
    // minted. The simulator refuses it now, and this probe uses the deployer
    // account so the audit exercises the same shape a real settlement uses.
    const probeAccount = AUDIT_ACCOUNT;
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
  record("source_chain_reachable", true, `simulator produced height ${proof.declared_height}`);

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

  // The console is part of the product surface, so a broken selector is a
  // defect the loop should catch. tools/check-console.js resolves every element
  // the module looks up against the markup.
  try {
    const { execFileSync } = require("node:child_process");
    const output = execFileSync(process.execPath, [path.join(ROOT, "tools", "check-console.js")], {
      encoding: "utf8",
    });
    record("console_wiring_consistent", true, output.trim().split("\n").pop());
  } catch (e) {
    record("console_wiring_consistent", false, String((e.stdout || e.message || e)).trim().split("\n").pop());
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
