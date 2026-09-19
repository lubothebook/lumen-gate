#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// The negative test matrix for the execution-trace circuit.
//
// Three groups, and all three are needed:
//
//   honest     a run of the demonstration program and a run of the fixture
//              program satisfy every constraint -- including the padding path,
//              which the fixture exercises at a different depth;
//   mutations  one constraint family broken at a time, in the witness, and
//              witness generation has to refuse it. A general "corrupt a byte"
//              test would only prove the circuit notices noise; a mutation that
//              passes would mean the family is missing;
//   refusals   runs the *machine* refuses -- an assertion on zero, a step
//              budget overrun, an address past the address space, an
//              instruction outside the subset. Each of these has no trace at
//              all, so the refusal happens before a witness exists. A refusal
//              is not a run, and the circuit has nothing to prove about one.
//
// Usage:
//   node tools/execution-trace-tests.mjs              # honest + mutations + refusals
//   node tools/execution-trace-tests.mjs --json       # machine-readable report
//   node tools/execution-trace-tests.mjs --only honest
//
// Requires the circuit to be built and set up first:
//   circuits/setup.sh execution_trace
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.BUILD_DIR || join(ROOT, 'build');
const WITNESS_WASM = join(BUILD, 'execution_trace_js', 'execution_trace.wasm');
const AS_JSON = process.argv.includes('--json');
const only = (() => {
  const index = process.argv.indexOf('--only');
  return index >= 0 ? process.argv[index + 1] : null;
})();

const { honestLaneInput, MUTATIONS, MACHINE_REFUSALS, cargoCommand } = await import('./execution-lane-input.mjs');

const LEARN = process.argv.includes('--learn');

/** snarkjs writes its errors with colour codes; the location is what matters. */
function locationOf(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const match = plain.match(/(Error in template [A-Za-z_0-9]+ line: \d+|assert\([^)]*\))/);
  return match ? match[1] : plain.trim().split('\n').filter((line) => line.trim()).slice(-1)[0] || '';
}

/** Runs witness generation for one input and reports whether the circuit accepted it. */
function calculateWitness(input, workDir, label) {
  const inputPath = join(workDir, `input_${label}_${Math.random().toString(36).slice(2)}.json`);
  const witnessPath = `${inputPath}.wtns`;
  const copy = { ...input };
  delete copy.__document;
  writeFileSync(inputPath, `${JSON.stringify(copy, null, 2)}\n`);
  try {
    execFileSync(
      'node',
      [join(ROOT, 'node_modules', '.bin', 'snarkjs'), 'wtns', 'calculate', WITNESS_WASM, inputPath, witnessPath],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return { accepted: true, output: '' };
  } catch (error) {
    return { accepted: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

/** Runs the lane binary on a program listing and reports whether the run exists. */
function runMachine(programSource, workDir, label) {
  const programPath = join(workDir, `program_${label}.lgp`);
  writeFileSync(programPath, programSource);
  const cargo = cargoCommand();
  try {
    execFileSync(
      cargo.bin,
      ['run', '-q', '-p', 'execution_vm', '--bin', 'execution-lane', '--', '--program', programPath, '--out', join(workDir, `${label}.json`)],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: cargo.env },
    );
    return { refused: false, output: '' };
  } catch (error) {
    return { refused: true, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function report(rows) {
  if (AS_JSON) {
    console.log(
      JSON.stringify(
        { checks: rows, all_passed: rows.every((row) => row.passed), finished_at: new Date().toISOString() },
        null,
        2,
      ),
    );
    return;
  }
  for (const row of rows) {
    console.log(`  [${row.passed ? 'pass' : 'FAIL'}] ${row.check}`);
    console.log(`         ${row.detail}`);
  }
}

/** The fixture listing, the same one the crate ships. */
const FIXTURE_LISTING = `
    load  r1, 3
    load  r2, 5
    lt    r3, r1, r2
    mul   r4, r1, r2
    jnz   r3, ahead
    halt
ahead:
    assert r4
    eq    r5, r4, r4
    jmp   end
    halt
end:
    halt
`;

async function main() {
  if (!existsSync(WITNESS_WASM)) {
    console.error(`witness generator missing at ${WITNESS_WASM}\nrun: circuits/setup.sh execution_trace`);
    process.exit(2);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'execution-lane-'));
  const fixturePath = join(workDir, 'fixture.lgp');
  writeFileSync(fixturePath, FIXTURE_LISTING);

  const rows = [];
  const learned = {};
  if (!AS_JSON && !LEARN) console.log('execution-trace circuit: constraint coverage\n');

  // -- group 1: the honest runs ---------------------------------------------
  if (!only || only === 'honest') {
    for (const [name, options] of [
      ['demonstration_program', {}],
      ['fixture_program_control_flow', { program: fixturePath }],
    ]) {
      const input = await honestLaneInput(options);
      const document = input.__document;
      const result = calculateWitness(input, workDir, name);
      rows.push({
        check: `honest_run_of_the_${name}_is_accepted`,
        passed: result.accepted === true,
        detail: result.accepted
          ? `${document.statement.steps_executed} steps of ${document.steps} rows, ${document.statement.gas_used} gas, ` +
            `final pc ${document.statement.final_pc}, ${document.steps - document.statement.steps_executed} padding rows, ` +
            `memory[0] = ${document.result.memory_word_0}`
          : `the honest input was refused: ${result.output.slice(-300)}`,
        mutation: null,
      });
    }
  }

  // -- group 2: one broken constraint family at a time -----------------------
  if (!only || only === 'mutations') {
    for (const [name, mutation] of Object.entries(MUTATIONS)) {
      const input = await honestLaneInput();
      mutation.apply(input);
      const result = calculateWitness(input, workDir, `mutation_${name}`);
      const observed = result.accepted ? '' : locationOf(result.output);
      if (LEARN) {
        learned[name] = observed;
        continue;
      }
      // Refused is not enough: it has to be refused by the constraint the
      // mutation targets. A mutation that trips an unrelated constraint would
      // otherwise count as coverage for a family nobody tested.
      const refusedForTheRightReason =
        !result.accepted && (mutation.expect === null || observed.includes(mutation.expect));
      rows.push({
        check: `mutation_${name}_is_refused`,
        passed: refusedForTheRightReason,
        detail: result.accepted
          ? `the mutation was ACCEPTED, so the constraint it targets is missing: ${mutation.why}`
          : refusedForTheRightReason
            ? `${mutation.why} (refused at ${observed})`
            : `refused, but at ${observed}, which is not the constraint this mutation targets (${mutation.expect}): ${mutation.why}`,
        mutation: name,
        constraint_hit: observed,
      });
    }
    if (LEARN) {
      console.log(JSON.stringify(learned, null, 2));
      process.exit(0);
    }
  }

  // -- group 3: runs the machine refuses ------------------------------------
  if (!only || only === 'refusals') {
    for (const [name, refusal] of Object.entries(MACHINE_REFUSALS)) {
      const result = runMachine(refusal.program, workDir, `refusal_${name}`);
      const matched = result.refused && result.output.includes(refusal.expect);
      rows.push({
        check: `machine_refuses_${name}`,
        passed: matched,
        detail: matched
          ? refusal.why
          : `expected the machine to refuse with "${refusal.expect}", got refused=${result.refused}: ${result.output.slice(-200)}`,
        mutation: name,
      });
    }
  }

  report(rows);
  const failed = rows.filter((row) => !row.passed).length;
  if (!AS_JSON) {
    console.log(`\n${rows.length - failed}/${rows.length} checks passed`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(2);
});
