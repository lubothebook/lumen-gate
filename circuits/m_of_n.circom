pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";

/*
  Small demo circuit for a source-chain finality statement.

  Public inputs: state_root and threshold.
  Private inputs: enabled validator bitmap.

  This circuit proves a threshold bitmap, not a production signature scheme.
  The production ZK path must replace the bitmap with a real signature or
  commitment verification circuit before it is used for value-bearing assets.
*/
template MOfN(n, m) {
    signal input state_root;
    signal input threshold;
    signal input enabled[n];
    signal output valid;

    signal count;
    count <== enabled[0] + enabled[1] + enabled[2] + enabled[3] + enabled[4];

    for (var i = 0; i < n; i++) {
        enabled[i] * (enabled[i] - 1) === 0;
    }

    component threshold_check = GreaterEqThan(8);
    threshold_check.in[0] <== count;
    threshold_check.in[1] <== threshold;

    component policy_check = IsEqual();
    policy_check.in[0] <== threshold;
    policy_check.in[1] <== m;

    // Keep the root in the proving relation. The output is intentionally not
    // revealed; the verifier binds it through the public input vector.
    component root_binding = Poseidon(2);
    root_binding.inputs[0] <== state_root;
    root_binding.inputs[1] <== threshold;

    valid <== threshold_check.out * policy_check.out;
    valid === 1;
}

component main {public [state_root, threshold]} = MOfN(5, 3);
