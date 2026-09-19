#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Builds the input for the execution-trace circuit.
//
// The split of work is deliberate. The machine half -- assembling the program,
// running it, padding the trace to the circuit's row count, checking the lane
// statement row by row, and deriving the selectors, carries and quotient the
// circuit treats as witness data -- is `crates/execution_vm`'s binary
// `execution-lane`, written in the language the interpreter is written in. The
// two Poseidon register roots are computed here, because circomlib's Poseidon
// lives here and because a root computed anywhere else would be a second
// implementation of the same hash.
//
// Usage:
//   node tools/execution-lane-input.mjs --out build/execution_trace_input.json
//   node tools/execution-lane-input.mjs --program circuits/execution_fixture.lgp
//   node tools/execution-lane-input.mjs --mutate register_file_not_carried
//
// Prints the input JSON on stdout when --out is omitted.
// ---------------------------------------------------------------------------

import { buildPoseidon } from 'circomlibjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The same constants the circuit compiles in. If they ever drift, the honest
// proof stops verifying -- which is exactly the failure a duplicated constant
// should produce.
const DOMAIN_TAG = '366332086174773927684157067308717544951988300004818040487599723223305911732';
const REGISTER_ROOT_TAG = '66197418195871398560001482625765192869627981700346088648095494354305693';

const LANE_STEPS = 20;
const PROGRAM_WORDS = 16;
const MEMORY_WORDS = 16;
const REGISTERS = 8;

/**
 * Runs the lane binary and returns its witness document.
 *
 * `cargo run` rather than a prebuilt path on purpose: the witness must come from
 * the crate as it is right now, not from a stale binary someone built earlier.
 */

/**
 * The cargo to run, and the environment to run it in.
 *
 * `CARGO` wins. Otherwise the two places a Rust toolchain is commonly installed
 * are tried before falling back to the PATH -- and when one of them is used, its
 * bin directory is prepended to the child's PATH and its `CARGO_HOME` /
 * `RUSTUP_HOME` are set, because cargo finds rustc through those and a tool that
 * only works in the shell somebody happened to configure is a tool that fails in
 * CI.
 */
export function cargoCommand() {
  const candidates = [
    { cargo: '.local/rust/cargo/bin/cargo', home: '.local/rust/cargo', rustup: '.local/rust/rustup' },
    { cargo: '.cargo/bin/cargo', home: '.cargo', rustup: '.rustup' },
  ];
  if (process.env.CARGO) return { bin: process.env.CARGO, env: process.env };
  for (const candidate of candidates) {
    const bin = join(homedir(), candidate.cargo);
    if (!existsSync(bin)) continue;
    const env = { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH || ''}` };
    const home = join(homedir(), candidate.home);
    const rustup = join(homedir(), candidate.rustup);
    if (existsSync(home)) env.CARGO_HOME = process.env.CARGO_HOME || home;
    if (existsSync(rustup)) env.RUSTUP_HOME = process.env.RUSTUP_HOME || rustup;
    return { bin, env };
  }
  return { bin: 'cargo', env: process.env };
}

export function laneDocument({ program = null } = {}) {
  const cargo = cargoCommand();
  const args = ['run', '-q', '-p', 'execution_vm', '--bin', 'execution-lane', '--'];
  if (program) args.push('--program', program);
  const output = execFileSync(cargo.bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cargo.env,
  });
  return JSON.parse(output);
}

function fieldOf(value) {
  const parsed = BigInt(value);
  return parsed < 0n ? parsed + FIELD_MODULUS : parsed;
}

let FIELD_MODULUS = 0n;

/** The circuit input for an honest run of a program. */
export async function honestLaneInput(options = {}) {
  const document = options.document || laneDocument(options);
  const poseidon = await buildPoseidon();
  const field = poseidon.F;
  FIELD_MODULUS = BigInt(field.p);

  const witness = document.witness;
  const tag = BigInt(REGISTER_ROOT_TAG);
  const regRoot = (registers) =>
    BigInt(field.toString(poseidon([tag, ...registers.map((value) => BigInt(value))])));

  const input = {
    program: witness.program,
    initial_regs_root: regRoot(witness.initial_regs).toString(),
    final_regs_root: regRoot(witness.final_regs).toString(),
    final_pc: document.statement.final_pc,
    steps_executed: document.statement.steps_executed,
    gas_used: document.statement.gas_used,
    domain_tag: DOMAIN_TAG,
  };

  for (const column of [
    'clk',
    'pc',
    'opcode',
    'rd_idx',
    'rs1_idx',
    'rs2_idx',
    'rs1_val',
    'rs2_val',
    'rd_val_new',
    'next_pc',
    'mem_addr',
    'mem_val',
    'is_mem_write',
    'imm_u32',
    'is_active',
    'carries_add',
    'carries_sub',
    'quotient_mul',
  ]) {
    input[column] = witness[column].slice();
  }
  // `imm` is signed on the trace and a field element in the circuit, exactly as
  // the circuit's own decode computes it: imm_u32 - 2^32 * sign.
  input.imm = witness.imm.map((value) => fieldOf(value).toString());
  input.regs = witness.regs.map((row) => row.slice());
  input.mem = witness.mem.map((row) => row.slice());
  for (const column of ['pc_sel', 'op_sel', 'rd_sel', 'rs1_sel', 'rs2_sel', 'mem_sel']) {
    input[column] = witness[column].map((row) => row.slice());
  }

  // A mutation that rewrites state has to be able to rewrite the commitment to
  // that state as well, otherwise every such mutation would be refused by the
  // proof of the root instead of by the constraint it aims at. The helper is
  // attached to the input rather than exported, because it is a tool for writing
  // negative tests, not part of the input format.
  input.__root = (registers) => regRoot(registers.map((value) => BigInt(value))).toString();

  input.__document = document;
  return input;
}

/**
 * Mutations, one per constraint family of the execution circuit.
 *
 * Each entry breaks exactly one thing and is expected to be refused by witness
 * generation, so a constraint that is silently missing shows up as a *passing*
 * mutation and fails the suite. `expect` is the fragment of the failure the
 * harness requires, so a mutation that fails for the wrong reason is also a
 * failure.
 *
 * The row numbers refer to the demonstration program's trace, and they are not
 * decoration: a mutation aimed at the multiplication has to land on the row that
 * ran a multiplication. The mapping of the twenty rows is
 *
 *   row  0..2   the three immediate loads of the prologue
 *   row  3..7   the first turn of the loop  (sub, add, jnz, sub, add)
 *   row  8      the second turn's `jnz`, which falls through
 *   row  9      the store that writes the accumulator into memory
 *   row 10      the load that reads it back
 *   row 11..12  the two comparisons
 *   row 13      the multiplication
 *   row 14      the assertion
 *   row 15      the halt
 *   row 16..19  three halts of padding
 *
 * `expect` is the fragment of the refusal the harness requires, so a mutation
 * that is refused by some other constraint does not count as coverage for the
 * one it aims at.
 */
export const MUTATIONS = {
  // clk[i] === i
  clock_out_of_order: {
    apply: (input) => {
      input.clk[4] = '99';
    },
    expect: 'line: 298',
    why: 'the clock counts the rows; a trace with a rewritten clock is not a trace',
  },
  // pc_sel one-hot, reconstructing pc[i]
  pc_outside_the_program: {
    apply: (input) => {
      input.pc_sel[0] = input.pc_sel[0].map(() => '0');
      input.pc_sel[0][PROGRAM_WORDS - 1] = '1';
    },
    expect: 'line: 351',
    why: 'a row cannot run from a slot the program counter does not name',
  },
  // word[i] === sum_j pc_sel[i][j] * program[j], and the decode equation
  program_word_rewritten: {
    apply: (input) => {
      // The same row, but the statement now commits a different instruction at
      // pc 0: the trace no longer decodes against what was signed.
      input.program[0] = '2';
    },
    expect: 'line: 413',
    why: 'the row must run the instruction the committed program holds, so swapping the program under a fixed trace is refused',
  },
  // the decode equation
  opcode_substituted_in_the_trace: {
    apply: (input) => {
      input.opcode[3] = '3';
      input.op_sel[3] = input.op_sel[3].map(() => '0');
      input.op_sel[3][3] = '1';
    },
    expect: 'line: 413',
    why: 'claiming an add was a multiply has to break either the decode or the semantics, and it breaks the decode first',
  },
  // rd_val_new === the gated sum of the opcode terms
  result_that_does_not_follow: {
    apply: (input) => {
      input.rd_val_new[3] = (BigInt(input.rd_val_new[3]) + 1n).toString();
    },
    expect: 'line: 467',
    why: 'the result of an instruction follows from its operands; a prover cannot write a number it likes into the destination',
  },
  // the wrapping subtraction's carry
  subtraction_carry_flipped: {
    apply: (input) => {
      input.carries_sub[3] = input.carries_sub[3] === '1' ? '0' : '1';
    },
    expect: 'line: 467',
    why: 'the borrow is what makes the subtraction wrap like the interpreter, so flipping it must break the result equation',
  },
  // the wrapping multiplication's quotient
  multiplication_quotient_wrong: {
    apply: (input) => {
      input.quotient_mul[13] = (BigInt(input.quotient_mul[13]) + 1n).toString();
    },
    expect: 'line: 467',
    why: 'the quotient is what pins a modular product to the wrapping one; without the range check it would be free',
  },
  // rs1_val / rs2_val === the register file the row carried in
  operand_not_from_the_register_file: {
    apply: (input) => {
      input.rs1_val[3] = (BigInt(input.rs1_val[3]) + 1n).toString();
    },
    expect: 'line: 425',
    why: 'an operand is read, not chosen: the row has to take the value the register held',
  },
  // regs[i+1] === the transition
  register_file_not_carried: {
    apply: (input) => {
      input.regs[4][1] = (BigInt(input.regs[4][1]) + 1n).toString();
    },
    expect: 'line: 534',
    why: 'a register file that changes between rows without an instruction writing it is exactly what the transition constraint forbids',
  },
  // r0 is pinned on every row
  r0_not_pinned: {
    apply: (input) => {
      input.regs[5][0] = '1';
    },
    expect: 'line: 532',
    why: 'r0 is zero by construction on every row, so a trace that gives it a value is refused',
  },
  // mem_read === mem_val on a load row
  memory_read_forged: {
    apply: (input) => {
      input.mem_val[10] = (BigInt(input.mem_val[10]) + 1n).toString();
    },
    expect: 'line: 467',
    why: 'a load returns the word the memory state carried into the row, not a value the prover prefers',
  },
  // mem[i+1] === mem[i] + the store
  memory_not_carried: {
    apply: (input) => {
      input.mem[11][0] = (BigInt(input.mem[11][0]) + 1n).toString();
    },
    expect: 'line: 544',
    why: 'memory is carried row to row: a rewritten word behind a store has to break the transition',
  },
  // the address is rs1 + the immediate, and it is inside the address space
  memory_address_out_of_range: {
    apply: (input) => {
      input.mem_sel[9] = input.mem_sel[9].map(() => '0');
      input.mem_sel[9][7] = '1';
    },
    expect: 'line: 492',
    why: 'the addressed word is the machine\'s own address, and a one-hot that names another word is refused',
  },
  // next_pc === the opcode's own rule
  next_pc_rewritten: {
    apply: (input) => {
      input.next_pc[5] = '12';
    },
    expect: 'line: 523',
    why: 'control flow is a function of the instruction; a rewritten next program counter is the branch the program did not take',
  },
  // pc[i+1] === next_pc[i]
  broken_pc_chain: {
    apply: (input) => {
      input.pc_sel[6] = input.pc_sel[6].map(() => '0');
      input.pc_sel[6][1] = '1';
      input.pc[6] = '1';
    },
    expect: 'line: 549',
    why: 'the rows are one run, so the next row must start where the previous one said it would',
  },
  // is_active is a bit that never turns back on
  padding_declared_active: {
    apply: (input) => {
      input.is_active[17] = '1';
    },
    expect: 'line: 561',
    why: 'a padding row cannot be declared active: the halt pattern and the step count would both have to move',
  },
  // steps_executed === sum of is_active
  step_count_not_the_work: {
    apply: (input) => {
      input.steps_executed = '15';
    },
    expect: 'line: 561',
    why: 'the published step count must be the rows that ran, or a proof could claim fewer steps than it took',
  },
  // is_halt[i] === 1 - is_active[i]*is_active[i+1], and is_halt === the halt selector
  halt_moved_back: {
    apply: (input) => {
      // claim the run halted at row 15 (the real halt) but declare the work to
      // have stopped at row 14 -- the halt pattern then points at the wrong row
      input.steps_executed = '14';
    },
    expect: 'line: 561',
    why: 'the halt must be the last active row: moving the count moves the pattern and the two disagree',
  },
  // the padding behind the halt is frozen
  padding_row_changes_state: {
    apply: (input) => {
      input.regs[18][4] = (BigInt(input.regs[18][4]) + 1n).toString();
    },
    expect: 'line: 534',
    why: 'behind the halt the state is frozen, so a padding row cannot write anything',
  },
  // initial_regs_root === Poseidon(regs[0])
  initial_state_not_committed: {
    apply: (input) => {
      input.regs[0][1] = (BigInt(input.regs[0][1]) + 1n).toString();
    },
    expect: 'line: 314',
    why: 'the register file the run starts from is what the published root commits; changing it changes the root',
  },
  // final_regs_root === Poseidon(regs[STEPS])
  final_state_not_committed: {
    apply: (input) => {
      input.final_regs_root = (BigInt(input.final_regs_root) + 1n).toString();
    },
    expect: 'line: 321',
    why: 'the end state is the statement, not a comment: a prover cannot publish a root its own register file does not hash to',
  },
  // gas_used === the sum of the per-opcode costing
  gas_not_the_cost_of_the_run: {
    apply: (input) => {
      input.gas_used = (BigInt(input.gas_used) + 1n).toString();
    },
    expect: 'line: 585',
    why: 'the costing is a consequence of which instructions ran, so a cheaper published cost is refused',
  },
  // domain_tag === the lane's constant
  wrong_domain_tag: {
    apply: (input) => {
      input.domain_tag = '1';
    },
    expect: 'line: 288',
    why: 'the statement carries its own tag, so a proof for one lane cannot be presented as a proof for another',
  },
  // an instruction outside the implemented subset
  opcode_outside_the_subset: {
    apply: (input) => {
      // Div (0x04) exists in the instruction set this machine is derived from
      // and is not part of its subset. The committed word now holds it, and the
      // trace still says the row ran an addition: the selector one-hot is
      // formed, so what refuses this is the decode equation.
      const word = BigInt(input.program[1]);
      input.program[1] = (((word >> 8n) << 8n) | 0x04n).toString();
    },
    expect: 'line: 413',
    why: 'an opcode the machine does not implement has no selector, so a committed word holding one cannot be the instruction a row ran',
  },
  // the register file the run starts from is the committed one
  entry_state_not_the_committed_root: {
    apply: (input) => {
      input.initial_regs_root = (BigInt(input.initial_regs_root) + 1n).toString();
    },
    expect: 'line: 314',
    why: 'the root the contract binds is the hash of the register file the run started from; a prover cannot publish another one',
  },
  // the immediate's width, and through it the decode: the word's immediate field
  // is a 32-bit value, so claiming a wider one cannot be part of the committed
  // instruction
  immediate_wider_than_the_instruction_word: {
    apply: (input) => {
      input.imm_u32[0] = (BigInt(input.imm_u32[0]) + (1n << 32n)).toString();
    },
    expect: 'in template Num2Bits',
    why: 'the immediate field of the instruction word is thirty-two bits wide; a wider one is not a number the word can hold, so no run can carry it',
  },
  // An assertion on a zero operand.
  //
  // This one takes work, and the work is the point: to leave the assertion's own
  // semantics as the *only* thing broken, the run has to be rewritten into a
  // consistent run that asserts zero. The first comparison writes its result to
  // r0 instead of r7 (r0 is discarded), so r7 stays zero, the multiplication
  // below it reads zero and multiplies it, and the assertion at the end has
  // nothing to assert. The register file is carried through all of it and the
  // final root is recomputed, so the commitment agrees with the state. What is
  // left is a run the machine would have refused, and a refusal is not a run.
  assertion_on_a_zero_operand: {
    apply: (input) => {
      // the comparison at pc 8 targets r0 now: clear the destination field
      const word = BigInt(input.program[8]);
      input.program[8] = (word - (word >> 8n & 7n) * 256n + 0n * 256n).toString();
      input.rd_idx[11] = '0';
      input.rd_sel[11] = input.rd_sel[11].map((_, index) => (index === 0 ? '1' : '0'));
      // r7 is never written again: zero it from that row onwards
      for (let row = 12; row < input.regs.length; row += 1) input.regs[row][7] = '0';
      // the multiplication reads r7 (= 0) and writes 0 into it
      input.rs1_val[13] = '0';
      input.rd_val_new[13] = '0';
      // the assertion reads r7 (= 0)
      input.rs1_val[14] = '0';
      input.final_regs_root = input.__root(input.regs[input.regs.length - 1]);
    },
    expect: 'line: 476',
    why: 'an assertion whose operand is zero stops the machine, so no trace can contain one',
  },
};

/**
 * Programs the machine itself refuses.
 *
 * These are not input mutations: each one is a run that has no trace at all, so
 * the refusal happens while the run is produced, in the interpreter, before a
 * witness is ever built. They are in the matrix because "the machine refuses
 * this and the circuit cannot prove it" is the pair of statements that matters;
 * a refusal is not a run.
 */
export const MACHINE_REFUSALS = {
  assertion_on_zero: {
    program:
      'load r1, 0\nload r2, 7\neq r3, r1, r2\nassert r3\nhalt\n',
    expect: 'the run did not finish',
    why: 'an assert whose operand is zero stops the machine, and a stopped machine has no trace',
  },
  step_limit_exceeded: {
    program: 'spin:\njmp spin\n',
    expect: 'the run did not finish',
    why: 'a run longer than the step budget has no proof in this circuit: the rows run out',
  },
  memory_out_of_range: {
    program: 'load r1, 99\nload r2, [r1]\nhalt\n',
    expect: 'the run did not finish',
    why: 'the address space is sixteen words; an access past it is refused rather than wrapped',
  },
  unimplemented_opcode: {
    program: 'div r1, r1, r1\nhalt\n',
    expect: 'does not assemble',
    why: 'the assembler refuses an instruction outside the implemented subset instead of choosing a meaning for it',
  },
  program_longer_than_the_committed_slots: {
    program: Array.from({ length: 17 }, () => 'load r1, 1').join('\n') + '\nhalt\n',
    expect: 'the lane commits 16',
    why: 'a program that does not fit the committed slots cannot be proved against them',
  },
};

export function parseArgs(argv) {
  const args = { mutate: null, out: null, program: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--mutate') args.mutate = value;
    else if (key === '--out') args.out = value;
    else if (key === '--program') args.program = value;
    else if (key === '--json') args.json = true;
  }
  return args;
}

function stripInternal(input) {
  const copy = { ...input };
  delete copy.__document;
  return copy;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = await honestLaneInput(args.program ? { program: args.program } : {});
  const document = input.__document;

  if (args.mutate) {
    const mutation = MUTATIONS[args.mutate];
    if (!mutation) {
      console.error(`no such mutation: ${args.mutate}`);
      console.error(`known: ${Object.keys(MUTATIONS).join(', ')}`);
      process.exit(2);
    }
    mutation.apply(input);
  }

  const rendered = `${JSON.stringify(stripInternal(input), null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, rendered);
    const state = document.statement;
    if (!args.json) {
      console.error(
        `execution lane: ${document.steps} rows, ${state.steps_executed} steps executed, ` +
          `${state.gas_used} gas, final pc ${state.final_pc}, memory[0] = ${document.result.memory_word_0}`,
      );
      console.error(`input written to ${args.out}${args.mutate ? ` (mutation: ${args.mutate})` : ''}`);
    }
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && process.argv[1].endsWith('execution-lane-input.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { DOMAIN_TAG, REGISTER_ROOT_TAG, LANE_STEPS, MEMORY_WORDS, PROGRAM_WORDS, REGISTERS };
export { existsSync, mkdtempSync, readFileSync, writeFileSync, tmpdir, join };
