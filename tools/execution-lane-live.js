#!/usr/bin/env node
/**
 * Live probe for the execution lane.
 *
 * The host tests prove that the trace circuit and the contract's execution
 * entrypoint agree in the Soroban test host. This proves the same thing against
 * a real network: the proof is submitted to a deployed registry, the network
 * charges for it, and every verdict is written down with its transaction hash
 * so nobody has to take a summary's word for it.
 *
 * The lane it exercises is the third proof lane, added beside the other two. It
 * is additive by construction: it records accepted executions in its own
 * storage slot, and it never touches the roots the settlement path anchors on.
 *
 * What it checks, in order:
 *   1. bootstrap: a registry, one admitted domain, and the 1920-byte key in its
 *      own slot
 *   2. an honest execution     -> ACCEPTED, and the record read back off-chain
 *      carries the same step count, gas and program digest the payload named
 *   3. a different program     -> REFUSED (the statement is about *this* program)
 *   4. a rewritten step count  -> REFUSED (the count is bound to the public input)
 *   5. a swapped proof         -> REFUSED (only the pairing equation can tell)
 *   6. a short payload         -> REFUSED (the length rule, before any parsing)
 *   7. instructions in padding -> REFUSED (the slots past the code must be halts)
 *   8. replayed evidence       -> REFUSED (the digest has already been consumed)
 *   9. the settlement anchor is untouched: an execution proof moves no root
 *  10. renounce: the admin capability is given up, and the lane's key cannot be
 *      replaced afterwards
 *
 * Configuration (env):
 *   EXECUTION_REGISTRY   existing registry id to probe   (default: deploy a fresh one)
 *   NETWORK              stellar network name            (default: testnet)
 *   STELLAR_SOURCE       stellar CLI identity            (default: audit-probe)
 *   BUILD_DIR            where circuit artifacts live    (default: build)
 *   EXECUTION_OUT        where to write the record       (default: deployments/execution-lane.json)
 *   EXECUTION_SKIP_RENOUNCE=1  leave the admin in place (useful while iterating)
 *   STELLAR_CONFIG_DIR   config dir for the CLI identity
 *
 * Usage:
 *   node tools/execution-lane-live.js                       # fresh registry, full run
 *   EXECUTION_REGISTRY=C... node tools/execution-lane-live.js   # re-probe an existing one
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NETWORK = process.env.NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'audit-probe';
const BUILD = process.env.BUILD_DIR || path.join(ROOT, 'build');
const OUT = process.env.EXECUTION_OUT || path.join(ROOT, 'deployments', 'execution-lane.json');
const WASM = path.join(ROOT, 'target', 'wasm32v1-none', 'release', 'finality_registry.wasm');

const DOMAIN_NAME = process.env.DOMAIN || 'source-testnet';
const ADAPTER_NAME = process.env.EXECUTION_ADAPTER || 'source-chain-bls-v1';

const TAG = 366332086174773927684157067308717544951988300004818040487599723223305911732n;
const PROGRAM_WORDS = 16;
const PAYLOAD_BYTES = 232;

// The contract's error table, by number. A probe that only says "refused" would
// not distinguish a refusal by the right rule from a refusal by a typo.
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
 * there, and otherwise from the copy committed under circuits/. A live probe
 * that only worked on the machine that ran the ceremony would be a claim nobody
 * else could re-check, which is the opposite of the point.
 */
function resolveArtifact(name) {
  const built = path.join(BUILD, name);
  return fs.existsSync(built) ? built : path.join(ROOT, 'circuits', name);
}

function readArtifacts() {
  const publicPath = resolveArtifact('execution_trace_public.json');
  const proofPath = resolveArtifact('execution_trace_proof.hex');
  const vkPath = resolveArtifact('execution_trace_vk.hex');
  for (const candidate of [publicPath, proofPath, vkPath]) {
    if (!fs.existsSync(candidate)) {
      console.error(`${candidate} is missing. Build the lane first:`);
      console.error('  ./circuits/build.sh execution_trace');
      console.error('  PTAU_POWER=14 node tools/execution-lane-input.mjs --out build/execution_trace_input.json');
      console.error('  PTAU_POWER=14 ./circuits/setup.sh execution_trace');
      console.error('  python3 circuits/convert_to_soroban.py build/execution_trace_vk.json \\');
      console.error('      build/execution_trace_proof.json build/execution_trace_public.json \\');
      console.error('      circuits/execution_trace --expect-inputs 22');
      process.exit(2);
    }
  }
  const publicInputs = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
  const proof = fs.readFileSync(proofPath, 'utf8').trim();
  const vk = fs.readFileSync(vkPath, 'utf8').trim();
  if (publicInputs.length !== 22) {
    console.error(`expected 22 public inputs for the trace circuit, got ${publicInputs.length}`);
    process.exit(2);
  }
  if (BigInt(publicInputs[21]) !== TAG) {
    console.error(`public input 21 is the tag ${BigInt(publicInputs[21])}, the circuit compiles ${TAG}`);
    process.exit(2);
  }
  return { publicInputs, proof, vk };
}

/**
 * The program the circuit proved, read back out of its own public inputs: the
 * sixteen words are inputs 0..15, eight bytes each. Deriving the payload from
 * the proof's own statement rather than from a fixture file is what makes a
 * drift between them show up as a refusal instead of as a stale manifest.
 */
function programFromInputs(publicInputs) {
  const words = [];
  for (let index = 0; index < PROGRAM_WORDS; index += 1) {
    words.push(BigInt(publicInputs[index]));
  }
  return words;
}

function instructionWordsFromProgram(program) {
  // the slots past the code are halt words, which are zero
  let lastNonZero = 0;
  program.forEach((word, index) => {
    if (word !== 0n) lastNonZero = index + 1;
  });
  return lastNonZero;
}

/** The 232-byte payload, every field derived from the circuit's public inputs. */
function payloadFor(publicInputs, height, overrides = {}) {
  const program = overrides.program || programFromInputs(publicInputs);
  const parts = [
    u64le(height),
    u64be(overrides.stateRoot !== undefined ? overrides.stateRoot : publicInputs[17]),
    u64be(overrides.initialRoot !== undefined ? overrides.initialRoot : publicInputs[16]),
    u64le(overrides.finalPc !== undefined ? overrides.finalPc : publicInputs[18]),
    u64le(overrides.stepsExecuted !== undefined ? overrides.stepsExecuted : publicInputs[19]),
    u64le(overrides.gasUsed !== undefined ? overrides.gasUsed : publicInputs[20]),
    u64le(overrides.instructionWords !== undefined ? overrides.instructionWords : instructionWordsFromProgram(programFromInputs(publicInputs))),
    ...program.map((word) => u64le(word)),
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
  const { publicInputs, proof, vk } = readArtifacts();
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

  let registry = process.env.EXECUTION_REGISTRY || '';
  let deployed = false;
  if (!registry) {
    if (!fs.existsSync(WASM)) {
      console.error(`${WASM} is missing. Build it first: stellar contract build`);
      process.exit(2);
    }
    console.log('deploying a fresh registry for the execution lane...');
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

  if (vk.length !== 1920 * 2) {
    console.error(`the execution key must be 1920 bytes (${1920 * 2} hex chars), got ${vk.length}`);
    process.exit(2);
  }
  const setKey = await invoke(registry, ['set_execution_vk', '--admin', admin, '--vk', vk]);
  record(
    'execution_key_accepted_at_1920_bytes',
    setKey.ok,
    setKey.ok
      ? 'set_execution_vk stored the 1920-byte key (64 + 3x128 + 23x64) in its own slot'
      : `set_execution_vk failed: ${setKey.stdout}${setKey.stderr}`.slice(0, 300),
    { transaction: txOf(setKey.stdout + setKey.stderr) },
  );

  const shortKey = vk.slice(0, vk.length - 2);
  const badKey = await invoke(registry, ['set_execution_vk', '--admin', admin, '--vk', shortKey]);
  const keyAfterRefusal = (await readOnly(registry, ['get_execution_vk'])).stdout.trim();
  record(
    'execution_key_of_the_wrong_length_refused',
    !badKey.ok && keyAfterRefusal.includes(vk.slice(0, 64)),
    !badKey.ok && keyAfterRefusal.includes(vk.slice(0, 64))
      ? 'a 1919-byte key was refused and the stored key is unchanged, so a short key cannot be sliced into coordinates'
      : !badKey.ok
        ? 'the short key was refused, but the stored key changed: a refused write must not be a partial one'
        : 'a 1919-byte key was ACCEPTED, which means the length rule is not enforced',
    { output: `${badKey.stdout}${badKey.stderr}`.trim().slice(0, 400) },
  );

  // -- 2. the honest execution ----------------------------------------------
  const honestHeight = Number(process.env.EXECUTION_HEIGHT || 1);
  const honestPayload = payloadFor(publicInputs, honestHeight);
  const honestEvidence = evidenceFor(adapterId, honestPayload, honestHeight, u64be(publicInputs[17]), admin);

  const accepted = await invoke(registry, [
    'submit_execution_zk',
    '--evidence', honestEvidence,
    '--proof', proof,
    '--public_inputs', JSON.stringify(publicInputs.map((value) => u64be(value))),
  ]);
  const acceptedError = contractError(`${accepted.stdout}${accepted.stderr}`);
  record(
    'honest_execution_accepted',
    accepted.ok,
    accepted.ok
      ? `the network accepted the execution proof and recorded the attestation ` +
        `(${publicInputs[19]} steps of ${20} rows, final pc ${publicInputs[18]}, ${publicInputs[20]} gas)`
      : `the honest execution was refused: ${
          acceptedError !== null ? `error #${acceptedError} ${ERR[acceptedError] || ''}` : `${accepted.stdout}${accepted.stderr}`.slice(0, 300)
        }`,
    {
      output: `${accepted.stdout}${accepted.stderr}`.trim().slice(0, 900),
      transaction: txOf(accepted.stdout + accepted.stderr),
    },
  );

  const recordedExecution = await readOnly(registry, ['get_execution_record', '--domain', domainKey]);
  const stepsMatch = recordedExecution.stdout.match(/steps_executed[\":\s]+(\d+)/);
  const gasMatch = recordedExecution.stdout.match(/gas_used[\":\s]+(\d+)/);
  const digestMatch = recordedExecution.stdout.match(/program_digest[\":\s]+([0-9a-f]{64})/);
  const expectedDigest = crypto
    .createHash('sha256')
    .update(Buffer.concat(programFromInputs(publicInputs).map((word) => Buffer.from(u64le(word), 'hex'))))
    .digest('hex');
  record(
    'recorded_execution_agrees_with_the_payload',
    Boolean(stepsMatch) && Boolean(gasMatch) && Boolean(digestMatch) &&
      Number(stepsMatch[1]) === Number(publicInputs[19]) &&
      Number(gasMatch[1]) === Number(publicInputs[20]) &&
      digestMatch[1] === expectedDigest,
    stepsMatch && gasMatch && digestMatch
      ? `recorded ${stepsMatch[1]} steps and ${gasMatch[1]} gas (the proof states ${publicInputs[19]} and ${publicInputs[20]}), ` +
        `program digest ${digestMatch[1].slice(0, 16)}... matches sha256 of the sixteen words the circuit committed`
      : `could not read the record back: ${recordedExecution.stdout}${recordedExecution.stderr}`.slice(0, 300),
    { output: recordedExecution.stdout.trim(), program_digest: expectedDigest },
  );

  // -- 3. refusals ----------------------------------------------------------
  const probes = [
    {
      name: 'a_different_program_under_the_same_proof',
      height: honestHeight + 1,
      payload: () => {
        const program = programFromInputs(publicInputs).slice();
        program[1] += 1n;
        return payloadFor(publicInputs, honestHeight + 1, { program });
      },
      expect: 5,
      why: 'the statement is about the program it commits: swapping a word breaks the binding before a pairing is spent',
    },
    {
      name: 'a_rewritten_step_count',
      height: honestHeight + 2,
      payload: () => payloadFor(publicInputs, honestHeight + 2, { stepsExecuted: BigInt(publicInputs[19]) - 1n }),
      expect: 5,
      why: 'the number of steps that ran is a public input, so a payload cannot claim fewer',
    },
    {
      name: 'instructions_hidden_behind_the_halt',
      height: honestHeight + 3,
      payload: () => payloadFor(publicInputs, honestHeight + 3, { instructionWords: 2n, program: programFromInputs(publicInputs) }),
      expect: 6,
      why: 'the slots past the code must be halt words; a payload that hides an instruction there describes no run the circuit could prove',
    },
    {
      name: 'proof_one_byte_short',
      height: honestHeight + 4,
      proof: (bytes) => bytes.slice(0, bytes.length - 2),
      expect: 8,
      why: 'the length is checked before any decoding, so a short proof cannot be sliced into coordinates',
    },
    {
      name: 'proof_with_its_group_elements_swapped',
      height: honestHeight + 5,
      proof: (bytes) => bytes.slice(384, 512) + bytes.slice(128, 384) + bytes.slice(0, 128),
      expect: 8,
      why: 'both halves stay valid G1 and G2 points in the required encoding, so only the pairing equation can tell them apart',
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
    const evidence = evidenceFor(adapterId, payload, probe.height, u64be(publicInputs[17]), admin);
    const result = await invoke(registry, [
      'submit_execution_zk',
      '--evidence', evidence,
      '--proof', probeProof,
      '--public_inputs', JSON.stringify(publicInputs.map((value) => u64be(value))),
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
      'submit_execution_zk',
      '--evidence', honestEvidence,
      '--proof', proof,
      '--public_inputs', JSON.stringify(publicInputs.map((value) => u64be(value))),
    ]);
    const error = contractError(`${replay.stdout}${replay.stderr}`);
    record(
      'the_same_evidence_cannot_be_submitted_twice',
      !replay.ok && error === 9,
      !replay.ok ? 'the evidence digest has already been consumed (refused with #9 EvidenceAlreadyProcessed)' : 'a replay was ACCEPTED',
      { output: `${replay.stdout}${replay.stderr}`.trim().slice(0, 300), error_code: error },
    );
  }

  // -- 9. the settlement anchor is untouched --------------------------------
  {
    const domain = await readOnly(registry, ['get_domain', '--domain', domainKey]);
    const machineApproved = await readOnly(registry, ['is_machine_approved', '--domain', domainKey]);
    const rootsUntouched =
      /last_root[\":\s]+(0{64})/.test(domain.stdout.replace(/\s/g, ' ')) ||
      !/last_root/.test(domain.stdout);
    record(
      'settlement_anchors_are_untouched',
      rootsUntouched && /false/.test(machineApproved.stdout),
      rootsUntouched && /false/.test(machineApproved.stdout)
        ? 'the domain record still anchors on nothing and is_machine_approved is still false: an execution proof is not a chain root, and the contract keeps them apart'
        : `the execution lane moved state it must not move: domain=${domain.stdout.trim()} approved=${machineApproved.stdout.trim()}`.slice(0, 400),
      { output: domain.stdout.trim() },
    );
  }

  // -- 10. the admin capability ---------------------------------------------
  if (process.env.EXECUTION_SKIP_RENOUNCE === '1') {
    record('admin_renounced', true, 'skipped by EXECUTION_SKIP_RENOUNCE=1; this run proves nothing about the renounce', { skipped: true });
  } else {
    const renounce = await invoke(registry, ['renounce_admin', '--admin', admin]);
    record(
      'admin_renounced',
      renounce.ok,
      renounce.ok
        ? 'the admin capability was given up, so no operator key can change any of the three verification keys'
        : `renounce failed: ${renounce.stdout}${renounce.stderr}`.slice(0, 300),
      { output: `${renounce.stdout}${renounce.stderr}`.trim().slice(0, 400), transaction: txOf(renounce.stdout + renounce.stderr) },
    );

    const afterRenounce = await invoke(registry, ['set_execution_vk', '--admin', admin, '--vk', vk]);
    const keyAfterRenounce = (await readOnly(registry, ['get_execution_vk'])).stdout.trim();
    record(
      'key_cannot_be_replaced_after_renounce',
      !afterRenounce.ok && keyAfterRenounce.includes(vk.slice(0, 64)),
      !afterRenounce.ok && keyAfterRenounce.includes(vk.slice(0, 64))
        ? "the execution lane's key is as frozen as the other two: the call traps and the stored key is unchanged"
        : `the call should have trapped; it ${afterRenounce.ok ? 'succeeded' : 'failed for another reason'} and the stored key ${keyAfterRenounce.includes(vk.slice(0, 64)) ? 'is' : 'is NOT'} the accepted one`,
      { output: `${afterRenounce.stdout}${afterRenounce.stderr}`.trim().slice(0, 400) },
    );
  }

  // -- write the record -----------------------------------------------------
  const passed = records.filter((row) => row.passed).length;
  const output = {
    lane: 'execution trace',
    circuit: 'circuits/execution_trace.circom',
    entrypoint: 'submit_execution_zk',
    network: NETWORK,
    registry_id: registry,
    registry_deployed_this_run: deployed,
    signer: admin,
    adapter_id: adapterId,
    domain_key: domainKey,
    circuit_public_inputs: publicInputs,
    program_digest: expectedDigest,
    steps_executed: Number(publicInputs[19]),
    gas_used: Number(publicInputs[20]),
    final_pc: Number(publicInputs[18]),
    domain_tag_expected: TAG.toString(),
    key_bytes: vk.length / 2,
    proof_bytes: proof.length / 2,
    payload_bytes: PAYLOAD_BYTES,
    honest_transaction: txOf(accepted.stdout + accepted.stderr),
    started_at: started,
    finished_at: new Date().toISOString(),
    checks: records,
    passed,
    total: records.length,
    all_passed: passed === records.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`\n${passed}/${records.length} checks passed`);
  console.log(`record: ${path.relative(ROOT, OUT)}`);
  process.exit(passed === records.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`live probe failed: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
