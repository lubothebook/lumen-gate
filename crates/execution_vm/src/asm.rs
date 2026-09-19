//! A two-pass assembler for the instruction set, so that the tests and the
//! fixtures read like a program rather than like a list of packed integers.
//!
//! Both passes are needed for the same reason every assembler needs two: a
//! jump's immediate is `target - pc`, and the target of a forward label is not
//! known until the whole listing has been laid out. Pass one assigns every
//! instruction an address; pass two encodes, now with the labels in hand.
//!
//! The syntax is deliberately small:
//!
//! ```text
//! load  r1, 5          ; immediate into a register
//! load  r2, [r4]       ; word read from memory at r4
//! store [r4], r2       ; word write to memory at r4
//! add   r3, r1, r2     ; rd, rs1, rs2
//! assert r1
//! jnz   r1, loop       ; jump to a label when r1 is non-zero
//! loop:
//! halt
//! ```

use crate::isa::{Instruction, Opcode};

/// Registers, re-exported so a program listing never has to guess the width.
pub use crate::trace::REGISTERS;

/// Assembler refusal. Always a sentence naming the line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsmError(pub String);

impl std::fmt::Display for AsmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AsmError {}

fn parse_register(token: &str) -> Result<u8, AsmError> {
    let trimmed = token.trim();
    let digits = trimmed
        .strip_prefix('r')
        .ok_or_else(|| AsmError(format!("`{trimmed}` is not a register")))?;
    let index: u8 = digits
        .parse()
        .map_err(|_| AsmError(format!("`{trimmed}` is not a register")))?;
    if index as usize >= REGISTERS {
        return Err(AsmError(format!(
            "`{trimmed}` is outside the {} registers this machine has",
            REGISTERS
        )));
    }
    Ok(index)
}

fn parse_literal(token: &str) -> Result<i64, AsmError> {
    let trimmed = token.trim();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    // A literal is a plain integer, or a hexadecimal one, and it may use the
    // whole 64-bit width: `0xFFFFFFFFFFFFFFFF` is the wrapping minus one.
    let value: i64 = if let Some(hex) = digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        match i64::from_str_radix(hex, 16) {
            Ok(value) => value,
            Err(_) => u64::from_str_radix(hex, 16)
                .map(|value| value as i64)
                .map_err(|_| AsmError(format!("`{trimmed}` is not a 64-bit literal")))?,
        }
    } else {
        digits
            .parse::<i64>()
            .or_else(|_| digits.parse::<u64>().map(|value| value as i64))
            .map_err(|_| AsmError(format!("`{trimmed}` is not a literal")))?
    };
    Ok(if negative { -value } else { value })
}

/// The memory operand form: `[r4]`.
fn parse_memory_operand(token: &str) -> Option<Result<u8, AsmError>> {
    let trimmed = token.trim();
    let inner = trimmed.strip_prefix('[')?.strip_suffix(']')?;
    Some(parse_register(inner))
}

fn split_operands(rest: &str) -> Vec<String> {
    rest.split(',')
        .map(|operand| operand.trim().to_string())
        .filter(|operand| !operand.is_empty())
        .collect()
}

struct Line {
    address: usize,
    label: Option<String>,
    mnemonic: Option<String>,
    operands: Vec<String>,
    source_line: usize,
}

fn parse_lines(source: &str) -> Result<Vec<Line>, AsmError> {
    let mut lines = Vec::new();
    let mut address = 0usize;
    for (number, raw) in source.lines().enumerate() {
        let without_comment = match raw.split_once(';') {
            Some((head, _)) => head,
            None => raw,
        };
        let text = without_comment.trim();
        if text.is_empty() {
            continue;
        }

        // A label may stand alone or introduce an instruction on the same line.
        let (label, remainder) = match text.split_once(':') {
            Some((name, rest)) => (Some(name.trim().to_string()), rest.trim().to_string()),
            None => (None, text.to_string()),
        };
        if let Some(name) = &label {
            if name.is_empty() || name.contains(char::is_whitespace) {
                return Err(AsmError(format!("line {}: bad label `{name}`", number + 1)));
            }
        }

        if remainder.is_empty() {
            lines.push(Line {
                address,
                label,
                mnemonic: None,
                operands: Vec::new(),
                source_line: number + 1,
            });
            continue;
        }

        let mut parts = remainder.splitn(2, char::is_whitespace);
        let mnemonic = parts.next().unwrap_or_default().to_lowercase();
        let rest = parts.next().unwrap_or_default();
        lines.push(Line {
            address,
            label,
            mnemonic: Some(mnemonic),
            operands: split_operands(rest),
            source_line: number + 1,
        });
        address += 1;
    }
    Ok(lines)
}

/// Assembles a listing into packed program words.
pub fn assemble(source: &str) -> Result<Vec<u64>, AsmError> {
    let lines = parse_lines(source)?;

    let mut labels: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for line in &lines {
        if let Some(label) = &line.label {
            if labels.insert(label.clone(), line.address).is_some() {
                return Err(AsmError(format!("label `{label}` is defined twice")));
            }
        }
    }

    let mut program = Vec::new();
    for line in &lines {
        let Some(mnemonic) = &line.mnemonic else {
            continue;
        };
        let operands = &line.operands;
        let bad = |detail: String| AsmError(format!("line {}: {detail}", line.source_line));

        let instruction = match mnemonic.as_str() {
            "halt" => Instruction::new(Opcode::Halt, 0, 0, 0, 0),
            "add" | "sub" | "mul" | "eq" | "lt" => {
                let opcode = match mnemonic.as_str() {
                    "add" => Opcode::Add,
                    "sub" => Opcode::Sub,
                    "mul" => Opcode::Mul,
                    "eq" => Opcode::Eq,
                    _ => Opcode::Lt,
                };
                if operands.len() != 3 {
                    return Err(bad(format!("`{mnemonic}` takes rd, rs1, rs2")));
                }
                Instruction::new(
                    opcode,
                    parse_register(&operands[0])?,
                    parse_register(&operands[1])?,
                    parse_register(&operands[2])?,
                    0,
                )
            }
            "load" => {
                if operands.len() != 2 {
                    return Err(bad("`load` takes rd, immediate or rd, [rs]".into()));
                }
                let rd = parse_register(&operands[0])?;
                match parse_memory_operand(&operands[1]) {
                    Some(rs) => Instruction::new(Opcode::Load, rd, rs?, 0, 0),
                    None => Instruction::new(
                        Opcode::Load,
                        rd,
                        0,
                        0,
                        parse_literal(&operands[1])? as i32,
                    ),
                }
            }
            "store" => {
                if operands.len() != 2 {
                    return Err(bad("`store` takes [rs], rs2".into()));
                }
                let rs = match parse_memory_operand(&operands[0]) {
                    Some(rs) => rs?,
                    None => return Err(bad("`store` needs a memory operand: [rs]".into())),
                };
                Instruction::new(Opcode::Store, 0, rs, parse_register(&operands[1])?, 0)
            }
            "assert" => {
                if operands.len() != 1 {
                    return Err(bad("`assert` takes rs1".into()));
                }
                Instruction::new(Opcode::Assert, 0, parse_register(&operands[0])?, 0, 0)
            }
            "jmp" | "jnz" => {
                let (opcode, register_operand) = if mnemonic == "jmp" {
                    if operands.len() != 1 {
                        return Err(bad("`jmp` takes a label".into()));
                    }
                    (Opcode::Jmp, None)
                } else {
                    if operands.len() != 2 {
                        return Err(bad("`jnz` takes rs1, label".into()));
                    }
                    (Opcode::Jnz, Some(parse_register(&operands[0])?))
                };
                let label_operand = if mnemonic == "jmp" {
                    &operands[0]
                } else {
                    &operands[1]
                };
                let target = match labels.get(label_operand.as_str()) {
                    Some(target) => *target as i64,
                    None => return Err(bad(format!("no label `{label_operand}`"))),
                };
                let relative = target - line.address as i64;
                Instruction::new(
                    opcode,
                    // the a-slot is unused by both label forms; it encodes as zero
                    0,
                    register_operand.unwrap_or(0),
                    0,
                    relative as i32,
                )
            }
            other => return Err(bad(format!("`{other}` is not an instruction here"))),
        };
        program.push(instruction.encode());
    }

    Ok(program)
}
