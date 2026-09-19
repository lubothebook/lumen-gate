#!/usr/bin/env python3
"""Generate the Poseidon calibration fixtures from the *circom* side.

The Rust poseidon port must agree with the pinned circomlib Poseidon — not
with an abstract Goldilocks spec, not with my memory of round counts. The
authority is the exact `node_modules/circomlib/circuits/poseidon.circom`
that `circuits/gate_vm.circom` compiles against, so we extract its truth
mechanically:

  1. `build.sh poseidon_probe` compiles circuits/poseidon_probe.circom
     (a Poseidon(2) main) with the same -l search path as the real circuits;
  2. for each probe input pair, snarkjs computes the witness and
     `wtns export json` dumps every signal; the .sym map tells us which
     index is `main.out` — no reliance on internal numbering;
  3. the outputs land in `crates/gate_vm/tests/poseidon_golden.json`, and a
     Rust test asserts the port reproduces them exactly.

Run order after any dependency or port change:

  ./circuits/build.sh poseidon_probe
  python3 circuits/gen_poseidon_probe.py
  cargo test -p gate_vm

Numbers are decimal strings so nothing depends on hex conventions on either
side.
"""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SNARKJS = os.path.join(REPO, "node_modules", ".bin", "snarkjs")
OUTDIR = os.path.join(REPO, "build")

# Field-sized and near-boundary inputs, plus the small values a demo trace
# actually hashes — the failure modes of a ported Poseidon live at the edges.
PROBES = [
    (7, 9),
    (0, 0),
    (1, 0),
    (2**253, 2**253 - 1),
    (2**200 + 5, 2**128 - 9),
    (12345678901234567890, 98765432109876543210),
]


def probe_witness(x0: int, x1: int) -> str:
    os.makedirs(OUTDIR, exist_ok=True)
    input_path = os.path.join(OUTDIR, "poseidon_probe_input.json")
    wasm = os.path.join(OUTDIR, "poseidon_probe_js", "poseidon_probe.wasm")
    with open(input_path, "w") as f:
        json.dump({"x0": str(x0), "x1": str(x1)}, f)
    wtns = input_path + ".wtns"
    subprocess.run([SNARKJS, "wc", wasm, input_path, wtns], check=True, capture_output=True)
    wjson = input_path + ".wit.json"
    subprocess.run([SNARKJS, "wej", wtns, wjson], check=True, capture_output=True)
    out_index = None
    with open(os.path.join(OUTDIR, "poseidon_probe.sym")) as f:
        for line in f:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4 and parts[3] == "main.out":
                out_index = int(parts[0])
                break
    if out_index is None:
        raise RuntimeError("main.out not found in poseidon_probe.sym")
    witness = json.load(open(wjson))
    return str(int(witness[out_index]))


def main():
    out = [
        {"x0": str(x0), "x1": str(x1), "out": probe_witness(x0, x1)}
        for x0, x1 in PROBES
    ]
    path = os.path.join(REPO, "crates", "gate_vm", "tests", "poseidon_golden.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"wrote {path}: {len(out)} fixtures")


if __name__ == "__main__":
    main()
