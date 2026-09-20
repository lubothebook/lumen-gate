#!/usr/bin/env node
/*
 * S1 spike driver (DIRECTIVE 2.0, F1). One burn answers S1:
 * does the testnet MessageTransmitter route a Sepolia->Stellar message to a
 * contract set as mintRecipient/destinationCaller (GateClaim-style), and does
 * the CCTP USDC mint land on that CONTRACT account? SpikeGate (deployed in
 * this phase, id in deployments/testnet-2.0.json) is the recipient; its
 * `claim` entry calls MT.receive_message with caller = self and reports its
 * own post-mint balance.
 *
 * Honesty rules this file enforces on itself:
 *  - testnet only: it verifies eth_chainId and refuses anything but 11155111;
 *  - no fabricated anything: it refuses to run a leg whose inputs are absent
 *    and exits 3 with exactly what to send where;
 *  - keys are read from env (SEPOLIA_PK) or a runtime-generated file that the
 *    sibling .gitignore keeps out of the repo; nothing secret is printed.
 *
 * Addresses are verbatim from the pages recorded in ./spike-notes.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import StellarSdk from "@stellar/stellar-sdk"; // CJS package: default import, then destructure
const {
  Contract: SorobanContract,
  SorobanRpc,
  Networks,
  TransactionBuilder,
  Keypair,
  StrKey,
  timeout,
} = StellarSdk;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, ".spike-state.json");
const KEYFILE = path.join(HERE, ".spike-evm-key.json");

const SEPOLIA_CHAIN_ID = 11155111n;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
// Circle testnet contracts, domain 0 (Sepolia) — contract-addresses.md:
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
// Circle testnet contracts, domain 27 (Stellar) — stellar-contracts.md:
const MT_STELLAR = "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY";
// native USDC contract on Stellar testnet: NOT guessed — read from
// TMM.get_local_token(0, USDC_SEPOLIA) during F1 (see spike-notes.md).
const USDC_STELLAR = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPIKE_GATE = process.env.SPIKE_GATE || "CAKZ636NMQ3ZPWM5C2KQBM42WGO5RZ2QDFNQ4YKLJQ4XBWNVXTKHQ2JL";
const IRIS = process.env.IRIS_BASE || "https://iris-api-sandbox.circle.com";
const STELLAR_RPC = process.env.STELLAR_RPC || "https://soroban-testnet.stellar.org";

const TM_ABI = [
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint64 maxFee, uint32 minFinalityThreshold, bytes hookData)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const usage = `usage: node spike-s1.mjs <status|burn|claim> [--amount=1250000] [--mode=fast|standard]
  status  show what this key holds and what remains to be done
  burn    approve + depositForBurnWithHook targeting SpikeGate, save state
  claim   fetch attestation, invoke SpikeGate.claim on Stellar, read balance`;

function die(code, msg) { console.error(`spike-s1: ${msg}`); process.exit(code); }
function log(...a) { console.log("[s1]", ...a); }

function strkeyToBytes32(strkey) {
  // Contract (C...) strkeys carry a raw 32-byte payload; the message field is
  // exactly that payload, no strkey envelope (stellar.md: "store only the raw
  // 32-byte payload").
  if (!StrKey.isValidContract(strkey)) die(2, `not a valid contract strkey: ${strkey}`);
  return "0x" + Buffer.from(StrKey.decodeContract(strkey)).toString("hex");
}

function buildHookData(forwardRecipientStrkey) {
  // Format verbatim from stellar.md "Hook format": bytes 0-23 zero, 24-27 u32
  // version = 0, 28-31 u32 length, 32.. strkey UTF-8.
  const ok =
    StrKey.isValidEd25519PublicKey(forwardRecipientStrkey) ||
    StrKey.isValidContract(forwardRecipientStrkey) ||
    StrKey.isValidMed25519PublicKey(forwardRecipientStrkey);
  if (!ok) die(2, `invalid forward recipient strkey: ${forwardRecipientStrkey}`);
  const rec = Buffer.from(forwardRecipientStrkey, "utf8");
  const hook = Buffer.alloc(32 + rec.length);
  hook.writeUInt32BE(0, 24);
  hook.writeUInt32BE(rec.length, 28);
  rec.copy(hook, 32);
  return "0x" + hook.toString("hex");
}

function evmWallet() {
  if (process.env.SEPOLIA_PK) return new ethers.Wallet(process.env.SEPOLIA_PK);
  if (fs.existsSync(KEYFILE)) {
    const j = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
    if (j.secretExposesOnce !== true) die(2, "keyfile malformed; refusing to read");
    return new ethers.Wallet(j.privateKey);
  }
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(KEYFILE, JSON.stringify({ privateKey: w.privateKey, secretExposesOnce: true, note: "Spike-only testnet key; .gitignore keeps this file out of the repo; delete it when F1 closes." }, { mode: 0o600 }));
  return w;
}

async function provider() {
  const p = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const net = await p.getNetwork();
  if (net.chainId !== SEPOLIA_CHAIN_ID) die(2, `refusing: chain ${net.chainId} is not Sepolia (11155111)`);
  return p;
}

async function cmdStatus() {
  const p = await provider();
  const w = evmWallet().connect(p);
  const usdc = new ethers.Contract(USDC_SEPOLIA, ERC20_ABI, w);
  const [eth, usdcBal, allow] = await Promise.all([
    p.getBalance(w.address), usdc.balanceOf(w.address), usdc.allowance(w.address, TOKEN_MESSENGER_V2),
  ]);
  log(`evm address ${w.address}`);
  log(`  eth      : ${ethers.formatEther(eth)} ETH (need ~0.02 for two txs + buffer)`);
  log(`  usdc     : ${usdcBal} base units (need >= amount)`);
  log(`  allowance: ${allow}`);
  const ready = eth >= ethers.parseEther("0.02") && usdcBal > 0n;
  log(ready ? "READY: run burn, then claim once attestation is COMPLETED" : "WAITING FOR FUNDS (exit 3): send Sepolia ETH from any testnet ETH source and USDC from https://faucet.circle.com to the address above");
  process.exit(ready ? 0 : 3);
}

async function cmdBurn(args) {
  const p = await provider();
  const w = evmWallet().connect(p);
  const amount = BigInt(args.amount || "1250000"); // 1.25 USDC, 6-dec subunits
  const threshold = args.mode === "fast" ? 1000 : 2000; // finality page: fast <=1000, standard >=2000
  const usdc = new ethers.Contract(USDC_SEPOLIA, ERC20_ABI, w);
  const tm = new ethers.Contract(TOKEN_MESSENGER_V2, TM_ABI, w);
  const eth = await p.getBalance(w.address);
  const bal = await usdc.balanceOf(w.address);
  if (eth < ethers.parseEther("0.005") || bal < amount) die(3, `funding missing: eth=${eth} usdc=${bal}; run status and fund the address first`);
  const allow = await usdc.allowance(w.address, TOKEN_MESSENGER_V2);
  if (allow < amount) {
    log("approving exact burn amount to the token messenger"); // no unlimited approvals, ever
    const ap = await usdc.approve(TOKEN_MESSENGER_V2, amount);
    await ap.wait();
    log(`approve tx ${ap.hash}`);
  }
  const gateBytes32 = strkeyToBytes32(SPIKE_GATE);
  const hookData = buildHookData(SPIKE_GATE); // G-design: the spike gate IS the final recipient
  const maxFee = 1n; // route min fee for FAST measured 1 subunit; STANDARD is 0 — clamp to what the chain config allows
  log(`burning ${amount} USDC -> domain 27, mintRecipient=destinationCaller=SpikeGate, threshold=${threshold}`);
  const tx = await tm.depositForBurnWithHook(amount, 27, gateBytes32, USDC_SEPOLIA, gateBytes32, maxFee, threshold, hookData);
  const rc = await tx.wait();
  const state = { burnTx: tx.hash, block: rc.blockNumber, amount: amount.toString(), threshold, gate: SPIKE_GATE, startedAt: new Date().toISOString() };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`burn tx ${tx.hash} in block ${rc.blockNumber} (gas used ${rc.gasUsed})`);
  log("state saved; next: `node spike-s1.mjs claim`");
}

async function fetchAttestation(txHash) {
  const url = `${IRIS}/v2/messages/0?transactionHash=${txHash}`;
  const res = await fetch(url);
  if (!res.ok) die(3, `iris ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const m = (body.messages || [])[0];
  if (!m) die(3, "no message yet for that tx");
  return m; // { message, attestation?, status, ... }
}

async function fundStellarSender(server) {
  const kp = Keypair.random();
  const pub = kp.publicKey();
  await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  const acc = await server.loadAccount(pub);
  return { kp, acc };
}

async function cmdClaim() {
  if (!fs.existsSync(STATE)) die(2, "no .spike-state.json — run burn first");
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const msg = await fetchAttestation(st.burnTx);
  log(`iris status: ${msg.status}`);
  if (!msg.attestation) die(3, `attestation not ready yet (status ${msg.status}); poll claim again`);
  const server = new SorobanRpc.Server(STELLAR_RPC, { allowHttp: false });
  const { kp, acc } = await fundStellarSender(server);
  const gate = new SorobanContract(SPIKE_GATE);
  const tx = new TransactionBuilder(acc, { fee: "100000", network: Networks.TESTNET })
    .addOperation(gate.callClaim(
      MT_STELLAR,
      USDC_STELLAR,
      Buffer.from(msg.message.replace(/^0x/, ""), "hex"),
      Buffer.from(msg.attestation.replace(/^0x/, ""), "hex"),
    ))
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) die(1, `simulate says the contract refused: ${sim.error}`);
  const prepared = SorobanRpc.assembleTx(tx, sim).clone();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.error) die(1, `send rejected: ${JSON.stringify(sent.error)}`);
  const rec = await timeout(60000, server.getTransaction(sent.hash));
  if (rec.status !== "SUCCESS") die(1, `claim tx ${sent.hash} status=${rec.status}`);
  const read = new TransactionBuilder(
    await server.loadAccount(kp.publicKey()), { fee: "100", network: Networks.TESTNET },
  ).addOperation(gate.callLastBalance()).build();
  const rs = await server.simulateTransaction(read);
  log(`claim tx ${sent.hash} SUCCESS on ledger ${rec.ledger}`);
  log(`SpikeGate USDC balance after claim: ${rs.results?.[0] ? JSON.stringify(rs.results[0]) : "unavailable"}`);
  fs.writeFileSync(STATE, JSON.stringify({ ...st, claimTx: sent.hash, ledger: rec.ledger, irisStatus: msg.status }, null, 2));
  log("S1 verdict: read the balance above against the burned amount and record it in the manifest.");
}

const [cmd = "", ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((f) => { const [k, v] = f.replace(/^--/, "").split("="); return [k, v]; }));
if (cmd === "status") cmdStatus().catch((e) => die(1, e?.shortMessage || e?.message || String(e)));
else if (cmd === "burn") cmdBurn(args).catch((e) => die(1, e?.shortMessage || e?.message || String(e)));
else if (cmd === "claim") cmdClaim().catch((e) => die(1, e?.shortMessage || e?.message || String(e)));
else { console.log(usage); process.exit(2); }
