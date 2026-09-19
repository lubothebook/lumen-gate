#!/usr/bin/env node
/**
 * Live probe for the gate-vm lane.
 *
 * The host tests prove that the gate-vm circuit and the contract's fourth
 * entrypoint agree in the Soroban test host. This proves the same against a
 * real network: a fresh registry, the honest proof accepted, every mutation
 * refused by the rule that is supposed to refuse it, and every verdict written
 * down with its transaction hash.
 *
 * What makes this lane different from the execution lane it sits beside: the
 * machine can hash (POSEIDON is an instruction), its program enters the proof
 * as a Poseidon-fold commitment rather than as published words, and the row
 * window is the gas. The probe below checks the properties this lane can fail
 * to have: root binding, the circuit-counted hash number, the tag, replay, and
 * the two freeze rules (wrong-length key, and anything after renounce).
 *
 * Checks, in order:
 *   1. bootstrap: registry, admitted domain, the 896-byte key in its own slot,
 *      and a 895-byte key refused without touching the stored one
 *   2. an honest run          -> ACCEPTED; the record read back carries the
 *      same hash count and the same program root the proof committed
 *   3. a rewritten program root in the payload  -> REFUSED (#5, binding)
 *   4. an inflated hash count in the payload    -> REFUSED (#6, no such trace)
 *   5. a swapped start/event public pair         -> REFUSED (#5, order is the
 *      contract's binding, and the pairing would refuse it too)
 *   6. the step-chain lane's tag in place of ours -> REFUSED (#5)
 *   7. proof one byte short                      -> REFUSED (#8)
 *   8. payload one byte short                    -> REFUSED (#11)
 *   9. replayed evidence                         -> REFUSED (#9)
 *  10. settlement anchors untouched after all of it
 *  11. renounce: the key is frozen; the same call traps afterwards
 *
 * Configuration (env):
 *   GATEVM_REGISTRY      existing registry id to probe   (default: deploy one)
 *   NETWORK              stellar network name            (default: testnet)
 *   STELLAR_SOURCE       stellar CLI identity            (default: audit-probe)
 *   BUILD_DIR            where circuit artifacts live    (default: build)
 *   GATEVM_OUT           where to write the record         (default:
 *                        deployments/gate-vm-lane.json)
 *   GATEVM_SKIP_RENOUNCE=1  leave the admin in place (for iterating)
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NETWORK = process.env.NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'audit-probe';
const BUILD = process.env.BUILD_DIR || path.join(ROOT, 'build');
const OUT = process.env.GATEVM_OUT || path.join(ROOT, 'deployments', 'gate-vm-lane.json');
const WASM = path.join(ROOT, 'target', 'wasm32v1-none', 'release', 'finality_registry.wasm');

const DOMAIN_NAME = process.env.DOMAIN || 'source-testnet';
const ADAPTER_NAME = process.env.GATEVM_ADAPTER || 'source-chain-bls-v1';

// sha256("lumen-gate-vm-v1")[0..31] as a field element -- the value the
// circuit asserts, the contract binds, and gate_vm's emitter writes into the
// witness. If these three ever disagree, this line disagrees with all of
// them and the honest submission fails loudly, which is the point.
const TAG_DEC =
  163132376849949675609651075788839912391573001044923200866693845321210504281n;
const PAYLOAD_BYTES = 144;

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

function sh(file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: 180000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

function contractError(text) {
  const match = text.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? Number(match[1]) : null;
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function u64le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer.toString('hex');
}

function u64be(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

/**
 * Artifacts come from the build directory when the pipeline has just been run
 * there, and otherwise from the copy committed under deployments/vectors/.
 * A live probe that only worked on the machine that ran the ceremony would be
 * a claim nobody else could re-check.
 */
function resolveArtifact(name) {
  const built = path.join(BUILD, name);
  return fs.existsSync(built)
    ? built
    : path.join(ROOT, 'deployments', 'vectors', 'gate_vm', name);
}

function readArtifacts() {
  const publicPath = resolveArtifact('gate_vm_public.json');
  const proofPath = resolveArtifact('gate_vm_proof.hex');
  const vkPath = resolveArtifact('gate_vm_vk.hex');
  for (const candidate of [publicPath, proofPath, vkPath]) {
    if (!fs.existsSync(candidate)) {
      console.error(`${candidate} is missing. Build the lane first:`);
      console.error('  cargo run -p gate_vm -- --emit-dir build --height 42');
      console.error('  PTAU_POWER=14 ./circuits/setup.sh gate_vm');
      console.error('  python3 circuits/convert_to_soroban.py build/gate_vm_vk.json \\');
      console.error('      build/gate_vm_proof.json build/gate_vm_public.json build/gate_vm');
      process.exit(2);
    }
  }
  const publicInputs = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
  const proof = fs.readFileSync(proofPath, 'utf8').trim();
  const vk = fs.readFileSync(vkPath, 'utf8').trim();
  if (publicInputs.length !== 6) {
    console.error(`expected 6 public inputs for the gate-vm circuit, got ${publicInputs.length}`);
    process.exit(2);
  }
  if (BigInt(publicInputs[5]) !== TAG_DEC) {
    console.error(`public input 5 is the tag ${publicInputs[5]}, the circuit compiles ${TAG_DEC}`);
    process.exit(2);
  }
  return { publicInputs, proof, vk, publicPath, proofPath, vkPath };
}

/**
 * The 144-byte payload, every field read back out of the proof's own public
 * inputs. Deriving it from the statement rather than a fixture file is what
 * makes any drift between them show up as a refusal, not as a stale manifest.
 */
function payloadFor(publicInputs, height, overrides = {}) {
  const parts = [
    u64le(height),
    u64be(overrides.programRoot !== undefined ? overrides.programRoot : publicInputs[0]),
    u64be(overrides.startRoot !== undefined ? overrides.startRoot : publicInputs[1]),
    u64be(overrides.eventRoot !== undefined ? overrides.eventRoot : publicInputs[2]),
    u64be(overrides.endRoot !== undefined ? overrides.endRoot : publicInputs[3]),
    u64le(overrides.hashSteps !== undefined ? overrides.hashSteps : publicInputs[4]),
  ];
  const hex = parts.join('');
  if (hex.length !== PAYLOAD_BYTES * 2) {
    console.error(`payload is ${hex.length / 2} bytes, the contract parses ${PAYLOAD_BYTES}`);
    process.exit(2);
  }
  return hex;
}

function evidenceFor(adapterId, payload, height, root, submitter) {
  return JSON.stringify({
    adapter_id: adapterId,
    evidence_version: 1,
    network: DOMAIN_NAME,
    payload,
    declared_height: height,
    declared_root: root,
    submitter,
  });
}

async function main() {
  const { publicInputs, proof, vk, publicPath, proofPath, vkPath } = readArtifacts();
  const records = [];
  const started = new Date().toISOString();

  const cliEnv = process.env.STELLAR_CONFIG_DIR ? { STELLAR_CONFIG_DIR: process.env.STELLAR_CONFIG_DIR } : {};
  const admin = (await sh('stellar', ['keys', 'address', SOURCE], cliEnv)).stdout.trim();
  if (!/^G[A-Z0-9]{55}$/.test(admin)) {
    console.error(`could not resolve the signing address for identity ${SOURCE}`);
    process.exit(2);
  }

  const invoke = (id, args) =>
    sh('stellar', ['contract', 'invoke', '--id', id, '--source', SOURCE, '--network', NETWORK, '--', ...args], cliEnv);
  const readOnly = (id, args) => invoke(id, args);

  let registry = process.env.GATEVM_REGISTRY || '';
  let deployed = false;
  if (!registry) {
    if (!fs.existsSync(WASM)) {
      console.error(`${WASM} is missing. Build it first: stellar contract build`);
      process.exit(2);
    }
    console.log('deploying a fresh registry for the gate-vm lane...');
    const result = await sh('stellar', ['contract', 'deploy', '--wasm', WASM, '--source', SOURCE, '--network', NETWORK], cliEnv);
    registry = result.stdout.trim().split('\n').pop().trim();
    if (!/^C[A-Z0-9]{55}$/.test(registry)) {
      console.error(`deployment did not return a contract id: ${result.stdout}${result.stderr}`);
      process.exit(2);
    }
    deployed = true;
    console.log(`registry: ${registry}`);
  }

  const record = (check, passed, detail, extra = {}) => {
    records.push({ check, passed, detail, at: new Date().toISOString(), ...extra });
    console.log(`  [${passed ? 'pass' : 'FAIL'}] ${check}\n         ${detail}`);
  };
  const txOf = (text) => (text.match(/tx\/([0-9a-f]{64})/) || [])[1] || null;

  // -- 1. bootstrap ---------------------------------------------------------
  await invoke(registry, ['initialize', '--admin', admin]);
  const adapterId = sha256hex(ADAPTER_NAME);
  await invoke(registry, [
    'register_domain',
    '--admin', admin,
    '--adapter_id', adapterId,
    '--network', DOMAIN_NAME,
    '--required_depth', '2',
    '--adapter_version', '1',
    '--accepted_versions', '[1]',
  ]);
  const domainKey = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(adapterId, 'hex'), Buffer.from(DOMAIN_NAME, 'utf8')]))
    .digest('hex');
  await invoke(registry, ['admit_domain', '--admin', admin, '--domain', domainKey]);

  if (vk.length !== 896 * 2) {
    console.error(`the gate-vm key must be 896 bytes (${896 * 2} hex chars), got ${vk.length}`);
    process.exit(2);
  }
  const setKey = await invoke(registry, ['set_gate_vm_vk', '--admin', admin, '--vk', vk]);
  record(
    'gate_vm_key_accepted_at_896_bytes',
    setKey.ok,
    setKey.ok
      ? 'set_gate_vm_vk stored the 896-byte key (64 + 3x128 + 7x64) in its own slot'
      : `set_gate_vm_vk failed: ${setKey.stdout}${setKey.stderr}`.slice(0, 300),
    { transaction: txOf(setKey.stdout + setKey.stderr) },
  );

  const shortKey = vk.slice(0, vk.length - 2);
  const badKey = await invoke(registry, ['set_gate_vm_vk', '--admin', admin, '--vk', shortKey]);
  const keyAfterRefusal = (await readOnly(registry, ['get_gate_vm_vk'])).stdout.trim();
  record(
    'gate_vm_key_of_the_wrong_length_refused',
    !badKey.ok && keyAfterRefusal.includes(vk.slice(0, 64)),
    !badKey.ok && keyAfterRefusal.includes(vk.slice(0, 64))
      ? 'an 895-byte key was refused and the stored key is unchanged'
      : !badKey.ok
        ? 'the short key was refused, but the stored key changed: a refused write must not be a partial one'
        : 'an 895-byte key was ACCEPTED, which means the length rule is not enforced',
    { output: `${badKey.stdout}${badKey.stderr}`.trim().slice(0, 400) },
  );

  // -- 2. the honest run -----------------------------------------------------
  const honestHeight = Number(process.env.GATEVM_HEIGHT || 1);
  const honestPayload = payloadFor(publicInputs, honestHeight);
  const honestEvidence = evidenceFor(adapterId, honestPayload, honestHeight, u64be(publicInputs[3]), admin);

  const accepted = await invoke(registry, [
    'submit_gate_vm_zk',
    '--evidence', honestEvidence,
    '--proof', proof,
    '--public_inputs', JSON.stringify(publicInputs.map((value) => u64be(value))),
  ]);
  const acceptedError = contractError(`${accepted.stdout}${accepted.stderr}`);
  record(
    'honest_gate_vm_run_accepted',
    accepted.ok,
    accepted.ok
      ? `the network accepted the gate-vm proof: ${publicInputs[4]} hash steps in an 8-row window, ` +
        `start ${BigInt(publicInputs[1])} -> end ${BigInt(publicInputs[3])} under a committed program`
      : `the honest run was refused: ${
          acceptedError !== null ? `error #${acceptedError} ${ERR[acceptedError] || ''}` : `${accepted.stdout}${accepted.stderr}`.slice(0, 300)
        }`,
    {
      output: `${accepted.stdout}${accepted.stderr}`.trim().slice(0, 900),
      transaction: txOf(accepted.stdout + accepted.stderr),
    },
  );

  const recordedRun = await readOnly(registry, ['get_gate_vm_record', '--domain', domainKey]);
  const stepsMatch = recordedRun.stdout.match(/hash_steps["\s:]+(\d+)/);
  const rootMatch = recordedRun.stdout.match(/program_root["\s:]+([0-9a-f]{64})/);
  record(
    'recorded_run_agrees_with_the_payload',
    Boolean(stepsMatch) && Boolean(rootMatch) &&
      Number(stepsMatch[1]) === Number(publicInputs[4]) &&
      rootMatch[1] === u64be(publicInputs[0]),
    stepsMatch && rootMatch
      ? `recorded ${stepsMatch[1]} hash steps and program root ${rootMatch[1].slice(0, 16)}... — ` +
        `the fold the circuit computed and the registry bound are the same 32 bytes`
      : `could not read the record back: ${recordedRun.stdout}${recordedRun.stderr}`.slice(0, 300),
    { output: recordedRun.stdout.trim() },
  );

  // -- 3..8. refusals --------------------------------------------------------
  const probes = [
    {
      name: 'a_rewritten_program_root',
      height: honestHeight + 1,
      payload: () => payloadFor(publicInputs, honestHeight + 1, { programRoot: BigInt(publicInputs[0]) + 1n }),
      expect: 5,
      why: 'the payload claims a different program than the proof commits: binding refuses it before any pairing',
    },
    {
      name: 'an_inflated_hash_count',
      height: honestHeight + 2,
      payload: () => payloadFor(publicInputs, honestHeight + 2, { hashSteps: 9n }),
      expect: 6,
      why: 'no trace of an 8-row window can count 9 hash steps; the bound is refused as a format error',
    },
    {
      name: 'swapped_start_and_event_publics',
      height: honestHeight + 3,
      publics: (inputs) => [inputs[0], inputs[2], inputs[1], inputs[3], inputs[4], inputs[5]],
      expect: 5,
      why: 'both are roots; only position tells them apart, and position is exactly what the contract binds',
    },
    {
      name: 'the_step_chain_lanes_tag',
      height: honestHeight + 4,
      publics: (inputs) => [inputs[0], inputs[1], inputs[2], inputs[3], inputs[4], BigInt('0x009517e443e84062a6781b2a92160d0a325f4c5a45826a0c0b54644e2ed574f0')],
      expect: 5,
      why: 'a proof that means another lane must not verify on this one, even where every other number agrees',
    },
    {
      name: 'proof_one_byte_short',
      height: honestHeight + 5,
      proof: (bytes) => bytes.slice(0, bytes.length - 2),
      expect: 8,
      why: 'the length is checked before any decoding, so a short proof cannot be sliced into coordinates',
    },
    {
      name: 'payload_one_byte_short',
      height: honestHeight + 6,
      payload: () => payloadFor(publicInputs, honestHeight + 6).slice(0, -2),
      expect: 11,
      why: 'a payload of the wrong length is a format error, refused before anything is parsed out of it',
    },
  ];

  for (const probe of probes) {
    const payload = probe.payload ? probe.payload() : payloadFor(publicInputs, probe.height);
    const probeProof = probe.proof ? probe.proof(proof) : proof;
    const probePublics = (probe.publics ? probe.publics(publicInputs) : publicInputs).map((value) => u64be(value));
    const declaredRoot = u64be(probe.publics ? probe.publics(publicInputs)[3] : publicInputs[3]);
    const evidence = evidenceFor(adapterId, payload, probe.height, declaredRoot, admin);
    const result = await invoke(registry, [
      'submit_gate_vm_zk',
      '--evidence', evidence,
      '--proof', probeProof,
      '--public_inputs', JSON.stringify(probePublics),
    ]);
    const error = contractError(`${result.stdout}${result.stderr}`);
    record(
      `${probe.name}_is_refused`,
      !result.ok && error === probe.expect,
      !result.ok
        ? `${probe.why} (refused with #${error} ${ERR[error] || 'unmapped'})`
        : `the probe was ACCEPTED, so this rule is not enforced: ${probe.why}`,
      { output: `${result.stdout}${result.stderr}`.trim().slice(0, 400), error_code: error },
    );
  }

  {
    const replay = await invoke(registry, [
      'submit_gate_vm_zk',
      '--evidence', honestEvidence,
      '--proof', proof,
      '--public_inputs', JSON.stringify(publicInputs.map((value) => u64be(value))),
    ]);
    const error = contractError(`${replay.stdout}${replay.stderr}`);
    record(
      'the_same_evidence_cannot_be_submitted_twice',
      !replay.ok && error === 9,
      !replay.ok
        ? 'the evidence digest has already been consumed (refused with #9 EvidenceAlreadyProcessed)'
        : 'a replay was ACCEPTED',
      { output: `${replay.stdout}${replay.stderr}`.trim().slice(0, 300), error_code: error },
    );
  }

  // -- 10. the settlement anchor is untouched --------------------------------
  {
    const domain = await readOnly(registry, ['get_domain', '--domain', domainKey]);
    const machineApproved = await readOnly(registry, ['is_machine_approved', '--domain', domainKey]);
    const rootsUntouched =
      /last_root["\s:]+(0{64})/.test(domain.stdout.replace(/\s/g, ' ')) ||
      !/last_root/.test(domain.stdout);
    record(
      'settlement_anchors_are_untouched',
      rootsUntouched && /false/.test(machineApproved.stdout),
      rootsUntouched && /false/.test(machineApproved.stdout)
        ? 'the domain still anchors on nothing and is_machine_approved is still false: a run proof is not a chain root, and the storage layout keeps them apart'
        : `the gate-vm lane moved state it must not move: domain=${domain.stdout.trim()} approved=${machineApproved.stdout.trim()}`.slice(0, 400),
      { output: domain.stdout.trim() },
    );
  }

  // -- 11. the admin capability ----------------------------------------------
  if (process.env.GATEVM_SKIP_RENOUNCE === '1') {
    record('admin_renounced', true, 'skipped by GATEVM_SKIP_RENOUNCE=1; this run proves nothing about the renounce', { skipped: true });
  } else {
    const renounce = await invoke(registry, ['renounce_admin', '--admin', admin]);
    record(
      'admin_renounced',
      renounce.ok,
      renounce.ok
        ? 'the admin capability was given up, so no operator key can change any of the four verification keys'
        : `renounce failed: ${renounce.stdout}${renounce.stderr}`.slice(0, 300),
      { output: `${renounce.stdout}${renounce.stderr}`.trim().slice(0, 400), transaction: txOf(renounce.stdout + renounce.stderr) },
    );

    const afterRenounce = await invoke(registry, ['set_gate_vm_vk', '--admin', admin, '--vk', vk]);
    const keyAfterRenounce = (await readOnly(registry, ['get_gate_vm_vk'])).stdout.trim();
    record(
      'key_cannot_be_replaced_after_renounce',
      !afterRenounce.ok && keyAfterRenounce.includes(vk.slice(0, 64)),
      !afterRenounce.ok && keyAfterRenounce.includes(vk.slice(0, 64))
        ? "the gate-vm lane's key is as frozen as the other three: the call traps and the stored key is unchanged"
        : `the call should have trapped; it ${afterRenounce.ok ? 'succeeded' : 'failed for another reason'} and the stored key ${keyAfterRenounce.includes(vk.slice(0, 64)) ? 'is' : 'is NOT'} the accepted one`,
      { output: `${afterRenounce.stdout}${afterRenounce.stderr}`.trim().slice(0, 400) },
    );
  }

  // -- write the record --------------------------------------------------------
  const passed = records.filter((row) => row.passed).length;
  const output = {
    lane: 'gate vm',
    circuit: 'circuits/gate_vm.circom',
    entrypoint: 'submit_gate_vm_zk',
    network: NETWORK,
    registry_id: registry,
    registry_deployed_this_run: deployed,
    signer: admin,
    adapter_id: adapterId,
    domain_key: domainKey,
    circuit_public_inputs: publicInputs,
    artifacts: {
      public_inputs: path.relative(ROOT, publicPath),
      proof: path.relative(ROOT, proofPath),
      vk: path.relative(ROOT, vkPath),
    },
    checks_total: records.length,
    checks_passed: passed,
    started_at: started,
    finished_at: new Date().toISOString(),
    records,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
  console.log(`\n${passed}/${records.length} checks passed; record written to ${path.relative(ROOT, OUT)}`);
  if (passed !== records.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
