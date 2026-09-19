//! Runs the execution lane end to end, in Rust, and writes the witness document
//! the circuit's input builder consumes.
//!
//! This binary is the machine half of the lane. It assembles the program, runs
//! it on the interpreter, pads the trace to the circuit's row count, checks the
//! result against the lane statement -- entry, capacity, padding, halt, decode,
//! and every per-row constraint -- and only then emits a witness. If any of that
//! fails it exits non-zero with the sentence that says what was wrong, which is
//! the behaviour a proof tool should have: refuse loudly in the cheap language
//! before spending a proving key.
//!
//! Usage:
//!   execution-lane                     # the demonstration program, JSON on stdout
//!   execution-lane --out build/execution_trace_lane.json
//!   execution-lane --program my.lgp    # a program listing instead
//!
//! The witness document carries the values the circuit treats as witness data
//! (selectors, carries, the multiply quotient) and the two register files whose
//! Poseidon roots the input builder computes; it does not carry the roots
//! themselves, because the field-to-bytes conversion belongs on the JavaScript
//! side where circomlib's Poseidon lives.

use execution_vm::lane::{
    lane_witness, pad_to, LaneStatement, DEMO_PROGRAM_SOURCE, LANE_PROGRAM_WORDS, LANE_STEPS,
};
use execution_vm::{assemble, Vm};
use serde_json::json;
use std::fs;

fn main() {
    let mut source = DEMO_PROGRAM_SOURCE.to_string();
    let mut out: Option<String> = None;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--program" => {
                index += 1;
                let path = args.get(index).expect("--program needs a path");
                source = fs::read_to_string(path)
                    .unwrap_or_else(|error| fail(&format!("cannot read {path}: {error}")));
            }
            "--out" => {
                index += 1;
                out = Some(args.get(index).expect("--out needs a path").clone());
            }
            other => fail(&format!("unknown argument {other}")),
        }
        index += 1;
    }

    let mut program = match assemble(&source) {
        Ok(program) => program,
        Err(error) => fail(&format!("the program does not assemble: {error}")),
    };
    let real_words = program.len();
    if real_words > LANE_PROGRAM_WORDS {
        fail(&format!(
            "the program is {real_words} instructions, the lane commits {LANE_PROGRAM_WORDS}"
        ));
    }
    program.resize(LANE_PROGRAM_WORDS, 0);

    let mut vm = Vm::new();
    if let Err(error) = vm.run(&program, LANE_STEPS) {
        fail(&format!("the run did not finish: {error}"));
    }
    let raw = vm.trace(&program);
    let steps_executed = raw.steps_executed();
    let trace = match pad_to(&raw, LANE_STEPS) {
        Ok(trace) => trace,
        Err(error) => fail(&format!("the trace does not pad to the lane: {error}")),
    };
    let statement = LaneStatement {
        program: program.clone(),
        steps_executed,
        gas_used: trace.gas_used,
        final_pc: trace.final_pc,
    };
    let witness = match lane_witness(&trace, &statement) {
        Ok(witness) => witness,
        Err(error) => fail(&format!("the trace is not a lane trace: {error}")),
    };

    let memory_word_zero = witness
        .mem
        .last()
        .and_then(|row| row.first())
        .cloned()
        .unwrap_or_else(|| "0".to_string());
    let document = json!({
        "lane": "execution",
        "domain_tag": execution_vm::lane::LANE_DOMAIN_TAG,
        "register_root_tag": execution_vm::lane::REGISTER_ROOT_TAG,
        "steps": LANE_STEPS,
        "program_words": LANE_PROGRAM_WORDS,
        "memory_words": execution_vm::MEMORY_WORDS,
        "registers": execution_vm::REGISTERS,
        "instruction_words": real_words,
        "statement": {
            "steps_executed": statement.steps_executed.to_string(),
            "gas_used": statement.gas_used.to_string(),
            "final_pc": statement.final_pc.to_string(),
        },
        "result": { "memory_word_0": memory_word_zero },
        "witness": serde_json::to_value(&witness).expect("the witness serialises"),
    });

    let rendered = format!("{}\n", serde_json::to_string_pretty(&document).unwrap());
    match out {
        Some(path) => {
            fs::write(&path, rendered)
                .unwrap_or_else(|error| fail(&format!("cannot write {path}: {error}")));
            eprintln!(
                "execution lane: {} rows, {} steps executed, {} gas, final pc {}, memory[0] = {}",
                LANE_STEPS,
                statement.steps_executed,
                statement.gas_used,
                statement.final_pc,
                memory_word_zero
            );
            eprintln!("witness written to {path}");
        }
        None => print!("{rendered}"),
    }
}

fn fail(message: &str) -> ! {
    eprintln!("execution-lane: {message}");
    std::process::exit(1);
}
