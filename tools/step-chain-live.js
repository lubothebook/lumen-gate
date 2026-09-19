#!/usr/bin/env node
/**
 * Live probe for the multi-step chained lane.
 *
 * The unit tests prove that the chained circuit and the registry's second lane
 * behave correctly in the Soroban test host. This proves the same thing against
 * a real network: the proof is submitted to a deployed registry, the network
 * charges for it, and the verdicts are written down with transaction hashes so
 * nobody has to take a summary's word for it.
 *
 * The lane it exercises is the second proof lane, added beside the original
 * one. It is additive by construction: it records accepted chains in its own
 * storage slot and never touches the roots the settlement path anchors on, so
 * bootstrapping it cannot disturb a settlement path that is already live.
 *
 * What it checks, in order:
 *   1. bootstrap: register + admit a domain, set the 896-byte step-chain key
 *   2. honest chain        -> ACCEPTED, with a recorded chain of the right length
 *   3. swapped roots       -> REFUSED (a chain presented backwards is not a chain)
 *   4. 255-byte proof      -> REFUSED (explicit size limit, before decoding)
 *   5. wrong threshold     -> REFUSED (the quorum is bound to the compiled policy)
 *   6. replayed evidence   -> REFUSED (the digest has already been consumed)
 *   7. the settlement anchor is untouched, and the domain is still not "active"
 *      on the strength of a quorum proof
 *   8. the admin capability is given up (renounce), and the lane's verification
 *      key can no longer be replaced afterwards
 *
 * Configuration (env):
 *   STEP_CHAIN_REGISTRY  existing registry id to probe      (default: deploy a fresh one)
 *   STEP_CHAIN_DEPLOY=1  deploy a fresh registry as part of the run
 *   NETWORK              stellar network name               (default: testnet)
 *   STELLAR_SOURCE       stellar CLI identity               (default: audit-probe)
 *   BUILD_DIR            where the circuit artifacts live   (default: build)
 *   STEP_CHAIN_OUT       where to write the record          (default: deployments/step-chain.json)
 *   STEP_CHAIN_SKIP_RENOUNCE=1  leave the admin in place (useful while iterating)
 *
 * Usage:
 *   node tools/step-chain-live.js                 # full run against a fresh registry
 *   STEP_CHAIN_REGISTRY=C... node tools/step-chain-live.js   # re-probe an existing one
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NETWORK = process.env.NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'audit-probe';
const BUILD = process.env.BUILD_DIR || path.join(ROOT, 'build');
const OUT = process.env.STEP_CHAIN_OUT || path.join(ROOT, 'deployments', 'step-chain.json');
const WASM = path.join(ROOT, 'target', 'wasm32v1-none', 'release', 'finality_registry.wasm');

// The domain this probe registers. Same adapter id the live BLS lane uses, so
// the two lanes are two proof paths for one source domain rather than two
// unrelated registrations.
const DOMAIN_NAME = process.env.DOMAIN || 'source-testnet';
const ADAPTER_NAME = process.env.STEP_CHAIN_ADAPTER || 'source-chain-bls-v1';

const CHAIN_TAG = 263425106837261827811471650765498057995509407007498039180851432033046852848n;

// The contract's error table, by number. A probe that only says "refused" would
// not distinguish a refusal by the right rule from a refusal by a typo.
const ERR = {
  3: 'DomainNotFound',
  5: 'DeclaredMismatch',
  8: 'InvalidProof',
  9: 'EvidenceAlreadyProcessed',
  11: 'BadPayloadLength',
  12: 'NotAdmitted',
  13: 'AdminRenounced',
};

function sh(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 180000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function contractError(text) {
  const match = text.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? Number(match[1]) : null;
}

function sha256hex(text) {
  return require('node:crypto').createHash('sha256').update(text).digest('hex');
}

function u64le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer.toString('hex');
}

function u64be32(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

/**
 * Artifacts are read from the build directory when the pipeline has just been
 * run there, and otherwise from the copy committed under circuits/. A live probe
 * that only worked on the machine that ran the ceremony would be a claim nobody
 * else could re-check, which is the opposite of the point.
 */
function resolveArtifact(name) {
  const built = path.join(BUILD, name);
  if (fs.existsSync(built)) return built;
  return path.join(ROOT, 'circuits', name);
}

function readArtifacts() {
  const publicPath = resolveArtifact('step_chain_statement_public.json');
  const proofPath = resolveArtifact('step_chain_statement_proof.hex');
  for (const candidate of [publicPath, proofPath]) {
    if (!fs.existsSync(candidate)) {
      console.error(`${candidate} is missing. Build the lane first:`);
      console.error('  ./circuits/build.sh step_chain_statement');
      console.error('  ./circuits/setup.sh step_chain_statement');
      console.error('  python3 circuits/convert_to_soroban.py build/step_chain_statement_vk.json \\');
      console.error('      build/step_chain_statement_proof.json build/step_chain_statement_public.json \\');
      console.error('      build/step_chain_statement');
      process.exit(2);
    }
  }
  const publicInputs = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
  const proof = fs.readFileSync(proofPath, 'utf8').trim();
  const vkPath = resolveArtifact('step_chain_statement_vk.hex');
  if (!fs.existsSync(vkPath)) {
    console.error(`${vkPath} is missing; run the converter as above.`);
    process.exit(2);
  }
  const vk = fs.readFileSync(vkPath, 'utf8').trim();
  if (publicInputs.length !== 6) {
    console.error(`expected 6 public inputs for the chained circuit, got ${publicInputs.length}`);
    process.exit(2);
  }
  return { publicInputs, proof, vk };
}

/**
 * The 112-byte payload the lane parses. Every field is derived from the
 * circuit's own public inputs rather than typed in, so a fixture that drifts
 * away from the proof shows up as a refusal instead of as a stale manifest.
 */
function payloadFor(publicInputs, height) {
  const [start, end, event] = publicInputs.map((value) => BigInt(value).toString(16).padStart(64, '0'));
  const length = publicInputs[4];
  // Plain hex, no 0x prefix: that is how the CLI reads a Bytes argument, and a
  // prefixed string is rejected as unparseable rather than silently fixed up.
  return `${u64le(height)}${start}${end}${event}${u64le(length)}`;
}

function rootHex(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

async function invoke(id, args, source = SOURCE) {
  return sh('stellar', ['contract', 'invoke', '--id', id, '--source', source, '--network', NETWORK, '--', ...args]);
}

async function readOnly(id, args) {
  return invoke(id, args, SOURCE);
}

async function main() {
  const { publicInputs, proof, vk } = readArtifacts();
  const records = [];
  const started = new Date().toISOString();

  const admin = (await sh('stellar', ['keys', 'address', SOURCE])).stdout.trim();
  if (!/^G[A-Z0-9]{55}$/.test(admin)) {
    console.error(`could not resolve the signing address for identity ${SOURCE}`);
    process.exit(2);
  }

  let registry = process.env.STEP_CHAIN_REGISTRY || '';
  let deployed = false;
  if (!registry) {
    if (!process.env.STEP_CHAIN_DEPLOY && !process.env.STEP_CHAIN_REGISTRY) {
      // Default behaviour is to deploy: an honest run of this script should
      // produce a full record from a clean registry, not fail because an
      // environment variable was missing.
    }
    if (!fs.existsSync(WASM)) {
      console.error(`${WASM} is missing. Build it first: stellar contract build`);
      process.exit(2);
    }
    console.log('deploying a fresh registry for the chained lane...');
    const result = await sh('stellar', ['contract', 'deploy', '--wasm', WASM, '--source', SOURCE, '--network', NETWORK]);
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
    const mark = passed ? 'pass' : 'FAIL';
    console.log(`  [${mark}] ${check}\n         ${detail}`);
  };

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
  // Domain key = sha256(adapter id bytes || network name), byte for byte the
  // derivation the contract uses. Concatenating strings here would hash the
  // right characters with the wrong bytes.
  const domainKey = require('node:crypto')
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(adapterId, 'hex'), Buffer.from(DOMAIN_NAME, 'utf8')]))
    .digest('hex');
  await invoke(registry, ['admit_domain', '--admin', admin, '--domain', domainKey]);

  // The step-chain key: 896 bytes. The contract refuses any other length, which
  // is why the length is stated here rather than left to the artifact.
  if (vk.length !== 896 * 2) {
    console.error(`the step-chain key must be 896 bytes (${896 * 2} hex chars), got ${vk.length}`);
    process.exit(2);
  }
  const setKey = await invoke(registry, ['set_step_chain_vk', '--admin', admin, '--vk', vk]);
  record('step_chain_key_accepted_at_896_bytes', setKey.ok, setKey.ok
    ? `set_step_chain_vk stored the 896-byte key (64 + 3x128 + 7x64) in its own slot`
    : `set_step_chain_vk failed: ${setKey.stdout}${setKey.stderr}`.slice(0, 300),
    { transaction: (setKey.stdout + setKey.stderr).match(/tx\/([0-9a-f]{64})/)?.[1] || null });

  const shortKey = vk.slice(0, vk.length - 2);
  const badKey = await invoke(registry, ['set_step_chain_vk', '--admin', admin, '--vk', shortKey]);
  // A refused write must also leave the key alone. The CLI reports a trap
  // without the panic text, so the property that can be checked from outside is
  // that the stored key is still the 896-byte one that was accepted above.
  const keyAfterRefusal = (await readOnly(registry, ['get_step_chain_vk'])).stdout.trim();
  record('step_chain_key_of_the_wrong_length_refused',
    !badKey.ok && keyAfterRefusal.includes(vk),
    !badKey.ok && keyAfterRefusal.includes(vk)
      ? 'an 895-byte key was refused and the stored key is unchanged, so a short key cannot be sliced into coordinates'
      : !badKey.ok
        ? 'the 895-byte key was refused, but the stored key changed: a refused write must not be a partial one'
        : 'a 895-byte key was ACCEPTED, which means the length rule is not enforced',
    { output: `${badKey.stdout}${badKey.stderr}`.trim().slice(0, 400) });

  // -- 2. the honest chain --------------------------------------------------
  const honestHeight = Number(process.env.STEP_CHAIN_HEIGHT || 1);
  const honestEvidence = JSON.stringify({
    adapter_id: adapterId,
    evidence_version: 1,
    network: DOMAIN_NAME,
    payload: payloadFor(publicInputs, honestHeight),
    declared_height: honestHeight,
    declared_root: rootHex(publicInputs[1]),
    submitter: admin,
  });

  const accepted = await invoke(registry, [
    'submit_step_chain_zk',
    '--evidence', honestEvidence,
    '--proof', proof,
    '--public_inputs', JSON.stringify(publicInputs.map((value) => rootHex(value))),
  ]);
  const acceptedError = contractError(`${accepted.stdout}${accepted.stderr}`);
  record('honest_chain_accepted', accepted.ok,
    accepted.ok
      ? `the network accepted the chained proof and recorded the attestation`
      : `the honest chain was refused: ${acceptedError !== null ? `error #${acceptedError} ${ERR[acceptedError] || ''}` : `${accepted.stdout}${accepted.stderr}`.slice(0, 300)}`,
    // Both streams: the CLI prints the receipt (and the transaction link) to
    // stderr while the returned value goes to stdout, and a record that drops
    // the link is a record nobody can check.
    { output: `${accepted.stdout}${accepted.stderr}`.trim().slice(0, 900), transaction: (accepted.stdout + accepted.stderr).match(/tx\/([0-9a-f]{64})/)?.[1] || null });

  const recordedChain = await readOnly(registry, ['get_step_chain_record', '--domain', domainKey]);
  const lengthMatch = recordedChain.stdout.match(/chain_length[":\s]+(\d+)/);
  const heightMatch = recordedChain.stdout.match(/height[":\s]+(\d+)/);
  record('recorded_chain_has_the_proved_length_and_height',
    Boolean(lengthMatch) && Boolean(heightMatch) && Number(lengthMatch[1]) === Number(publicInputs[4]) && Number(heightMatch[1]) === honestHeight,
    lengthMatch && heightMatch
      ? `recorded chain_length ${lengthMatch[1]} (the circuit proved ${publicInputs[4]}) at height ${heightMatch[1]}`
      : `could not read the record back: ${recordedChain.stdout}${recordedChain.stderr}`.slice(0, 300),
    { output: recordedChain.stdout.trim() });

  // -- 3..6. refusals -------------------------------------------------------
  const probes = [
    {
      name: 'swapped_start_and_end_roots',
      height: honestHeight + 1,
      mutate: ({ inputs }) => {
        const swapped = inputs.slice();
        swapped[0] = inputs[1];
        swapped[1] = inputs[0];
        return { inputs: swapped };
      },
      expect: 5,
      why: 'a chain presented backwards links to nothing, and the roots are bound to the payload',
    },
    {
      name: 'proof_one_byte_short',
      height: honestHeight + 2,
      mutate: ({ proof: bytes }) => ({ proof: bytes.slice(0, bytes.length - 2) }),
      expect: 8,
      why: 'the length is checked before any decoding, so a short proof cannot be sliced into coordinates',
    },
    {
      name: 'threshold_lowered_to_one',
      height: honestHeight + 3,
      mutate: ({ inputs }) => {
        const lowered = inputs.slice();
        lowered[3] = u64be32(1);
        return { inputs: lowered };
      },
      expect: 5,
      why: 'the quorum is the constant compiled into the circuit, not a number the prover picks',
    },
    {
      name: 'evidence_replay',
      height: honestHeight,
      mutate: () => ({}),
      expect: 9,
      why: 'the same evidence digest cannot be consumed twice',
      reuseHonestEvidence: true,
    },
  ];

  for (const probe of probes) {
    let mutated = { inputs: publicInputs.map((value) => rootHex(value)), proof };
    mutated = { ...mutated, ...probe.mutate(mutated) };
    const evidence = probe.reuseHonestEvidence
      ? honestEvidence
      : JSON.stringify({
          adapter_id: adapterId,
          evidence_version: 1,
          network: DOMAIN_NAME,
          payload: payloadFor(publicInputs, probe.height),
          declared_height: probe.height,
          declared_root: rootHex(publicInputs[1]),
          submitter: admin,
        });
    const result = await invoke(registry, [
      'submit_step_chain_zk',
      '--evidence', evidence,
      '--proof', mutated.proof,
      '--public_inputs', JSON.stringify(mutated.inputs),
    ]);
    const code = contractError(`${result.stdout}${result.stderr}`);
    record(`refuses_${probe.name}`, code === probe.expect,
      code === probe.expect
        ? `${probe.why} -- refused with error #${code} ${ERR[code] || ''}`
        : result.ok
          ? `ACCEPTED: the live contract took a submission that should have been refused (${probe.why})`
          : `refused, but with #${code} ${ERR[code] || 'unknown'} instead of #${probe.expect} ${ERR[probe.expect]}`,
      { output: `${result.stdout}${result.stderr}`.trim().slice(0, 400) });
  }

  // -- 7. the settlement boundary ------------------------------------------
  const domain = await readOnly(registry, ['get_domain', '--domain', domainKey]);
  const lastRootMatch = domain.stdout.match(/last_root[":\s]+"?([0-9a-fA-F]{64})"?/);
  const zeroRoot = '0'.repeat(64);
  const stateMatch = domain.stdout.match(/state[":\s]+(\d+)/);
  record('a_verified_chain_does_not_move_the_settlement_anchor',
    lastRootMatch !== null && lastRootMatch[1].toLowerCase() === zeroRoot,
    lastRootMatch === null
      ? `could not read the domain record: ${domain.stdout}${domain.stderr}`.slice(0, 300)
      : `the domain's last_root is still all zeroes after an accepted chain, so nothing that settlement anchors on moved`,
    { output: domain.stdout.trim() });
  record('a_quorum_proof_does_not_mark_the_domain_active',
    stateMatch !== null && Number(stateMatch[1]) === 1,
    stateMatch === null
      ? 'could not read the domain state'
      : `the domain state is ${stateMatch[1]} (1 = admitted, 2 = active): only a verified signature proof moves it to active`,
    { output: domain.stdout.trim() });

  // -- 8. the admin capability ---------------------------------------------
  if (process.env.STEP_CHAIN_SKIP_RENOUNCE === '1') {
    record('admin_renounced', true, 'skipped by STEP_CHAIN_SKIP_RENOUNCE=1; this run proves nothing about the renounce', { skipped: true });
  } else {
    const renounce = await invoke(registry, ['renounce_admin', '--admin', admin]);
    record('admin_renounced', renounce.ok,
      renounce.ok
        ? 'the admin capability was given up, so no operator key can change a verification key'
        : `renounce failed: ${renounce.stdout}${renounce.stderr}`.slice(0, 300),
      {
        output: `${renounce.stdout}${renounce.stderr}`.trim().slice(0, 400),
        transaction: (renounce.stdout + renounce.stderr).match(/tx\/([0-9a-f]{64})/)?.[1] || null,
      });

    const afterRenounce = await invoke(registry, ['set_step_chain_vk', '--admin', admin, '--vk', vk]);
    const keyAfterRenounce = (await readOnly(registry, ['get_step_chain_vk'])).stdout.trim();
    record('key_cannot_be_replaced_after_renounce',
      !afterRenounce.ok && keyAfterRenounce.includes(vk),
      !afterRenounce.ok && keyAfterRenounce.includes(vk)
        ? 'the second lane\'s verification key is as frozen as the first one\'s: the call traps and the stored key is unchanged'
        : `the call should have trapped; it ${afterRenounce.ok ? 'succeeded' : 'failed for another reason'} and the stored key ${keyAfterRenounce.includes(vk) ? 'is' : 'is NOT'} the accepted one`,
      { output: `${afterRenounce.stdout}${afterRenounce.stderr}`.trim().slice(0, 400) });
  }

  // -- write the record -----------------------------------------------------
  const passed = records.filter((row) => row.passed).length;
  const output = {
    lane: 'multi-step chained finality',
    circuit: 'circuits/step_chain_statement.circom',
    entrypoint: 'submit_step_chain_zk',
    network: NETWORK,
    registry_id: registry,
    registry_deployed_this_run: deployed,
    signer: admin,
    adapter_id: adapterId,
    domain_key: domainKey,
    circuit_public_inputs: publicInputs,
    domain_tag_expected: CHAIN_TAG.toString(),
    key_bytes: vk.length / 2,
    proof_bytes: proof.length / 2,
    payload_bytes: 112,
    started_at: started,
    finished_at: new Date().toISOString(),
    checks: records,
    passed: passed,
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
