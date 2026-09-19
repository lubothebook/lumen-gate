#!/usr/bin/env node
/*
 * merge-lanes-live.js — one registry, every lane, then the key is frozen.
 *
 * Each lane was proven live on a registry of its own, because proving a lane
 * means being able to start from nothing. This tool asks the question the
 * per-lane runs cannot: do the four lanes coexist in one contract without
 * weakening each other? It deploys a fresh registry, runs the three full
 * lane probe suites against it (step-chain, execution, gate-vm — the real
 * tools, their real 14-16 probes each, with the renounce step deferred),
 * copies the settlement lane's live verification key from the current
 * showcase registry into the merged one's slot, reads all four keys back
 * byte for byte, and only then renounces — so the freeze is proven over the
 * union, not over four fragments.
 *
 * The checks that only this shape can make are pinned explicitly:
 *   - the two 896-byte keys (step-chain and gate-vm) sit side by side and
 *     stay distinct: equal length, different bytes, each in its own slot —
 *     the slot plus the pairing equation, not the length, is what tells the
 *     lanes apart, and a single registry is where that design earns its keep;
 *   - one renounce freezes all four slots: every setter traps afterwards and
 *     every getter still serves the same bytes it served before;
 *   - the lanes' height counters do not collide, because no lane's accept
 *     moves the settlement anchor: last_finalized belongs to the settlement
 *     path and the audit loop proved that isolation per lane — the merged run
 *     re-proves it where it matters, with all four lanes writing to one
 *     domain record.
 *
 * It mutates nothing that is already frozen: only registries this run
 * deployed, and it reads the live showcase registry read-only (get_vk).
 * No source chain traffic is needed; every payload is built from committed
 * or built artifacts. Receipts: the lane tools write their own records
 * (redirected under build/, because their deployments/ files are the
 * historical per-lane evidence, not scratch), and this tool writes
 * deployments/merged-registry.json with the merged facts.
 *
 * Env:
 *   STELLAR_SOURCE   signing identity               (default: audit-probe)
 *   NETWORK          horizon network                (default: testnet)
 *   MERGE_REUSE      existing fresh registry id     (default: deploy one)
 *   MERGE_OUT        record path                    (default: deployments/merged-registry.json)
 */

const { execFile, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NETWORK = process.env.NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'audit-probe';
const BUILD = process.env.BUILD_DIR || path.join(ROOT, 'build');
const OUT = process.env.MERGE_OUT || path.join(ROOT, 'deployments', 'merged-registry.json');
const WASM = path.join(ROOT, 'target', 'wasm32v1-none', 'release', 'finality_registry.wasm');
const DOMAIN_NAME = process.env.DOMAIN || 'source-testnet';

// hex lengths of the four slot keys, in bytes
const SLOT = { settlement: 768, step_chain: 896, execution: 1920, gate_vm: 896 };

function sh(file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

const cliEnv = () => (process.env.STELLAR_CONFIG_DIR ? { STELLAR_CONFIG_DIR: process.env.STELLAR_CONFIG_DIR } : {});

function hexOf(text, bytes) {
  const m = text.match(new RegExp(`[0-9a-f]{${bytes * 2}}`));
  return m ? m[0] : null;
}

async function main() {
  const records = [];
  const started = new Date().toISOString();
  const record = (check, passed, detail, extra = {}) => {
    records.push({ check, passed, detail, at: new Date().toISOString(), ...extra });
    console.log(`  [${passed ? 'pass' : 'FAIL'}] ${check}\n         ${detail}`);
  };
  const txOf = (text) => (text.match(/tx\/([0-9a-f]{64})/) || [])[1] || null;

  const admin = (await sh('stellar', ['keys', 'address', SOURCE], cliEnv())).stdout.trim();
  if (!/^G[A-Z0-9]{55}$/.test(admin)) {
    console.error(`could not resolve the signing address for identity ${SOURCE}`);
    process.exit(2);
  }
  const invoke = (id, args) =>
    sh('stellar', ['contract', 'invoke', '--id', id, '--source', SOURCE, '--network', NETWORK, '--', ...args], cliEnv());

  // -- 0. the source of the settlement key: read it from the live showcase ----
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
  const showcase =
    manifest?.contracts?.finality_registry?.contract_id ||
    (typeof manifest?.contracts?.finality_registry === 'string' ? manifest.contracts.finality_registry : '');
  if (!/^C[A-Z0-9]{55}$/.test(showcase)) {
    console.error('could not read a contract id from deployments/testnet.json (read it programmatically — never from a truncated log line)');
    process.exit(2);
  }
  const liveKey = await invoke(showcase, ['get_vk']);
  const settlementVk = hexOf(`${liveKey.stdout}${liveKey.stderr}`, SLOT.settlement);
  if (!settlementVk) {
    console.error(`could not read the settlement verification key from ${showcase}`);
    process.exit(2);
  }

  // -- 1. the fresh registry ---------------------------------------------------
  let registry = process.env.MERGE_REUSE || '';
  if (!registry) {
    if (!fs.existsSync(WASM)) {
      console.error(`${WASM} is missing. Build it first: stellar contract build`);
      process.exit(2);
    }
    console.log('deploying the merged registry...');
    const result = await sh('stellar', ['contract', 'deploy', '--wasm', WASM, '--source', SOURCE, '--network', NETWORK], cliEnv());
    registry = result.stdout.trim().split('\n').pop().trim();
    if (!/^C[A-Z0-9]{55}$/.test(registry)) {
      console.error(`deployment did not return a contract id: ${result.stdout}${result.stderr}`);
      process.exit(2);
    }
  }
  console.log(`merged registry: ${registry}`);

  // -- 2. the three full lane suites, deferred-renounce, against this one id ---
  const lanes = [
    { tool: 'step-chain-live.js', registryEnv: 'STEP_CHAIN_REGISTRY', outEnv: 'STEP_CHAIN_OUT', skipEnv: 'STEP_CHAIN_SKIP_RENOUNCE', record: 'step-chain-merged.json' },
    { tool: 'execution-lane-live.js', registryEnv: 'EXECUTION_REGISTRY', outEnv: 'EXECUTION_OUT', skipEnv: 'EXECUTION_SKIP_RENOUNCE', record: 'execution-merged.json' },
    { tool: 'gate-vm-lane-live.js', registryEnv: 'GATEVM_REGISTRY', outEnv: 'GATEVM_OUT', skipEnv: 'GATEVM_SKIP_RENOUNCE', record: 'gate-vm-merged.json' },
  ];
  const laneDir = path.join(BUILD, 'merged-lane');
  fs.mkdirSync(laneDir, { recursive: true });
  const laneSummaries = {};
  for (const lane of lanes) {
    console.log(`running ${lane.tool} against ${registry} ...`);
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
    const outPath = path.join(laneDir, lane.record);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {
      /* reported as a failure below, with the tail of the child's output */
    }
    // the lane tools do not agree on a record schema (step-chain and execution
    // write {checks}, gate-vm writes {records} with sibling counters) — the
    // reader accepts every shape rather than silently reading zeros, and a
    // record that matches none of them is reported as what it is: unusable.
    const checks = parsed?.checks || parsed?.records || [];
    const passed = checks.length
      ? checks.filter((c) => c.passed).length
      : parsed?.checks_passed;
    const total = checks.length || parsed?.checks_total;
    const allPassed = checks.length ? passed === checks.length : parsed?.all_passed;
    laneSummaries[lane.record.replace('-merged.json', '')] = {
      checks: total,
      passed,
      honest_transaction: checks.find((c) => /honest/.test(c.check))?.transaction || null,
    };
    record(
      `${lane.tool}_suite_on_shared_registry`,
      run.status === 0 && Number(total) > 0 && allPassed === true,
      checks.length
        ? `${passed}/${checks.length} checks passed in the lane's own record`
        : `no usable record from ${outPath}; child tail: ${`${run.stdout || ''}${run.stderr || ''}`.slice(-300)}`,
    );
  }

  // -- 3. the settlement slot, copied from the live registry --------------------
  const setKey = await invoke(registry, ['set_vk', '--admin', admin, '--vk', settlementVk]);
  record(
    'settlement_key_installed_from_the_live_registrys_bytes',
    setKey.ok,
    setKey.ok
      ? `set_vk accepted the 768-byte key exactly as ${showcase.slice(0, 6)}... serves it (sha256 ${crypto.createHash('sha256').update(settlementVk).digest('hex').slice(0, 16)}...)`
      : `set_vk failed: ${`${setKey.stdout}${setKey.stderr}`.slice(0, 300)}`,
    { transaction: txOf(setKey.stdout + setKey.stderr) },
  );

  // -- 4. the checks only a merged registry can make ---------------------------
  const reads = {};
  for (const [slot, bytes] of Object.entries(SLOT)) {
    const getter = { settlement: 'get_vk', step_chain: 'get_step_chain_vk', execution: 'get_execution_vk', gate_vm: 'get_gate_vm_vk' }[slot];
    const r = await invoke(registry, [getter]);
    reads[slot] = hexOf(`${r.stdout}${r.stderr}`, bytes);
  }
  const allServed = Object.values(reads).every(Boolean);
  record(
    'all_four_slots_serve_keys_of_their_own_sizes',
    allServed,
    allServed
      ? `768, 896, 1920 and 896 bytes read back from four slots of one contract`
      : `a slot returned nothing readable: ${JSON.stringify(Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, v ? 'ok' : 'missing'])))}`,
  );
  const distinct = allServed && reads.step_chain !== reads.gate_vm;
  record(
    'the_two_896_byte_keys_are_distinct_and_each_in_its_own_slot',
    distinct,
    distinct
      ? 'equal length, different bytes, both served by the contract that must never confuse them — this is the shape that makes "no lane can impersonate another" testable at all'
      : 'the step-chain and gate-vm slots are not holding different keys',
  );

  const domainKey = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(crypto.createHash('sha256').update('source-chain-bls-v1').digest('hex'), 'hex'), Buffer.from(DOMAIN_NAME, 'utf8')]))
    .digest('hex');
  const domain = await invoke(registry, ['get_domain', '--domain', domainKey]);
  const lastRootZero = !/last_root/.test(domain.stdout) || /last_root["\s:]+0{64}/.test(domain.stdout.replace(/\s/g, ' '));
  record(
    'lanes_never_moved_the_settlement_anchor',
    domain.ok && lastRootZero,
    lastRootZero
      ? 'after three lanes wrote records to the same domain key, last_root is still zero: storage isolation holds where all four lanes coexist'
      : `a lane moved anchor state on the shared registry: ${domain.stdout.trim().slice(0, 300)}`,
  );

  // -- 5. one renounce freezes the union ---------------------------------------
  const renounce = await invoke(registry, ['renounce_admin', '--admin', admin]);
  record('admin_renounced_over_all_slots', renounce.ok, renounce.ok ? 'the merged registry has no admin' : `${renounce.stdout}${renounce.stderr}`.slice(0, 300), {
    transaction: txOf(renounce.stdout + renounce.stderr),
  });

  for (const [slot, setter] of Object.entries({ settlement: 'set_vk', step_chain: 'set_step_chain_vk', execution: 'set_execution_vk', gate_vm: 'set_gate_vm_vk' })) {
    const attempt = await invoke(registry, [setter, '--admin', admin, '--vk', '00'.repeat(SLOT[slot])]);
    const reread = await invoke(registry, [{ settlement: 'get_vk', step_chain: 'get_step_chain_vk', execution: 'get_execution_vk', gate_vm: 'get_gate_vm_vk' }[slot]]);
    const now = hexOf(`${reread.stdout}${reread.stderr}`, SLOT[slot]);
    record(
      `after_renounce_${slot}_key_is_frozen`,
      !attempt.ok && now === reads[slot],
      !attempt.ok && now === reads[slot]
        ? `${setter} traps and the stored bytes are unchanged (${SLOT[slot]} bytes still exact)`
        : attempt.ok
          ? `${setter} SUCCEEDED after the renounce — the freeze is not real`
          : `${setter} failed for another reason and the key did not read back intact (${now ? 'bytes differ' : 'unreadable'})`,
    );
  }

  // -- 6. the record -------------------------------------------------------------
  const anyFail =
    records.some((r) => !r.passed) ||
    Object.values(laneSummaries).some((l) => !Number.isFinite(l.checks) || l.passed !== l.checks);
  const doc = {
    note: 'one registry carrying all four lane slots: three full per-lane probe suites run against it, the settlement key copied from the live showcase registry, four slots proven distinct, then a single renounce freezes the union. This file is a receipt written by tools/merge-lanes-live.js; the lanes keep their own historical per-lane records beside it.',
    passed: !anyFail,
    registry: { contract_id: registry, network: NETWORK, deployed_by_flow: !process.env.MERGE_REUSE },
    run_note: process.env.MERGE_NOTE || null,
    settlement_key_source: { registry: showcase, sha256_of_hex: crypto.createHash('sha256').update(settlementVk).digest('hex') },
    lane_suites: laneSummaries,
    merged_checks: records,
    started_at: started,
    finished_at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nrecord: ${OUT} — ${anyFail ? 'FAILURES above; nothing here hides them' : 'all merged checks passed'}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(`merge run aborted: ${e.stack || e.message}`);
  process.exit(1);
});
