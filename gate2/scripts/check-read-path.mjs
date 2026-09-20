#!/usr/bin/env node
/**
 * Read-path guard.
 *
 * A read-only simulation is never submitted to the network, so the account it
 * is built on only has to be well-FORMED - its sequence number is irrelevant.
 * Fetching it with server.getAccount() costs an extra RPC round trip per read
 * AND makes every read on the page depend on one shared account still existing
 * and being funded on testnet. When that single account goes away, dozens of
 * unrelated reads fail at once and the console looks like it lost the network.
 *
 * Writes are the opposite: a transaction that will actually be submitted needs
 * the real, current sequence, so fetching the account is correct there and
 * must stay - via Soroban RPC getAccount() or Horizon loadAccount().
 *
 * This guard encodes that split. It is static, so it runs in CI with no
 * browser, no network and no testnet funds:
 *
 *   1. every function that only simulates must build its account locally
 *   2. every function that builds a submittable tx must call getAccount
 *
 * Both directions are checked, because a guard that only forbids would be
 * satisfied by deleting the write path's getAccount too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL_ACCOUNT = /new\s+(?:StellarSdk\.)?Account\s*\(/;
// Two legitimate ways to fetch a real, current account before signing:
// Soroban RPC's getAccount() and Horizon's loadAccount(). A classic operation
// (changeTrust) goes through Horizon, so accepting only one of them would
// report a correct function as broken.
const FETCH_ACCOUNT = /\.(?:getAccount|loadAccount)\s*\(/;

/** Functions that only ever simulate: they must NOT fetch an account. */
const READ_ONLY = [
  ["gate2/web/src/stellar.js", "readContract"],
  ["frontend/src/soroban.ts", "isFinalized"],
  ["frontend/src/soroban.ts", "getFinalizedFull"],
  ["frontend/src/soroban.ts", "getProfile"],
];

/** Functions that build a submittable tx: they MUST fetch a real account. */
const WRITE_PATH = [
  ["gate2/web/src/stellar.js", "sendWithFreighter"],
  ["gate2/web/src/stellar.js", "openUsdcTrustline"],
  ["frontend/src/soroban.ts", "buildBurnAndRelayTx"],
  ["frontend/src/soroban.ts", "buildFinalizeInboundTx"],
];

/**
 * Slice one function body out of a source file by brace depth. Crude on
 * purpose: no parser dependency, and the shapes here are plain declarations.
 */
function bodyOf(src, fnName) {
  const decl = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`
  );
  const m = decl.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const failures = [];
const checked = [];

for (const [rel, fn] of READ_ONLY) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel}: file missing - the guard cannot vouch for ${fn}`);
    continue;
  }
  const body = bodyOf(fs.readFileSync(file, "utf8"), fn);
  if (body === null) {
    failures.push(`${rel}: function ${fn}() not found (renamed? the guard must be updated with it)`);
    continue;
  }
  if (FETCH_ACCOUNT.test(body)) {
    failures.push(
      `${rel}: ${fn}() calls getAccount(). Read-only simulations must not depend on a funded account existing on chain - build the account locally instead.`
    );
  } else if (!LOCAL_ACCOUNT.test(body)) {
    failures.push(`${rel}: ${fn}() builds no local Account - expected new Account(...)`);
  } else {
    checked.push(`${rel} :: ${fn}() simulates on a locally built account`);
  }
}

for (const [rel, fn] of WRITE_PATH) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel}: file missing - the guard cannot vouch for ${fn}`);
    continue;
  }
  const body = bodyOf(fs.readFileSync(file, "utf8"), fn);
  if (body === null) {
    failures.push(`${rel}: function ${fn}() not found (renamed? the guard must be updated with it)`);
    continue;
  }
  if (!FETCH_ACCOUNT.test(body)) {
    failures.push(
      `${rel}: ${fn}() fetches no account. A transaction that gets submitted needs the real sequence number - use getAccount() (Soroban) or loadAccount() (Horizon).`
    );
  } else {
    checked.push(`${rel} :: ${fn}() fetches the real account before signing`);
  }
}

for (const line of checked) console.log(`  ok   ${line}`);
if (failures.length) {
  console.error(`\nread-path guard: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nread-path guard: clean (${checked.length} checks)`);
