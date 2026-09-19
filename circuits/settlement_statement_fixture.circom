pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";

/*
  QUARANTINED development fixture. Not the circuit that is deployed.

  The live circuit is finality_statement.circom. This file is kept only so
  the checked-in range_proof_* fixtures have a matching source; the relayer
  refuses to submit anything built from it unless
  ALLOW_DEVELOPMENT_ZK_FIXTURE=1 is set for a development demonstration.

  It is named a statement, not a VM, because that is what it is: a fixed
  relation over a handful of field elements. Renaming the template was part
  of removing the inaccurate "zkVM" label from this repository.

  Public inputs: previous root, new root, event root and threshold.
  Private inputs: enabled validator bitmap.

  This is a bounded demo relation. It proves that the supplied roots and
  threshold participate in one Poseidon relation and that the bitmap reaches
  the configured quorum. It is not a full source-chain VM or a signature
  verifier. Production deployment requires a circuit-specific ceremony and
  an actual validator-signature gadget.
*/
template IsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in == 0 ? 0 : 1 / in;
    out <== 1 - in * inv;
    in * out === 0;
}

template CountEnabled(n) {
    signal input enabled[n];
    signal output count;
    count <== enabled[0] + enabled[1] + enabled[2] + enabled[3] + enabled[4];
    for (var i = 0; i < n; i++) {
        enabled[i] * (enabled[i] - 1) === 0;
    }
}

template SettlementStatementFixture(n, m) {
    signal input prev_state_root;
    signal input new_state_root;
    signal input event_root;
    signal input threshold;
    signal input enabled[n];
    signal output valid;

    component count = CountEnabled(n);
    for (var i = 0; i < n; i++) {
        count.enabled[i] <== enabled[i];
    }

    component quorum = GreaterEqThan(8);
    quorum.in[0] <== count.count;
    quorum.in[1] <== threshold;

    component threshold_policy = IsEqual();
    threshold_policy.in[0] <== threshold;
    threshold_policy.in[1] <== m;

    component transition_hash = Poseidon(3);
    transition_hash.inputs[0] <== prev_state_root;
    transition_hash.inputs[1] <== new_state_root;
    transition_hash.inputs[2] <== event_root;

    // A zero Poseidon result is rejected, so all three public roots are part of
    // the relation rather than metadata ignored by the proof.
    component nonzero = IsZero();
    nonzero.in <== transition_hash.out;

    valid <== quorum.out * threshold_policy.out * (1 - nonzero.out);
    valid === 1;
}

component main {public [prev_state_root, new_state_root, event_root, threshold]} = SettlementStatementFixture(5, 3);
