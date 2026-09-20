//! Quarantine gate: the proof half must stay off the Gate path.
//!
//! `zk-proof`, `zk-state`, `verifier-registry` and `note-packing` live in this
//! workspace because they arrived with the original import, not because Gate
//! uses them. They are not part of this deliverable, nothing claims they work,
//! and no Gate code may depend on them.
//!
//! "Nobody depends on it" is the kind of statement that quietly stops being
//! true. This test makes it enforceable: add a proof-half dependency to a Gate
//! crate and CI goes red with a message saying why, rather than the boundary
//! eroding one convenient import at a time.
//!
//! Scope note: this checks the Gate path only. The quarantined crates may of
//! course depend on each other.

use std::fs;
use std::path::{Path, PathBuf};

/// Crates that form the Gate path — the execution half plus this harness.
const GATE_PATH_CRATES: [&str; 4] = ["zk-isa", "zk-vm", "zk-compiler", "parity"];

/// Crates under quarantine: present, unwired, unclaimed.
const QUARANTINED: [&str; 4] = ["zk-proof", "zk-state", "verifier-registry", "note-packing"];

/// Package names the quarantined crates publish, as a dependency line would
/// spell them.
const QUARANTINED_PKGS: [&str; 4] = [
    "zk-proof",
    "zk-state",
    "verifier-registry",
    "zk-note-packing",
];

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is .../gate2/zkvm/parity; the workspace root is its
    // parent. `unwrap`/`expect` are denied workspace-wide (see clippy.toml), so
    // the impossible branch is spelled out instead of unwrapped.
    match Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        Some(root) => root.to_path_buf(),
        None => panic!("CARGO_MANIFEST_DIR has no parent; cannot locate the zkvm workspace root"),
    }
}

#[test]
fn no_gate_crate_depends_on_the_proof_half() {
    let root = workspace_root();
    let mut violations = Vec::new();

    for crate_dir in GATE_PATH_CRATES {
        let manifest = root.join(crate_dir).join("Cargo.toml");
        let text = fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", manifest.display()));

        for pkg in QUARANTINED_PKGS {
            // Match a dependency key at the start of a line: `zk-proof = ...`
            // or `zk-proof.workspace = true`. Substring matching alone would
            // trip over prose in comments.
            let hit = text.lines().any(|line| {
                let l = line.trim();
                if l.starts_with('#') {
                    return false;
                }
                l.starts_with(pkg)
                    && l[pkg.len()..]
                        .trim_start()
                        .starts_with(['=', '.'])
            });
            if hit {
                violations.push(format!("{crate_dir} depends on {pkg}"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "the proof half is quarantined and must stay off the Gate path, but:\n  {}\n\n\
         If Gate genuinely needs one of these, that is a scope decision for a \
         human, not a dependency line: see STATUS.md and PROVENANCE.md.",
        violations.join("\n  ")
    );
}

#[test]
fn no_gate_source_file_imports_a_quarantined_crate() {
    // The manifest check above is the real gate; this catches the case where a
    // dependency is inherited some other way and a `use` slips through.
    let root = workspace_root();
    let mut violations = Vec::new();

    for crate_dir in GATE_PATH_CRATES {
        let src = root.join(crate_dir);
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n == "target") {
                        continue;
                    }
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let Ok(text) = fs::read_to_string(&path) else {
                        continue;
                    };
                    for pkg in QUARANTINED_PKGS {
                        let ident = pkg.replace('-', "_");
                        let needle = format!("use {ident}");
                        if text.lines().any(|l| l.trim_start().starts_with(&needle)) {
                            violations.push(format!("{} imports {pkg}", path.display()));
                        }
                    }
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "quarantined crates must not be imported on the Gate path:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn the_quarantined_crates_are_still_present_and_accounted_for() {
    // Quarantine is not deletion. If one of these disappears, that is a real
    // change to what the repository contains and should be a deliberate commit
    // rather than a silent one — this test makes it visible either way.
    let root = workspace_root();
    for crate_dir in QUARANTINED {
        assert!(
            root.join(crate_dir).join("Cargo.toml").exists(),
            "{crate_dir} is recorded as quarantined-but-present; it is now missing. \
             If it was removed on purpose, update STATUS.md, evidence.json and this test."
        );
    }
}
