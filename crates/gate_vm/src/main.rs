//! The gate-vm command-line tool: assemble, run, emit.
//!
//! It produces exactly the three artifacts the proving pipeline consumes —
//! the snarkjs witness input, the lane payload (hex, for a submission tool),
//! and a human-readable summary — and refuses to write anything for an
//! execution that did not halt inside the window. An emitter that "helpfully"
//! truncated a runaway program into a short trace would be manufacturing the
//! very unsoundness the circuit exists to reject.

use gate_vm::field::Fp;
use gate_vm::isa::{Inst, Opcode, PROGRAM_LINES};
use gate_vm::poseidon::poseidon2;
use gate_vm::program::{assemble, demo_program, program_root};
use gate_vm::vm::{run, VmError};
use gate_vm::witness;

fn parse_op(word: &str) -> Option<Opcode> {
    Some(match word.to_ascii_lowercase().as_str() {
        "move" => Opcode::Move,
        "add" => Opcode::Add,
        "sub" => Opcode::Sub,
        "mul" => Opcode::Mul,
        "pose" | "poseidon" => Opcode::Pose,
        "assert" | "assert_eq" => Opcode::AssertEq,
        "jnz" | "jmpnz" => Opcode::JumpNZ,
        "halt" => Opcode::Halt,
        _ => return None,
    })
}

fn parse_hex_or_dec(text: &str) -> Result<Fp, String> {
    if let Some(hex) = text.strip_prefix("0x") {
        let padded = format!("{:0>64}", hex.to_ascii_lowercase());
        return Ok(Fp::from_hex(&padded));
    }
    text.parse::<u64>()
        .map(Fp::from_u64)
        .map_err(|_| format!("not a decimal u64 or 0x-hex literal: {text}"))
}

fn load_program(path: Option<&String>) -> Result<[u16; PROGRAM_LINES], String> {
    let Some(path) = path else {
        return Ok(demo_program());
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut insts = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let line = line.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut words = line.split_whitespace();
        let op = words
            .next()
            .and_then(parse_op)
            .ok_or_else(|| format!("{path}:{}: unknown opcode", number + 1))?;
        let mut operand = [0u8; 3];
        for slot in operand.iter_mut() {
            *slot = match words.next() {
                Some(v) => v
                    .parse::<u8>()
                    .map_err(|_| format!("{path}:{}: bad operand {v}", number + 1))?,
                None => 0,
            };
        }
        if words.next().is_some() {
            return Err(format!("{path}:{}: too many operands", number + 1));
        }
        insts.push(Inst::new(op, operand[0], operand[1], operand[2]));
    }
    if insts.len() > PROGRAM_LINES {
        return Err(format!("{path}: more than {PROGRAM_LINES} instructions"));
    }
    Ok(assemble(&insts))
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut emit_dir = "build".to_string();
    let mut height = 1u64;
    let mut start = Fp::from_u64(41);
    let mut event = Fp::from_u64(1);
    let mut window = gate_vm::isa::DEFAULT_STEPS;
    let mut program_file: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--emit-dir" => {
                i += 1;
                emit_dir = args.get(i).ok_or("--emit-dir needs a value")?.clone();
            }
            "--height" => {
                i += 1;
                height = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .ok_or("--height needs an integer")?;
            }
            "--start" => {
                i += 1;
                start = parse_hex_or_dec(args.get(i).ok_or("--start needs a value")?)?;
            }
            "--event" => {
                i += 1;
                event = parse_hex_or_dec(args.get(i).ok_or("--event needs a value")?)?;
            }
            "--window" => {
                i += 1;
                window = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .ok_or("--window needs an integer")?;
            }
            "--program" => {
                i += 1;
                program_file = Some(args.get(i).ok_or("--program needs a path")?.clone());
            }
            "--selftest" => {
                // The one claim that is checkable without snarkjs: the field
                // ops and the poseidon port must be self-consistent. The
                // authority for poseidon correctness remains the probe vectors
                // under tests/, regenerated with circuits/gen_poseidon3.py.
                let h = poseidon2(&Fp::ZERO, &Fp::ONE);
                assert!(!h.is_zero());
                println!("gate-vm selftest: ok");
                return Ok(());
            }
            other => return Err(format!("unknown argument {other}")),
        }
        i += 1;
    }

    let program = load_program(program_file.as_ref())?;
    let receipt = match run(&program, &start, &event, window) {
        Ok(receipt) => receipt,
        Err(VmError::NoHalt) => {
            return Err(
                "the program did not halt inside the window; no witness is emitted for an \
                 execution that did not finish"
                    .to_string(),
            )
        }
        Err(other) => return Err(other.to_string()),
    };

    let root = program_root(&program);
    let input = witness::circom_input(&program, &receipt.steps, &start, &event, &receipt);
    let payload = witness::payload(height, &program, &start, &event, &receipt);
    let publics = witness::public_inputs(&program, &start, &event, &receipt);
    if payload.len() != witness::PAYLOAD_LEN {
        return Err(format!(
            "internal: payload is {} bytes, the registry expects {}",
            payload.len(),
            witness::PAYLOAD_LEN
        ));
    }

    std::fs::create_dir_all(&emit_dir).map_err(|e| format!("{emit_dir}: {e}"))?;
    std::fs::write(format!("{emit_dir}/gate_vm_input.json"), input + "\n")
        .map_err(|e| e.to_string())?;
    std::fs::write(
        format!("{emit_dir}/gate_vm_payload.hex"),
        hex::encode(&payload) + "\n",
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        format!("{emit_dir}/gate_vm_publics.json"),
        serde_json::to_string_pretty(&publics).unwrap() + "\n",
    )
    .map_err(|e| e.to_string())?;

    println!("gate-vm: {window}-step window, {} active rows", receipt.steps.iter().filter(|s| !s.halted).count());
    println!("  program root : {}", root.to_hex());
    println!("  start        : {}", start.to_hex());
    println!("  event        : {}", event.to_hex());
    println!("  end (r2 out) : {}", receipt.output.to_hex());
    println!("  hash steps   : {}", receipt.hash_steps);
    println!("  payload      : {emit_dir}/gate_vm_payload.hex ({} bytes)", payload.len());
    println!("  witness input: {emit_dir}/gate_vm_input.json");
    Ok(())
}
