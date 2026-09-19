pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";

/*
  Lumen Gate -- source-chain finality statement (Groth16 / BN254).

  This circuit exists to make one narrow claim, and only that claim:

      "There is a set of validator approvals, committed to a bitmap, that
       reaches the registered quorum; and the three roots the source chain
       published -- previous state root, new state root and event root --
       participate in one Poseidon relation, so that none of them is
       decorative metadata that the prover could vary freely."

  Public signal order is fixed by the deployed verifier contract, which
  requires public_inputs[3] to equal the evidence's declared state root:

      public_inputs[0] = prev_state_root
      public_inputs[1] = event_root
      public_inputs[2] = threshold
      public_inputs[3] = state_root        <-- the commitment the registry binds

  Private input: enabled[n], a bitmap of which validators approved.

  WHAT THIS IS NOT. This is not a signature verifier. It proves a quorum of
  approvals existed, not that any particular validator signed anything. A
  production ZK path must replace the bitmap with a real BLS or ed25519
  signature gadget, or fold the signature check into the circuit. Until then
  the honest description of this lane is "quorum + root-binding proof", and
  that is the description used everywhere in the documentation.

  The circuit also has no `signal output`, deliberately: any main-component
  output would become an extra public input and shift the indices the verifier
  contract expects.
*/

// IsZero and the comparators come from circomlib/comparators.circom, which is
// already in the include path. Reused rather than re-declared: a local copy
// with the same name is a duplicate-symbol error, and circomlib's is the
// audited one.

template FinalityStatement(n, m) {
    signal input prev_state_root;
    signal input event_root;
    signal input threshold;
    signal input state_root;
    signal input enabled[n];

    // -- quorum over the approval bitmap -----------------------------------
    // Each entry must be exactly 0 or 1, otherwise a prover could inflate the
    // count by writing values larger than one.
    signal count;
    count <== enabled[0] + enabled[1] + enabled[2] + enabled[3] + enabled[4];
    for (var i = 0; i < n; i++) {
        enabled[i] * (enabled[i] - 1) === 0;
    }

    component quorum = GreaterEqThan(8);
    quorum.in[0] <== count;
    quorum.in[1] <== threshold;
    quorum.out === 1;

    // -- the registered policy is fixed at deployment -----------------------
    component policy = IsEqual();
    policy.in[0] <== threshold;
    policy.in[1] <== m;
    policy.out === 1;

    // -- bind all three roots into the relation -----------------------------
    component binding = Poseidon(3);
    binding.inputs[0] <== prev_state_root;
    binding.inputs[1] <== state_root;
    binding.inputs[2] <== event_root;

    component nonzero = IsZero();
    nonzero.in <== binding.out;
    nonzero.out === 0;
}

component main {public [prev_state_root, event_root, threshold, state_root]} = FinalityStatement(5, 3);
