#!/usr/bin/env node
/**
 * POST body guard for /api/cashout.
 *
 * The write actions (token, start) carry a JSON body. Two hosts deliver it
 * two different ways:
 *
 *   - Vercel hands the handler an unread request stream.
 *   - tools/api-dev-server.js reads the body itself and leaves the string on
 *     req.body, because several handlers share that one read.
 *
 * A handler that only knows how to read the stream gets "" on the second host:
 * the stream is already drained. The request then reaches the anchor facade as
 * {} and the facade answers "a signed challenge transaction is required" -
 * which reads like the CALLER failed to sign, not like the body was dropped in
 * transit. That misdirection is why this went unfixed for so long, so the
 * regression is worth a test of its own.
 *
 * This runs against a live api-dev-server + anchor-facade pair and proves the
 * body survives the hop, using a real signed SEP-10 challenge.
 *
 *   API_BASE   default http://127.0.0.1:3001
 *   (a funded testnet secret is generated here; nothing is written to the repo)
 */
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const API = (process.env.API_BASE || "http://127.0.0.1:3001").replace(/\/+$/, "");
const oks = [];
const fails = [];

function check(name, cond, detail = "") {
  (cond ? oks : fails).push(detail ? `${name} — ${detail}` : name);
}

async function post(body) {
  const res = await fetch(`${API}/api/cashout?action=token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* handled by the caller through a null json */
  }
  return { status: res.status, json };
}

const kp = Keypair.random();
const funded = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
check("friendbot funded a fresh test account", funded.ok, `HTTP ${funded.status}`);

const chRes = await fetch(`${API}/api/cashout?action=challenge&account=${kp.publicKey()}`);
const ch = await chRes.json();
check("SEP-10 challenge comes back through the API layer", typeof ch.transaction === "string" && ch.transaction.length > 0);

if (typeof ch.transaction === "string") {
  const tx = TransactionBuilder.fromXDR(ch.transaction, Networks.TESTNET);
  tx.sign(kp);

  // The real assertion: a signed challenge must survive the api -> facade hop.
  // If the body is dropped the facade replies 400 "a signed challenge
  // transaction is required" and this fails.
  const signed = await post(JSON.stringify({ transaction: tx.toXDR() }));
  check(
    "a signed challenge survives the POST body hop and returns a token",
    signed.status === 200 && typeof signed.json?.token === "string" && signed.json.token.length > 100,
    signed.status === 200 ? `JWT length ${signed.json?.token?.length}` : JSON.stringify(signed.json).slice(0, 120)
  );
}

// The forwarding must not become permissive in the process: malformed JSON is
// still the API layer's own refusal, not something the facade has to catch.
const broken = await post("{not json");
check(
  "malformed JSON is refused by the API layer itself",
  broken.status === 400 && /must be JSON/i.test(broken.json?.error?.message || ""),
  broken.json?.error?.message || `HTTP ${broken.status}`
);

// An empty object is well-formed, so it should reach the facade and come back
// with the facade's own words - proving the hop happens rather than being
// short-circuited by a guess.
const empty = await post("{}");
check(
  "an empty body reaches the facade and returns its reason",
  empty.status === 400 && /signed challenge/i.test(empty.json?.error?.message || ""),
  empty.json?.error?.message || `HTTP ${empty.status}`
);

console.log("OK:");
for (const o of oks) console.log("  +", o);
if (fails.length) {
  console.log("FAIL:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`\nALL GREEN (${oks.length} checks)`);
