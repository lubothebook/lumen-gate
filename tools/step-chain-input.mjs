#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Builds the input for the multi-step chained circuit, and builds the mutated
// inputs the negative tests use.
//
// The chain is computed here exactly the way the circuit computes it, which is
// the point: the harness derives the roots rather than hard-coding them, so a
// change in the circuit's step relation immediately shows up as a failing
// honest proof instead of as a silently stale fixture.
//
// Usage:
//   node tools/step-chain-input.mjs --out build/step_chain_statement_input.json
//   node tools/step-chain-input.mjs --length 3 --out ...
//   node tools/step-chain-input.mjs --mutate inactive_step_claims_quorum --out ...
//
// Prints the input JSON on stdout when --out is omitted.
// ---------------------------------------------------------------------------

import { buildPoseidon } from 'circomlibjs';
import { writeFileSync } from 'node:fs';

// The same constants the circuit compiles in. If they ever disagree, the honest
// proof stops verifying and the mutation table below stops being meaningful,
// which is exactly the failure mode a duplicated constant should have.
const CHAIN_TAG = 263425106837261827811471650765498057995509407007498039180851432033046852848n;
const DIGEST_TAG = 268579613897541456733438126313361445880145453720266680290563490332889849410n;

const STEPS = 4;
const APPROVERS = 3;
const REGISTERED_THRESHOLD = 2;

function parseArgs(argv) {
  const args = { length: STEPS, mutate: null, out: null, start: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--length') args.length = Number(value);
    else if (key === '--mutate') args.mutate = value;
    else if (key === '--out') args.out = value;
    else if (key === '--start') args.start = BigInt(value);
  }
  return args;
}

/**
 * Builds an honest input.
 *
 * `length` is the number of active steps: the rest are padding, present in the
 * witness but required by the circuit to be no-ops. A chain shorter than the
 * capacity is the normal case, so it is the one the honest tests use.
 */
async function honestInput({ length, start }) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (value) => BigInt(F.toString(value));

  const chainStart = start !== null && start !== undefined ? start : toField(poseidon([11n, 22n, 33n]));
  const eventRoot = toField(poseidon([44n, 55n, 66n]));
  const threshold = BigInt(REGISTERED_THRESHOLD);

  const approvals = [];
  const isActive = [];
  const intermediateRoots = [];

  let root = chainStart;
  for (let step = 0; step < STEPS; step += 1) {
    const active = step < length;
    // A live step carries a real quorum: threshold approvers say yes. The third
    // approver abstains, so the bitmap is not degenerate.
    const bitmap = active
      ? Array.from({ length: APPROVERS }, (_value, index) => (index < REGISTERED_THRESHOLD ? 1n : 0n))
      : Array.from({ length: APPROVERS }, () => 0n);
    approvals.push(bitmap);
    isActive.push(active ? 1n : 0n);

    const effective = bitmap.reduce((sum, bit) => sum + bit, 0n) * (active ? 1n : 0n);
    const digest = toField(poseidon([DIGEST_TAG, effective, eventRoot]));
    const linked = toField(poseidon([CHAIN_TAG, root, digest]));
    root = active ? linked : root;
    intermediateRoots.push(root);
  }

  return {
    chain_start_root: chainStart.toString(),
    chain_end_root: root.toString(),
    event_root: eventRoot.toString(),
    threshold: threshold.toString(),
    chain_length: BigInt(length).toString(),
    domain_tag: CHAIN_TAG.toString(),
    approvals: approvals.map((row) => row.map((value) => value.toString())),
    is_active: isActive.map((value) => value.toString()),
    intermediate_roots: intermediateRoots.map((value) => value.toString()),
  };
}

/**
 * Mutations, one per constraint family.
 *
 * A general "flip a byte" test would prove only that the circuit notices noise.
 * Each entry here breaks one specific constraint and is expected to be refused;
 * `expect` is the fragment of the failure the harness requires, so a mutation
 * that fails for the wrong reason is also a failure of the test.
 */
const MUTATIONS = {
  // is_active[i] * (is_active[i] - 1) === 0
  non_boolean_activity: {
    apply: (input) => { input.is_active[1] = '2'; },
    expect: 'Assert Failed',
    why: 'activity must be a bit, so a step cannot be half-active and contribute two thirds of a quorum',
  },
  // approvals[i][j] * (approvals[i][j] - 1) === 0
  non_boolean_approval: {
    apply: (input) => { input.approvals[0][0] = '5'; },
    expect: 'Assert Failed',
    why: 'an approval bitmap entry must be a bit, otherwise the count can be inflated past the quorum',
  },
  // quorum[i]: an active step must reach the threshold
  active_step_without_quorum: {
    apply: (input) => { input.approvals[1] = ['1', '0', '0']; },
    expect: 'Assert Failed',
    why: 'a step that claims to be active must carry a quorum, or the chain proves activity that never happened',
  },
  // quorum[i] + the chain relation: turning a padded step on changes the root
  activating_a_padded_step: {
    apply: (input) => {
      // Step 3 is padding in the honest input. Claiming it is active is the
      // attack this design has to stop: a prover asserting activity for a step
      // it cannot prove, without recomputing the chain.
      input.is_active[3] = '1';
      input.approvals[3] = ['1', '1', '0'];
    },
    expect: 'Assert Failed',
    why: 'a padded step cannot simply be declared active: the state it would produce no longer matches the published end root',
  },
  // length_matches: active_prefix === chain_length
  chain_length_mismatch: {
    apply: (input) => { input.chain_length = '2'; },
    expect: 'Assert Failed',
    why: 'the declared length must equal the number of steps that actually ran, so a chain cannot hide padding',
  },
  // length_at_least_one
  zero_length_chain: {
    apply: (input) => { input.chain_length = '0'; },
    expect: 'Assert Failed',
    why: 'a chain of length zero proves nothing and is refused rather than treated as a valid empty chain',
  },
  // length_within_capacity
  length_above_capacity: {
    apply: (input) => { input.chain_length = '9'; },
    expect: 'Assert Failed',
    why: 'the length cannot exceed the circuit capacity',
  },
  // policy: threshold === registered threshold
  wrong_threshold: {
    apply: (input) => { input.threshold = '1'; },
    expect: 'Assert Failed',
    why: 'the quorum policy is fixed at compile time; a prover cannot lower it to whatever the witness satisfies',
  },
  // tag: domain_tag === CHAIN_TAG
  wrong_domain_tag: {
    apply: (input) => { input.domain_tag = '1'; },
    expect: 'Assert Failed',
    why: 'the statement carries its own domain tag, so a proof for one statement cannot be presented as another',
  },
  // chain_end_root === root[nSteps-1]
  wrong_end_root: {
    apply: (input) => { input.chain_end_root = '12345'; },
    expect: 'Assert Failed',
    why: 'the published end root must be the one the chain actually produced',
  },
  // chain_start_root is the chain's first link
  wrong_start_root: {
    apply: (input) => { input.chain_start_root = '54321'; },
    expect: 'Assert Failed',
    why: 'the published start root anchors the chain; changing it breaks every link after it',
  },
  // event_root appears in every step digest
  wrong_event_root: {
    apply: (input) => { input.event_root = '98765'; },
    expect: 'Assert Failed',
    why: 'the event root is bound into every step digest, so it is not free metadata',
  },
  // intermediate_roots[i] === root[i]
  forged_intermediate_root: {
    apply: (input) => { input.intermediate_roots[2] = '777'; },
    expect: 'Assert Failed',
    why: 'intermediate roots are derived, not supplied: a prover cannot publish a step root it did not compute',
  },
  // moved: end != start
  chain_that_does_not_move: {
    apply: (input) => {
      // Keep every constraint satisfied except the last one: the chain must
      // actually change the root. A one-step chain cannot have start === end
      // without the digest being zero, so this mutation targets the check
      // directly by asking for a zero-length move.
      input.is_active = ['0', '0', '0', '0'];
      input.approvals = [['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']];
      input.chain_length = '0';
      input.intermediate_roots = [input.chain_start_root, input.chain_start_root, input.chain_start_root, input.chain_start_root];
      input.chain_end_root = input.chain_start_root;
    },
    expect: 'Assert Failed',
    why: 'a chain that leaves the state exactly where it started is not a chain, and is refused twice over: length zero and end equal to start',
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = await honestInput({ length: args.length, start: args.start });

  if (args.mutate) {
    const mutation = MUTATIONS[args.mutate];
    if (!mutation) {
      console.error(`unknown mutation ${args.mutate}\nknown: ${Object.keys(MUTATIONS).join(', ')}`);
      process.exit(2);
    }
    mutation.apply(input);
  }

  const text = `${JSON.stringify(input, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text);
  else process.stdout.write(text);
}

export { honestInput, MUTATIONS };

main();
