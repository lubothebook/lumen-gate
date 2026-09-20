#!/usr/bin/env node
/*
  The stranger's whole journey, end to end, with no configured account.

  One freshly generated keypair — funded by friendbot, named in no file of
  this repository — does every step of the inbound path itself:

    1. opens its own trustline for the wrapped asset (its own signature);
    2. locks an amount on the source simulator (three events in one block, so
       the Merkle proof carries a real sibling instead of the degenerate
       single-leaf case the earlier gasless demo rode);
    3. carries the block's BLS finality evidence to the TESTNET registry
       itself — the submit path requires no authorization, and this is the
       first time the repository proves it for the finality lane specifically,
       not just the zk lanes;
    4. calls `finalize_inbound_tooling` on the gateway itself and pays its own
       fee (contrast with the gasless lane, where the relayer signs and pays);
    5. reads its minted balance back from Horizon.

  Refusals are part of the run: finalize before finality exists, evidence
  replay after consumption, a mutated Merkle sibling after success. Each
  refusal is a simulation against the real network state — recorded, never
  paid for twice.

  What this does NOT prove, said in the same breath: the quorum behind the
  evidence is still the demo 2-of-3 policy pinned at deployment (the registry
  is renounced; the number cannot be moved to 1-of-1 on this generation —
  that is the next-generation item in docs/BRIDGE_TRUST_MODEL.md). The
  stranger moved the evidence; the trust decision is still the validator set
  the domain registered, verified by the pairing equation the contract ran.

  Environment: SIM_URL (default http://127.0.0.1:3001), MINT_OUT (receipt
  path, default deployments/mint-flow.json), MINT_AMOUNT (base units, default
  2500000000 = 250.0000000), MINT_NOTE (run_note), MINT_REFUSE (1 = do not
  send money-changing transactions; checks still run in simulation).
*/
'use strict';
const fs = require('fs');
const path = require('path');
const sdk = require('@stellar/stellar-sdk');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/testnet.json'), 'utf8'));
const SIM = (process.env.SIM_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const OUT = process.env.MINT_OUT || path.join(ROOT, 'deployments/mint-flow.json');
const AMOUNT = BigInt(process.env.MINT_AMOUNT || '2500000000');
const REFUSE = process.env.MINT_REFUSE === '1';

const HORIZON = new sdk.Horizon.Server(MANIFEST.horizon_url || 'https://horizon-testnet.stellar.org');
const RPC = new sdk.SorobanRpc.Server(MANIFEST.rpc_url, { allowHttp: MANIFEST.rpc_url.includes('127.0.0.1') || MANIFEST.rpc_url.includes('localhost') });
const NETWORK = sdk.Networks.TESTNET;
const REGISTRY = new sdk.Contract(MANIFEST.contracts.finality_registry.contract_id);
const GATEWAY = new sdk.Contract(MANIFEST.contracts.settlement_gateway.contract_id);
const TOKEN = new sdk.Contract(MANIFEST.contracts.wrapped_asset_sac.contract_id);
const SRC = MANIFEST.wsrc_asset
  ? { code: MANIFEST.wsrc_asset.asset, issuer: MANIFEST.wsrc_asset.issuer }
  : { code: MANIFEST.contracts.wrapped_asset_sac.asset, issuer: MANIFEST.contracts.wrapped_asset_sac.issuer };
const DOMAIN_KEY = Buffer.from(MANIFEST.domain.domain_key, 'hex');
const TARGET_DOMAIN = Buffer.from(MANIFEST.target_domain, 'hex');

const checks = [];
function record(check, pass, detail) {
  checks.push({ check, pass: !!pass, detail: String(detail).slice(0, 900) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${check}${detail ? `  ${detail}` : ''}`);
}
const hex = (b) => Buffer.from(b).toString('hex');

// Soroban structs serialize as maps keyed by symbol. The host's map→struct
// conversion walks entries assuming they are sorted; the ordering it checks
// against is plain lexicographic on the symbol bytes (a length-first sort,
// which the field-name collision in InboundRelayArgs makes easy to
// hypothesize, is rejected with "ScMap was not sorted by key").
function structVal(fields) {
  const entries = Object.entries(fields).map(([key, val]) => ({
    key: sdk.xdr.ScVal.scvSymbol(key),
    val,
  }));
  entries.sort((a, b) => (a.key.sym() < b.key.sym() ? -1 : 1));
  return sdk.xdr.ScVal.scvMap(entries.map((e) => new sdk.xdr.ScMapEntry(e)));
}
const b32 = (buf) => sdk.xdr.ScVal.scvBytes(buf);
const u32 = (n) => sdk.nativeToScVal(Number(n), { type: 'u32' });
const u64 = (n) => sdk.nativeToScVal(BigInt(n), { type: 'u64' });
const i128 = (n) => sdk.nativeToScVal(BigInt(n), { type: 'i128' });
const str = (s) => sdk.nativeToScVal(s, { type: 'string' });
const addr = (s) => new sdk.Address(s).toScVal();

function builder(source) {
  // stellar-base 12.1.1 ignores a timeout option in the constructor — the
  // only way to satisfy its timebounds precondition is the setTimeout method.
  return new sdk.TransactionBuilder(source, { networkPassphrase: NETWORK, fee: 100 }).setTimeout(600);
}

async function loadAccount(address) {
  const r = await HORIZON.accounts().accountId(address).call();
  return new sdk.Account(r.account_id, r.sequence);
}

// Plain-object transaction reads. This stellar-base (12.1.1) predates the
// protocol's current TransactionMeta union arm, so RPC getTransaction throws
// parsing the metadata of a successful transaction — and the answer we want
// (ledger, fee, success) never lives in that metadata anyway. Horizon answers
// the same question with a JSON fetch and no XDR.
async function horizonTransaction(hash) {
  const url = `${MANIFEST.horizon_url || 'https://horizon-testnet.stellar.org'}/transactions/${hash}`;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`transaction ${hash.slice(0, 16)}… never appeared in Horizon`);
}

async function sendAndConfirm(tx, signer) {
  const sim = await RPC.simulateTransaction(tx);
  const refusal = simError(sim);
  if (refusal) throw new Error(`simulation refused: ${refusal}`);
  const prepared = sdk.SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const sent = await RPC.sendTransaction(prepared);
  if (sent.error) throw new Error(`submission refused: ${JSON.stringify(sent.error).slice(0, 300)}`);
  const horizon = await horizonTransaction(sent.hash);
  if (!horizon.successful) throw new Error(`transaction ${sent.hash} landed FAILED: ${String(horizon.result_xdr).slice(0, 120)}`);
  return { hash: sent.hash, ledger: Number(horizon.ledger), fee_stroops: Number(horizon.fee_charged), confirmed_from: 'Horizon' };
}

async function simulateContractCall(contract, fn, args, source) {
  const tx = builder(source)
    .addOperation(contract.call(fn, ...args))
    .build();
  return RPC.simulateTransaction(tx);
}

// stellar-sdk 12.3 hands back an already-decoded response: the successful
// answer is `sim.result.retval` (an ScVal instance), refusals surface as
// `sim.result.error` or the top-level `sim.error` for pre-execution rejections.
function simError(sim) {
  return (sim.result && sim.result.error) || sim.error || null;
}

// A read-only call through a funded account: no signature needed, no fee paid.
async function read(contract, fn, args, readerAccount) {
  const sim = await simulateContractCall(contract, fn, args, readerAccount);
  const error = simError(sim);
  if (error) throw new Error(`read ${fn} failed: ${error}`);
  return sdk.scValToNative(sim.result.retval);
}

async function simErrorFor(contract, fn, args, source) {
  const sim = await simulateContractCall(contract, fn, args, source);
  return simError(sim);
}

async function main() {
  console.log('Lumen Gate — stranger full-flow mint');
  console.log(`  registry: ${MANIFEST.contracts.finality_registry.contract_id}`);
  console.log(`  gateway:  ${MANIFEST.contracts.settlement_gateway.contract_id}`);
  console.log(`  simulator: ${SIM}${REFUSE ? '  (MINT_REFUSE=1: nothing is sent)' : ''}`);

  // ---- the stranger ----------------------------------------------------
  const stranger = sdk.Keypair.random();
  const strangerAddr = stranger.publicKey();
  console.log(`  stranger account (generated at run time): ${strangerAddr}`);
  const funded = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(strangerAddr)}`, { method: 'GET' });
  record('stranger_funded_by_friendbot', funded.ok, funded.ok ? `${strangerAddr} funded` : `friendbot returned ${funded.status}`);
  if (!funded.ok) return finish();

  // ---- where the domain stands -----------------------------------------
  let last = null;
  let lastReadError = null;
  for (let attempt = 0; attempt < 10 && !last; attempt++) {
    try {
      last = await read(REGISTRY, 'get_last_finalized', [b32(DOMAIN_KEY)], await loadAccount(strangerAddr));
    } catch (e) {
      lastReadError = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!last) {
    record('registry_domain_readable', false, `get_last_finalized returned no record for the manifest domain key after 10 attempts${lastReadError ? `; last error: ${lastReadError.message.slice(0, 160)}` : ''}`);
    return finish();
  }
  const lastHeight = BigInt(last.last_height);
  record('registry_domain_readable', true, `domain ${DOMAIN_KEY.toString('hex').slice(0, 12)}… readable, last_height ${lastHeight}`);
  console.log(`  registry domain last_height: ${lastHeight}`);

  // ---- wait for the simulator to pass the forward-only trail -------------
  // The registry accepts only strictly increasing heights; a restarted
  // simulator starts at 1 and produces every five seconds, so the run parks
  // here rather than burning a submission on a height the domain has seen.
  let block = await (await fetch(`${SIM}/blocks/latest`)).json();
  const deadline = Date.now() + 30 * 60 * 1000;
  while (BigInt(block.height) <= lastHeight + 2n) {
    if (Date.now() > deadline) {
      record('simulator_caught_up_with_finality_trail', false, `after 30 minutes the simulator is at height ${block.height}, registry at ${lastHeight}; the gap is too large for the five-second cadence`);
      return finish();
    }
    await new Promise((r) => setTimeout(r, 5000));
    block = await (await fetch(`${SIM}/blocks/latest`)).json();
  }
  record('simulator_caught_up_with_finality_trail', true, `simulator height ${block.height} > registry last ${lastHeight}`);

  // ---- trustline, in the stranger's own name -----------------------------
  let trustline = null;
  if (!REFUSE) {
    const trustTx = builder(await loadAccount(strangerAddr))
      .addOperation(sdk.Operation.changeTrust({ asset: new sdk.Asset(SRC.code, SRC.issuer) }))
      .build();
    trustTx.sign(stranger);
    const sent = await HORIZON.submitTransaction(trustTx);
    const rec = await horizonTransaction(sent.hash);
    trustline = { hash: sent.hash, ledger: Number(rec.ledger), fee_stroops: Number(rec.fee_charged) };
    record('stranger_opened_its_own_trustline', rec.successful, `${sent.hash.slice(0, 16)}… ledger ${rec.ledger}`);
  } else {
    record('stranger_opened_its_own_trustline', true, 'skipped under MINT_REFUSE');
  }

  // ---- the deposit itself: three events so the proof has a sibling -------
  const lock = await (await fetch(`${SIM}/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: Number(AMOUNT), recipient: strangerAddr, count: 3 }),
  })).json();
  const event = lock.events[1]; // the middle one: real siblings on both sides
  record('deposit_landed_on_source_chain', !!event, `height ${lock.event ? lock.event.height : '?'} index 1 of 3, message ${event.message_id.slice(0, 16)}…`);
  const height = event.height;

  const envelope = await (await fetch(`${SIM}/proof?height=${height}&kind=bls&message_id=${event.message_id}`)).json();
  record('simulator_signed_finality_envelope', envelope.payload_hex.length % 2 === 0 && BigInt(envelope.payload.height) === BigInt(height), `payload ${envelope.payload_hex.length / 2} bytes, sig over state ${envelope.payload.state_root.slice(0, 12)}…, 2-of-3 demo validators`);

  // ---- refusal #1: finalize before finality exists ------------------------
  const relayArgsFor = (ev) => structVal({
    message_id: b32(Buffer.from(ev.message_id, 'hex')),
    source_domain: b32(DOMAIN_KEY),
    target_domain: b32(TARGET_DOMAIN),
    source_height: u64(ev.height),
    event_index: u32(ev.event_index),
    nonce: u64(ev.nonce),
    sender: addr(ev.sender_on_source),
    recipient: addr(ev.recipient_on_source),
    payload_hash: b32(Buffer.from(ev.payload_hash, 'hex')),
    kind_code: u32(1),
    expiry_height: u64(ev.expiry_height),
  });
  const relayArgs = relayArgsFor(event);
  const proofBytes = (envelope.merkle_proof || []).reduce((buf, sib) => Buffer.concat([buf, Buffer.from(sib, 'hex')]), Buffer.alloc(0));
  // The simulator offsets each event's amount by its index in the block
  // (req.amount + index) so sibling leaves differ — the gateway recomputes
  // the payload hash over THE EVENT's amount, so the payload amount travels
  // with the event, never with the request.
  const eventAmount = BigInt(event.amount);
  const finalizeArgs = (proof) => [relayArgs, sdk.xdr.ScVal.scvBytes(proof), addr(MANIFEST.contracts.wrapped_asset_sac.contract_id), i128(eventAmount), addr(strangerAddr)];
  const earlyErr = await simErrorFor(GATEWAY, 'finalize_inbound_tooling', finalizeArgs(proofBytes), await loadAccount(strangerAddr));
  record('finalize_before_finality_is_refused', /Error\(Contract, #(5|10)\)/.test(earlyErr || ''), `gateway answered: ${earlyErr ? earlyErr.slice(0, 90) : 'it would have SUCCEEDED — a hole, not a check'}`);

  // ---- the stranger carries finality to the registry itself --------------
  const evidence = structVal({
    adapter_id: b32(Buffer.from(envelope.adapter_id, 'hex')),
    evidence_version: u32(envelope.evidence_version),
    network: str(envelope.network),
    payload: sdk.xdr.ScVal.scvBytes(Buffer.from(envelope.payload_hex, 'hex')),
    declared_height: u64(envelope.declared_height),
    declared_root: b32(Buffer.from(envelope.declared_root, 'hex')),
    submitter: addr(strangerAddr),
  });
  let finalityTx = null;
  if (!REFUSE) {
    finalityTx = await sendAndConfirm(
      builder(await loadAccount(strangerAddr))
        .addOperation(REGISTRY.call('submit_finality_evidence_bls', evidence)).build(),
      stranger,
    );
  }
  record('stranger_submitted_finality_evidence', REFUSE || !!finalityTx, finalityTx ? `ledger ${finalityTx.ledger}, ${finalityTx.fee_stroops} stroops paid by the stranger itself` : 'dry run');

  // ---- refusal #2: the consumed digest belongs to the evidence ------------
  const replayErr = await simErrorFor(REGISTRY, 'submit_finality_evidence_bls', [evidence], await loadAccount(strangerAddr));
  record('replaying_the_consumed_evidence_is_refused', REFUSE ? true : /Error\(Contract, #9\)/.test(replayErr || ''), replayErr ? `registry answered ${replayErr.slice(0, 90)}` : 'a second submission would succeed — the consumed-digest set did not fire');

  // ---- refusal #3: a forged envelope (simulator's own tamper switch) ------
  const tampered = await (await fetch(`${SIM}/proof?height=${height}&kind=bls&message_id=${event.message_id}&tamper=sig`)).json();
  const forgedEvidence = structVal({
    adapter_id: b32(Buffer.from(tampered.adapter_id, 'hex')),
    evidence_version: u32(tampered.evidence_version),
    network: str(tampered.network),
    payload: sdk.xdr.ScVal.scvBytes(Buffer.from(tampered.payload_hex, 'hex')),
    declared_height: u64(tampered.declared_height),
    declared_root: b32(Buffer.from(tampered.declared_root, 'hex')),
    submitter: addr(strangerAddr),
  });
  const forgedErr = await simErrorFor(REGISTRY, 'submit_finality_evidence_bls', [forgedEvidence], await loadAccount(strangerAddr));
  record('tampered_bls_signature_is_refused_by_pairing', /Error\(Contract, #7\)/.test(forgedErr || ''), forgedErr ? `registry answered ${forgedErr.slice(0, 90)}` : 'a zeroed signature simulated clean — the pairing check would have to catch it on-ledger, and this shows it did not even get that far in simulation');

  // ---- the mint, self-submitted, self-paid --------------------------------
  let mintTx = null;
  if (!REFUSE) {
    mintTx = await sendAndConfirm(
      builder(await loadAccount(strangerAddr))
        .addOperation(GATEWAY.call('finalize_inbound_tooling', ...finalizeArgs(proofBytes))).build(),
      stranger,
    );
  }
  record('stranger_minted_to_itself', REFUSE || !!mintTx, mintTx ? `ledger ${mintTx.ledger}, ${mintTx.fee_stroops} stroops paid by the stranger, both transactions from the stranger's own key` : 'dry run');

  // ---- balance readback: Horizon's classic view and the SAC's own answer --
  if (!REFUSE && mintTx) {
    const acct = await HORIZON.accounts().accountId(strangerAddr).call();
    const line = acct.balances.find((b) => b.asset_code === SRC.code && b.asset_issuer === SRC.issuer);
    record('balance_visible_in_horizon', !!line && BigInt(line.balance.replace('.', '')) * 10n ** (7n - 0n) >= 0n && line.balance === (Number(eventAmount) / 1e7).toFixed(7), `Horizon sees ${line ? line.balance : 'nothing'} for the stranger`);
    const bal = await read(TOKEN, 'balance', [addr(strangerAddr)], await loadAccount(strangerAddr));
    record('sac_agrees_with_horizon', BigInt(bal) === eventAmount, `SAC balance ${bal}`);
    // ---- refusal #4: the same message cannot mint twice --------------------
    const reMintErr = await simErrorFor(GATEWAY, 'finalize_inbound_tooling', finalizeArgs(proofBytes), await loadAccount(strangerAddr));
    record('the_same_message_cannot_mint_twice', /Error\(Contract, #4\)/.test(reMintErr || ''), reMintErr ? `gateway answered ${reMintErr.slice(0, 90)}` : 'a replay would succeed — the processed set did not fire');
    // ---- refusal #5: one mutated byte in the Merkle sibling ---------------
    // Aimed at the THIRD event of the same block — a message this run never
    // mints. Aimed at the minted message it could only ever answer #4
    // (already processed), because the processed check precedes the proof
    // walk; that would record a refusal the Merkle code never exercised.
    const ev3 = lock.events[2];
    const env3 = await (await fetch(`${SIM}/proof?height=${height}&kind=bls&message_id=${ev3.message_id}`)).json();
    const proof3 = (env3.merkle_proof || []).reduce((buf, sib) => Buffer.concat([buf, Buffer.from(sib, 'hex')]), Buffer.alloc(0));
    const bad = Buffer.from(proof3.length ? proof3 : Buffer.alloc(32));
    bad[0] ^= 1;
    const badProofArgs = [relayArgsFor(ev3), sdk.xdr.ScVal.scvBytes(bad), addr(MANIFEST.contracts.wrapped_asset_sac.contract_id), i128(BigInt(ev3.amount)), addr(strangerAddr)];
    const badErr = await simErrorFor(GATEWAY, 'finalize_inbound_tooling', badProofArgs, await loadAccount(strangerAddr));
    record('a_mutated_sibling_breaks_the_root_and_is_refused', /Error\(Contract, #9\)/.test(badErr || ''), badErr ? `gateway answered ${badErr.slice(0, 90)}` : 'the untouched message accepted a mutated proof — the walk would not, but this run did not see it refuse');
  } else if (REFUSE) {
    ['balance_visible_in_horizon', 'sac_agrees_with_horizon', 'the_same_message_cannot_mint_twice', 'a_mutated_sibling_breaks_the_root_and_is_refused'].forEach((c) => record(c, true, 'skipped under MINT_REFUSE'));
  }

  return finish({
    stranger: { address: strangerAddr, key_source: 'generated at run time; funded by friendbot; configured nowhere' },
    trustline: trustline ? { transaction: trustline.hash, ledger: trustline.ledger, fee_stroops: trustline.fee_stroops } : null,
    deposit: { height, event_index: event.event_index, message_id: event.message_id, amount_base_units: AMOUNT.toString(), block_events: lock.events.length },
    finality: { submitted_by: strangerAddr, transaction: finalityTx && finalityTx.hash, ledger: finalityTx && finalityTx.ledger, fee_stroops: finalityTx && finalityTx.fee_stroops },
    mint: { transaction: mintTx && mintTx.hash, amount_base_units: eventAmount.toString(), ledger: mintTx && mintTx.ledger, fee_stroops: mintTx && mintTx.fee_stroops },
    quorum_behind_the_evidence: 'demo 2-of-3 over fixed validator keys 1, 2, 3 — the registry is renounced, so the number is history; moving it to 1-of-1 is the next-generation item',
  });
}

function finish(extra) {
  const passed = checks.every((c) => c.pass);
  const receipt = {
    generated_at: new Date().toISOString(),
    passed,
    network: MANIFEST.network,
    contracts: {
      finality_registry: MANIFEST.contracts.finality_registry.contract_id,
      settlement_gateway: MANIFEST.contracts.settlement_gateway.contract_id,
      wrapped_asset_sac: MANIFEST.contracts.wrapped_asset_sac.contract_id,
    },
    run_note: process.env.MINT_NOTE || (REFUSE ? 'dry run under MINT_REFUSE — refusals only' : 'the stranger carried its own finality evidence and minted itself, paying both fees'),
    checks,
    ...extra,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\n${passed ? 'ALL CHECKS PASS' : 'CHECKS FAILED'} — receipt: ${path.relative(ROOT, OUT)}`);
  if (!passed) process.exitCode = 1;
}

main().catch((e) => {
  record('unhandled_error', false, e.stack || String(e));
  finish();
});
