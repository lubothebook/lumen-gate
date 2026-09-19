pragma circom 2.0.0;
include "circomlib/poseidon.circom";

/*
  Poseidon probe: not a statement about the bridge — a calibration circuit.

  The gate VM's Rust witness generator implements the circomlib Poseidon(2)
  permutation by hand (crates/gate_vm/src/poseidon.rs). "By hand" needs an
  authority to agree with, and the authority is the compiler: this circuit
  exposes exactly one Poseidon(2) and publishes its output. Running it over
  fixed inputs through `snarkjs calculatewitness` yields the ground-truth
  field elements; `circuits/gen_poseidon_probe.py` converts that into the
  golden file `crates/gate_vm/tests/poseidon_golden.json` that the Rust test
  asserts against.

  If circomlib ever changes its parameters or the round structure, this probe
  catches it before the main circuit's 20k-constraint proving pipeline can
  fail cryptically.

  The main components: x0, x1 are inputs; out is public.
*/

template PoseidonProbe() {
    signal input x0;
    signal input x1;
    signal output out;

    component p = Poseidon(2);
    p.inputs[0] <== x0;
    p.inputs[1] <== x1;
    out <== p.out;
}

component main {public [x0, x1]} = PoseidonProbe();
