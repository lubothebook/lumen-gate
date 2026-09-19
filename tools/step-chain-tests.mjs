#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// The negative test matrix for the multi-step chained circuit.
//
// Every constraint family gets its own test. A general "corrupt a byte" test
// would only prove that the circuit notices noise; this table breaks one
// specific thing at a time and requires witness generation to refuse it, so a
// constraint that is silently missing shows up as a *passing* mutation and
// fails the suite.
//
// It runs the same commands a reviewer would and reports what happened:
//
//   node tools/step-chain-tests.mjs                     # honest + every mutation
//   node tools/step-chain-tests.mjs --json              # machine-readable report
//
// Requires the circuit to be built and set up first:
//   circuits/setup.sh step_chain_statement
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.BUILD_DIR || join(ROOT, 'build');
const WITNESS_JS = join(BUILD, 'step_chain_statement_js', 'step_chain_statement.wasm');
const AS_JSON = process.argv.includes('--json');

const { honestInput, MUTATIONS } = await import('./step-chain-input.mjs');

/** Runs witness generation for one input and reports whether the circuit accepted it. */
function calculateWitness(input, workDir) {
  const inputPath = join(workDir, `input_${Math.random().toString(36).slice(2)}.json`);
  const witnessPath = `${inputPath}.wtns`;
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  try {
    execFileSync('node', [join(ROOT, 'node_modules', '.bin', 'snarkjs'), 'wtns', 'calculate', WITNESS_JS, inputPath, witnessPath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { accepted: true, output: '' };
  } catch (error) {
    return { accepted: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function report(rows) {
  if (AS_JSON) {
    console.log(JSON.stringify({ checks: rows, all_passed: rows.every((row) => row.passed), finished_at: new Date().toISOString() }, null, 2));
    return;
  }
  for (const row of rows) {
    const mark = row.passed ? 'pass' : 'FAIL';
    console.log(`  [${mark}] ${row.check}`);
    console.log(`         ${row.detail}`);
  }
}

async function main() {
  if (!existsSync(WITNESS_JS)) {
    console.error(`witness generator missing at ${WITNESS_JS}\nrun: circuits/setup.sh step_chain_statement`);
    process.exit(2);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'step-chain-'));
  const rows = [];

  if (!AS_JSON) console.log('multi-step chained circuit: constraint coverage\n');

  // -- the honest baseline ---------------------------------------------------
  for (const length of [4, 3, 1]) {
    const honest = await honestInput({ length });
    const result = calculateWitness(honest, workDir);
    rows.push({
      check: `honest_chain_of_${length}_steps_is_accepted`,
      passed: result.accepted === true,
      detail: result.accepted
        ? `a chain of ${length} active step(s) with ${length < 4 ? 'padding behind it' : 'no padding'} satisfies every constraint`
        : `the honest input was refused: ${result.output.slice(-200)}`,
      mutation: null,
    });
  }

  // -- padding isolation ------------------------------------------------------
  // This one is a *positive* check, and it has to be: the claim is that a padded
  // step's approvals never reach the digest, and the way to observe that is that
  // the honest end root is still accepted while those approvals are present. If
  // the gating were missing, `effective` would be 2 for the padded step, the
  // digest would change, and this input would be refused.
  {
    const padded = await honestInput({ length: 2 });
    padded.approvals[2] = ['1', '1', '0'];
    padded.approvals[3] = ['1', '1', '1'];
    const result = calculateWitness(padded, workDir);
    rows.push({
      check: 'padding_is_isolated_at_the_constraint_level',
      passed: result.accepted === true,
      detail: result.accepted
        ? 'approvals written onto padded steps are ignored: the chain still proves the same end root, because effective = raw_count * is_active gates them'
        : `the padded approvals changed the state, which means the gate is not enforced: ${result.output.slice(-200)}`,
      mutation: null,
    });
  }

  // -- one mutation per constraint family ------------------------------------
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    const input = await honestInput({ length: 3 });
    mutation.apply(input);
    const result = calculateWitness(input, workDir);
    const refusedForTheRightReason = !result.accepted && result.output.includes(mutation.expect);
    rows.push({
      check: `refuses_${name}`,
      passed: refusedForTheRightReason,
      detail: refusedForTheRightReason
        ? `${mutation.why} -- refused with "${mutation.expect}"`
        : result.accepted
          ? `NOT REFUSED: the circuit accepted a witness that ${mutation.why}`
          : `refused, but not for the expected reason: ${result.output.slice(0, 200)}`,
      mutation: name,
    });
  }

  report(rows);

  const passed = rows.filter((row) => row.passed).length;
  if (!AS_JSON) console.log(`\n${passed}/${rows.length} checks passed`);
  process.exit(passed === rows.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`circuit test harness failed: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
