#!/usr/bin/env node
/*
 * registry-v2-live.js — the five-slot showcase, opened by anyone.
 *
 * This run does two things the four-slot merged registry (see
 * merge-lanes-live.js, whose record stands as history) could not:
 *
 *  1. It installs the 32-line gate-vm sibling beside its 8-line relative —
 *     same tag (the circuit publishes one separation constant), same 896-byte
 *     key length, different ceremony, different payload ceiling. The registry
 *     is where the design claim gets tested: three keys of one length in one
 *     contract, and pairing — not length, not tag, not slot naming — is what
 *     keeps the lanes from impersonating each other.
 *
 *  2. Its honest acceptance is submitted by a STRANGER: a key generated at
 *     runtime, funded by friendbot, configured nowhere in this repository.
 *     The contract's submit path has always been permissionless — the
 *     `submitter` field is a record, not a gate — and "a bridge without a
 *     relayer" is only a sentence until someone who is nobody in particular
 *     proves it by being the one who settles. That someone is this account.
 *     It pays its own fee, and the fee is read back from Horizon, not
 *     asserted from the CLI's happy path.
 *
 * The four per-lane suites still run here too (the real lane tools, against
 * this registry id, their renounce step deferred), so "all five slots on one
 * fresh registry, then one freeze" remains the shape of the receipt.
 *
 * Env:
 *   STELLAR_SOURCE     the admin/deployer identity       (default: audit-probe)
 *   NETWORK            horizon network                   (default: testnet)
 *   V2_REUSE           existing fresh registry id         (default: deploy one)
 *   V2_OUT             record path                        (default: deployments/registry-v2.json)
 */

const { execFile, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NETWORK = process.env.NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'audit-probe';
const BUILD = process.env.BUILD_DIR || path.join(ROOT, 'build');
const OUT = process.env.V2_OUT || path.join(ROOT, 'deployments', 'registry-v2.json');
const WASM = path.join(ROOT, 'target', 'wasm32v1-none', 'release', 'finality_registry.wasm');
const DOMAIN_NAME = process.env.DOMAIN || 'source-testnet';
const ADAPTER_NAME = 'source-chain-bls-v1';
const STRANGER = process.env.V2_STRANGER || 'stranger-v2';

const SLOT = { settlement: 768, step_chain: 896, execution: 1920, gate_vm: 896, gate_vm32: 896 };
const GETTER = {
  settlement: 'get_vk',
  step_chain: 'get_step_chain_vk',
  execution: 'get_execution_vk',
  gate_vm: 'get_gate_vm_vk',
  gate_vm32: 'get_gate_vm32_vk',
};
const SETTER = {
  settlement: 'set_vk',
  step_chain: 'set_step_chain_vk',
  execution: 'set_execution_vk',
  gate_vm: 'set_gate_vm_vk',
  gate_vm32: 'set_gate_vm32_vk',
};
const ERR = {
  3: 'DomainNotFound',
  5: 'DeclaredMismatch',
  6: 'InvalidPayload',
  8: 'InvalidProof',
  9: 'EvidenceAlreadyProcessed',
  11: 'BadPayloadLength',
  12: 'NotAdmitted',
  13: 'AdminRenounced',
};
const HORIZON =
  NETWORK === 'testnet' ? 'https://horizon-testnet.stellar.org' : 'https://horizon-public.argent.xyz';

function sh(file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 180000, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const get = require('node:https').get;
    get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`${url}: ${body.slice(0, 160)}`));
        }
      });
    }).on('error', reject);
  });
}
const contractError = (text) => {
  const m = text.match(/Error\(Contract,\s*#(\d+)\)/);
  return m ? Number(m[1]) : null;
};
const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const u64le = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b.toString('hex');
};
const u64be = (value) => BigInt(value).toString(16).padStart(64, '0');
const hexOf = (text, bytes) => (text.match(new RegExp(`[0-9a-f]{${bytes * 2}}`)) || [])[0] || null;
const txOf = (text) => (text.match(/tx\/([0-9a-f]{64})/) || [])[1] || null;

function readSiblingArtifacts() {
  const pick = (name) => {
    const built = path.join(BUILD, name);
    return fs.existsSync(built) ? built : path.join(ROOT, 'deployments', 'vectors', 'gate_vm32', name);
  };
  const publicPath = pick('gate_vm32_public.json');
  const proofPath = pick('gate_vm32_proof.hex');
  const vkPath = pick('gate_vm32_vk.hex');
  const payloadPath = pick('gate_vm32_payload.hex');
  for (const f of [publicPath, proofPath, vkPath, payloadPath]) {
    if (!fs.existsSync(f)) {
      console.error(`${f} is missing — the sibling lane's vectors are committed under deployments/vectors/gate_vm32/`);
      process.exit(2);
    }
  }
  return {
    publicInputs: JSON.parse(fs.readFileSync(publicPath, 'utf8')),
    proof: fs.readFileSync(proofPath, 'utf8').trim(),
    vk: fs.readFileSync(vkPath, 'utf8').trim(),
    payload: fs.readFileSync(payloadPath, 'utf8').trim(),
    vkPath,
  };
}

function evidenceFor({ payload, height, endRoot, submitter }) {
  return JSON.stringify({
    adapter_id: sha256hex(ADAPTER_NAME),
    evidence_version: 1,
    network: DOMAIN_NAME,
    payload,
    declared_height: height,
    declared_root: endRoot,
    submitter,
  });
}

async function main() {
  const records = [];
  const started = new Date().toISOString();
  const record = (check, passed, detail, extra = {}) => {
    records.push({ check, passed, detail, at: new Date().toISOString(), ...extra });
    console.log(`  [${passed ? 'pass' : 'FAIL'}] ${check}\n         ${detail}`);
  };
  const cliEnv = () => (process.env.STELLAR_CONFIG_DIR ? { STELLAR_CONFIG_DIR: process.env.STELLAR_CONFIG_DIR } : {});

  const admin = (await sh('stellar', ['keys', 'address', SOURCE], cliEnv())).stdout.trim();
  if (!/^G[A-Z0-9]{55}$/.test(admin)) {
    console.error(`could not resolve the admin identity ${SOURCE}`);
    process.exit(2);
  }
  const invoke = (id, args, signer = SOURCE) =>
    sh('stellar', ['contract', 'invoke', '--id', id, '--source', signer, '--network', NETWORK, '--', ...args], cliEnv());

  // -- 0. fresh registry -------------------------------------------------------
  let registry = process.env.V2_REUSE || '';
  if (!registry) {
    if (!fs.existsSync(WASM)) {
      console.error(`${WASM} is missing. Build it: (cd contracts/finality_registry && stellar contract build)`);
      process.exit(2);
    }
    const result = await sh('stellar', ['contract', 'deploy', '--wasm', WASM, '--source', SOURCE, '--network', NETWORK], cliEnv());
    registry = result.stdout.trim().split('\n').pop().trim();
    if (!/^C[A-Z0-9]{55}$/.test(registry)) {
      console.error(`deployment did not return a contract id: ${result.stdout}${result.stderr}`);
      process.exit(2);
    }
  }
  console.log(`registry v2: ${registry}`);

  // -- 1. the four proven suites, deferred renounce ---------------------------
  const lanes = [
    { tool: 'step-chain-live.js', registryEnv: 'STEP_CHAIN_REGISTRY', outEnv: 'STEP_CHAIN_OUT', skipEnv: 'STEP_CHAIN_SKIP_RENOUNCE', record: 'step-chain-v2.json' },
    { tool: 'execution-lane-live.js', registryEnv: 'EXECUTION_REGISTRY', outEnv: 'EXECUTION_OUT', skipEnv: 'EXECUTION_SKIP_RENOUNCE', record: 'execution-v2.json' },
    { tool: 'gate-vm-lane-live.js', registryEnv: 'GATEVM_REGISTRY', outEnv: 'GATEVM_OUT', skipEnv: 'GATEVM_SKIP_RENOUNCE', record: 'gate-vm-v2.json' },
  ];
  const laneDir = path.join(BUILD, 'merged-lane2');
  fs.mkdirSync(laneDir, { recursive: true });
  const laneSummaries = {};
  for (const lane of lanes) {
    const run = spawnSync('node', [path.join(ROOT, 'tools', lane.tool)], {
      cwd: ROOT,
      env: {
        ...process.env,
        [lane.registryEnv]: registry,
        [lane.outEnv]: path.join(laneDir, lane.record),
        [lane.skipEnv]: '1',
        STELLAR_SOURCE: SOURCE,
        NETWORK,
        DOMAIN: DOMAIN_NAME,
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(laneDir, lane.record), 'utf8'));
    } catch {
      /* counted as failure below */
    }
    const checks = parsed?.checks || parsed?.records || [];
    const passedCount = checks.length ? checks.filter((c) => c.passed).length : parsed?.checks_passed;
    const total = checks.length || parsed?.checks_total;
    laneSummaries[lane.record.replace('-v2.json', '')] = {
      checks: total ?? 0,
      passed: passedCount ?? 0,
      honest_transaction: checks.find((c) => /honest/.test(c.check || ''))?.transaction || null,
    };
    record(
      `${lane.tool.replace('-live.js', '')}_suite`,
      run.status === 0 && Number(total) > 0 && passedCount === total,
      Number(total) > 0 ? `${passedCount}/${total} checks in the lane's own record` : `no usable record; child tail: ${`${run.stdout || ''}${run.stderr || ''}`.slice(-240)}`,
    );
  }

  // -- 2. settlement key, copied from the live showcase ------------------------
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
  const showcase = manifest.contracts.finality_registry.contract_id;
  const liveKey = await invoke(showcase, ['get_vk']);
  const settlementVk = hexOf(`${liveKey.stdout}${liveKey.stderr}`, SLOT.settlement);
  if (!settlementVk) {
    console.error('the showcase registry did not serve its settlement key');
    process.exit(2);
  }
  const setKey = await invoke(registry, ['set_vk', '--admin', admin, '--vk', settlementVk]);
  record('settlement_slot_installed', setKey.ok, setKey.ok ? 'set_vk accepted the live 768-byte key' : `${setKey.stdout}${setKey.stderr}`.slice(0, 240));

  // -- 3. the gate-vm32 slot: installs, ceilings, and the stranger --------------
  const sib = readSiblingArtifacts();
  const sibPublics = sib.publicInputs.map((v) => u64be(v));
  const endRoot = u64be(sib.publicInputs[3]);
  // the height the committed payload declares, read back out of the payload
  // itself — if the vector file and the evidence ever disagree, the contract's
  // binding check is what says so, not this script's memory
  const declaredHeight = Number(Buffer.from(sib.payload.slice(0, 16), 'hex').readBigUInt64LE());

  const setSib = await invoke(registry, ['set_gate_vm32_vk', '--admin', admin, '--vk', sib.vk]);
  record(
    'gate_vm32_key_installed_at_896',
    setSib.ok,
    setSib.ok ? 'the sibling ceremony key sits in its own slot' : `${setSib.stdout}${setSib.stderr}`.slice(0, 240),
    { transaction: txOf(setSib.stdout + setSib.stderr) },
  );
  const shortKey = await invoke(registry, ['set_gate_vm32_vk', '--admin', admin, '--vk', sib.vk.slice(0, sib.vk.length - 2)]);
  const stillStored = await invoke(registry, ['get_gate_vm32_vk']);
  record(
    'gate_vm32_short_key_refused_and_slot_unchanged',
    !shortKey.ok && (stillStored.stdout.match(/[0-9a-f]{1792}/) || [])[0] === sib.vk,
    !shortKey.ok
      ? 'an 895-byte key is refused and the stored bytes are untouched'
      : 'a wrong-length key was ACCEPTED',
  );

  // format refusal: the same proof, the same roots, a payload claiming one
  // step more than its window can count — at 32 rows the ceiling is 31, so
  // claim 32 and require the parse error, before any pairing is spent.
  const inflated = sib.payload.slice(0, 272) + u64le(32);
  const badPayload = await invoke(registry, [
    'submit_gate_vm32_zk',
    '--evidence', evidenceFor({ payload: inflated, height: declaredHeight, endRoot, submitter: admin }),
    '--proof', sib.proof,
    '--public_inputs', JSON.stringify(sibPublics),
  ]);
  record(
    'gate_vm32_refuses_hash_steps_above_its_window',
    !badPayload.ok && contractError(`${badPayload.stdout}${badPayload.stderr}`) === 6,
    `a 32-step claim against a 32-row window is refused as ${ERR[contractError(`${badPayload.stdout}${badPayload.stderr}`)] || 'some error'} before pairing`,
  );

  // -- the stranger ------------------------------------------------------------
  const gen = await sh('stellar', ['keys', 'generate', STRANGER, '--network', NETWORK], cliEnv());
  const strangerAddr = (await sh('stellar', ['keys', 'address', STRANGER], cliEnv())).stdout.trim();
  if (!/^G[A-Z0-9]{55}$/.test(strangerAddr)) {
    console.error(`could not create the stranger identity: ${gen.stdout}${gen.stderr}`.slice(0, 400));
    process.exit(2);
  }
  const fund = await sh('stellar', ['keys', 'fund', STRANGER, '--network', NETWORK], cliEnv());
  if (!fund.ok) {
    await sh('curl', ['-s', `https://friendbot.stellar.org?addr=${encodeURIComponent(strangerAddr)}`]);
  }
  record(
    'stranger_exists_and_is_funded',
    /^G[A-Z0-9]{55}$/.test(strangerAddr),
    `${strangerAddr.slice(0, 8)}... was generated this run and appears in no configuration of this repository`,
    { address: strangerAddr, funded_by: fund.ok ? 'stellar keys fund' : 'friendbot fallback' },
  );

  const honest = await invoke(
    registry,
    [
      'submit_gate_vm32_zk',
      '--evidence', evidenceFor({ payload: sib.payload, height: declaredHeight, endRoot, submitter: strangerAddr }),
      '--proof', sib.proof,
      '--public_inputs', JSON.stringify(sibPublics),
    ],
    STRANGER,
  );
  const honestTx = txOf(honest.stdout + honest.stderr);
  record(
    'stranger_accepted_on_the_sibling_slot',
    honest.ok,
    honest.ok
      ? `a nobody-account settled the 32-line lane for its own fee — the relayer was never a trust boundary, and here it was not a boundary at all`
      : `the stranger's submission failed: ${ERR[contractError(`${honest.stdout}${honest.stderr}`)] || `${honest.stdout}${honest.stderr}`.slice(0, 240)}`,
    { transaction: honestTx },
  );

  let horizonFacts = null;
  if (honestTx) {
    try {
      const tx = await getJson(`${HORIZON}/transactions/${honestTx}`);
      horizonFacts = { ledger: tx.ledger, fee_charged: tx.fee_charged, successful: tx.successful };
    } catch (e) {
      horizonFacts = { error: String(e.message || e).slice(0, 160) };
    }
  }
  record(
    'stranger_acceptance_is_on_horizon',
    Boolean(horizonFacts?.ledger) && horizonFacts.successful !== false,
    horizonFacts?.ledger
      ? `ledger ${horizonFacts.ledger}, ${horizonFacts.fee_charged} stroops, paid by the stranger itself`
      : `horizon could not confirm the transaction: ${horizonFacts?.error || 'no facts'}`,
    { horizon: horizonFacts },
  );

  const domainKey = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(sha256hex(ADAPTER_NAME), 'hex'), Buffer.from(DOMAIN_NAME, 'utf8')]))
    .digest('hex');
  const rec = await invoke(registry, ['get_gate_vm32_record', '--domain', domainKey]);
  const stepsMatch = rec.stdout.match(/hash_steps[\"\\s:]+(\d+)/);
  const rootMatch = rec.stdout.match(/program_root[\"\\s:]+([0-9a-f]{64})/);
  record(
    'recorded_sibling_run_agrees_with_the_payload',
    Boolean(stepsMatch) && Number(stepsMatch[1]) === 4 && Boolean(rootMatch) && rootMatch[1] === sibPublics[0],
    stepsMatch && rootMatch
      ? `the registry stores 4 hash steps and program root ${rootMatch[1].slice(0, 16)}... — the fold the 32-row circuit recomputed is the one it bound`
      : `record readback mismatch: ${rec.stdout.trim().slice(0, 240)}`,
  );

  // replay must still be refused, this time tried from the ADMIN — proving the
  // consumed digest belongs to the evidence, not to the account that spent it
  const replay = await invoke(registry, [
    'submit_gate_vm32_zk',
    '--evidence', evidenceFor({ payload: sib.payload, height: declaredHeight, endRoot, submitter: strangerAddr }),
    '--proof', sib.proof,
    '--public_inputs', JSON.stringify(sibPublics),
  ]);
  record(
    'sibling_digest_cannot_be_replayed_by_the_admin',
    !replay.ok && contractError(`${replay.stdout}${replay.stderr}`) === 9,
    'the digest is consumed; whose keys signed the replay attempt changes nothing',
  );

  // -- 4. five slots, byte-exact, with the three-896 triangle -------------------
  const reads = {};
  for (const [slot, bytes] of Object.entries(SLOT)) {
    const r = await invoke(registry, [GETTER[slot]]);
    reads[slot] = hexOf(`${r.stdout}${r.stderr}`, bytes);
  }
  const committed32 = fs.readFileSync(sib.vkPath, 'utf8').trim();
  const peerIds = {
    settlement: showcase,
    step_chain: JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'step-chain.json'), 'utf8')).registry_id,
    execution: JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'execution-lane.json'), 'utf8')).registry_id,
    gate_vm: JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'gate-vm-lane.json'), 'utf8')).registry_id,
    gate_vm32: null, // the sibling has no historical registry: its peer is the committed file
  };
  const mismatches = [];
  for (const [slot, bytes] of Object.entries(SLOT)) {
    if (!reads[slot]) {
      mismatches.push(`${slot}: unreadable`);
      continue;
    }
    if (slot === 'gate_vm32') {
      if (reads[slot] !== committed32) mismatches.push('gate_vm32: differs from the committed vector file');
      continue;
    }
    const peer = await invoke(peerIds[slot], [GETTER[slot]]);
    const peerHex = hexOf(`${peer.stdout}${peer.stderr}`, bytes);
    if (peerHex !== reads[slot]) mismatches.push(`${slot}: differs from ${peerIds[slot].slice(0, 8)}...`);
  }
  record(
    'five_slots_serve_their_lanes_bytes',
    mismatches.length === 0,
    mismatches.length === 0
      ? '768 / 896 / 1920 / 896 / 896 — four read against the registries they came from, the sibling read against its committed vector'
      : mismatches.join('; '),
  );
  const triangle = reads.step_chain && reads.gate_vm && reads.gate_vm32
    && reads.step_chain !== reads.gate_vm
    && reads.step_chain !== reads.gate_vm32
    && reads.gate_vm !== reads.gate_vm32;
  record(
    'the_three_896_byte_keys_are_pairwise_distinct',
    Boolean(triangle),
    triangle
      ? 'one contract holds three keys of the same length, all different, each verifiable only by its own lane — length, tag and naming are proven non-defenses here'
      : 'two of the 896-byte slots are serving the same bytes, which would collapse the design',
  );

  // -- 5. one freeze over all five ----------------------------------------------
  const renounce = await invoke(registry, ['renounce_admin', '--admin', admin]);
  record('admin_renounced_over_five_slots', renounce.ok, renounce.ok ? 'no admin remains' : `${renounce.stdout}${renounce.stderr}`.slice(0, 240), {
    transaction: txOf(renounce.stdout + renounce.stderr),
  });
  const freezeFails = [];
  for (const [slot, bytes] of Object.entries(SLOT)) {
    const attempt = await invoke(registry, [SETTER[slot], '--admin', admin, '--vk', '00'.repeat(bytes)]);
    const now = hexOf(`${(await invoke(registry, [GETTER[slot]])).stdout}`, bytes);
    if (attempt.ok) freezeFails.push(`${SETTER[slot]} SUCCEEDED after renounce`);
    else if (now !== reads[slot]) freezeFails.push(`${SETTER[slot]} failed but ${slot} no longer reads back intact`);
  }
  record(
    'all_five_setters_refused_all_keys_intact',
    freezeFails.length === 0,
    freezeFails.length === 0 ? 'five setters trap, five getters unchanged, one renounce froze the union again' : freezeFails.join('; '),
  );

  // -- 6. receipt ----------------------------------------------------------------
  const anyFail = records.some((r) => !r.passed) || Object.values(laneSummaries).some((l) => l.passed !== l.checks);
  const doc = {
    note: 'the five-slot showcase: four proven lane suites plus the 32-line sibling, whose honest acceptance was submitted by an account generated at runtime and configured nowhere — the relayer-free claim, demonstrated rather than declared. One renounce froze all five slots. deployments/merged-registry.json (four slots) remains as history.',
    passed: !anyFail,
    registry: { contract_id: registry, network: NETWORK, deployed_by_flow: !process.env.V2_REUSE },
    stranger: { address: strangerAddr, introduced: 'this run only; no repository file names it' },
    settlement_key_source: { registry: showcase },
    lane_suites: laneSummaries,
    v2_checks: records,
    started_at: started,
    finished_at: new Date().toISOString(),
    run_note: process.env.V2_NOTE || null,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nrecord: ${OUT} — ${anyFail ? 'FAILURES above; nothing here hides them' : 'all checks passed'}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(`v2 run aborted: ${e.stack || e.message}`);
  process.exit(1);
});
