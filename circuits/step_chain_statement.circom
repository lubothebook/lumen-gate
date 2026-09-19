pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";
include "circomlib/bitify.circom";

/*
  Lumen Gate -- multi-step chained finality statement (Groth16 / BN254).

  The single-statement circuit next to this file proves one fixed claim: a
  quorum of approvals exists over one bitmap and three roots participate in one
  Poseidon relation. This circuit proves a *sequence* of them, chained:

      state_root_0 -> state_root_1 -> ... -> state_root_N

  where every step derives its root from the previous step's root and from that
  step's own evidence, and the last derived root must equal the public
  commitment the registry binds.

  Claim, stated exactly:

      "Starting from the published start root, there exist M <= N consecutive
       steps (M = chain_length is public), each carrying a quorum of approvals
       that reaches the registered threshold, such that applying them one after
       another produces exactly the published end root; and the end root is not
       the start root."

  ---------------------------------------------------------------------------
  THIS IS STILL NOT A VM, AND NOT A SIGNATURE PROOF
  ---------------------------------------------------------------------------
  It proves a chain of quorum-bearing transitions, not the execution of a
  program on a virtual machine: there is no instruction set, no memory model, no
  commitment to a guest program and no witness that replays an execution. What
  it does add over the single-statement circuit is a *state transition relation*
  with a defined step order and a per-step evidence channel, which is the first
  honest step toward a machine-shaped proof. It also does not verify signatures;
  a production ZK path replaces the approval bitmap with a real signature gadget
  and this header changes with it.

  ---------------------------------------------------------------------------
  WHY EVERY SIGNAL HERE IS CONSTRAINED, NOT MERELY COMPUTED
  ---------------------------------------------------------------------------
  A signal that is only computed during witness generation is not proven: a
  malicious prover can write any value into it. So every signal below is either
  (a) forced to be boolean, (b) forced to equal an expression of other signals,
  or (c) forced to equal a public input or a constant. Nothing is left
  "derived but trusted". The list, signal by signal:

    is_active[i]        is_active[i] * (is_active[i] - 1) === 0
    approvals[i][j]     approvals[i][j] * (approvals[i][j] - 1) === 0
    raw_count[i]        === sum of approvals[i][*]                (exact sum)
    effective_count[i]  === raw_count[i] * is_active[i]           (padding gate)
    quorum_margin[i]    === effective_count[i] - threshold * is_active[i]
                        and quorum_margin[i] >= 0, so an active step must reach
                        the threshold and an inactive step must contribute zero
    step_digest[i]      === Poseidon(STEP_DIGEST_TAG, effective_count[i], event_root)
    chained_root[i]     === Poseidon(STEP_CHAIN_TAG, root[i-1], step_digest[i])
    root[i]             === is_active[i] * chained_root[i]
                            + (1 - is_active[i]) * root[i-1]
    root[-1]            is chain_start_root (public)
    root[N-1]           === chain_end_root (public)

    chain_length        === sum of is_active[*]      (the count cannot be faked)
    chain_length        in [1, N]                    (range-checked with bits,
                                                      not asserted by convention)
    threshold           === REGISTERED_THRESHOLD     (policy fixed at compile
                                                      time, as in the single-
                                                      statement circuit)
    domain_tag          === DOMAIN_TAG               (see the DST note below)
    event_root          appears in every step digest, so it cannot be varied
    chain_start_root     === root[-1] by construction
    chain_end_root       === root[N-1] by construction
    end != start         IsEqual(...).out === 0      (a chain that does not move
                                                      the root is not a chain)

  ---------------------------------------------------------------------------
  PADDING, AND WHY IT IS CONSTRAINED RATHER THAN SKIPPED
  ---------------------------------------------------------------------------
  The circuit has a fixed capacity of N steps. A real chain may be shorter, so
  the length is carried as a public input and each step carries `is_active`.
  An inactive step's contribution is zeroed twice: its count is gated to zero
  before it reaches the digest (effective_count), and its root stays exactly the
  previous root. Zeroing only in the witness would not be enough -- a prover
  could then claim activity for a step it never proved -- which is why both are
  equality constraints and both are covered by a negative test.

  ---------------------------------------------------------------------------
  DOMAIN SEPARATION
  ---------------------------------------------------------------------------
  The tag is deliberately different from the label the single-statement circuit
  and the BLS hash-to-curve path use. Two statements that share a label can be
  substituted for one another; these two cannot:

      step chain        : lumen-gate-step-chain-v1   (chain link)
                          lumen-gate-step-digest-v1  (per-step evidence digest)
      single statement  : lumen-gate-finality-v1     (the BLS hash-to-curve DST,
                                                        untouched)

  The tags are compiled in as constants and the prover must also pass the chain
  tag as a public input, where it is constrained to equal the constant. That
  makes the tag part of the proven statement instead of a comment.

  No `signal output` anywhere, deliberately: any output would become an extra
  public input and shift the indices the verifier contract expects.
*/

// keccak-free offline derivation: sha256(label)[0..31] reduced into the BN254
// scalar field. Kept as literals so the compiler, the converter and the
// contract all agree byte for byte.
//
//   lumen-gate-step-chain-v1  -> 0x9517e443e84062a6781b2a92160d0a325f4c5a45826a0c0b54644e2ed574f0
//   lumen-gate-step-digest-v1 -> 0x9802bb8ee4e4b5e4b258f187ec319ec8c921d861890738a2adea76e88c1e42

template StepChainStatement(nSteps, nApprovers, registeredThreshold) {
    // ---- public ------------------------------------------------------------
    signal input chain_start_root;
    signal input chain_end_root;
    signal input event_root;
    signal input threshold;
    signal input chain_length;
    signal input domain_tag;

    // ---- private -----------------------------------------------------------
    signal input approvals[nSteps][nApprovers];
    signal input is_active[nSteps];
    signal input intermediate_roots[nSteps];

    var CHAIN_TAG = 263425106837261827811471650765498057995509407007498039180851432033046852848;
    var DIGEST_TAG = 268579613897541456733438126313361445880145453720266680290563490332889849410;
    var BITS = 8;

    // Everything is declared in the initial scope, because circom only allows
    // signal and component declarations there. The loops below only wire them.
    signal approvals_prefix[nSteps][nApprovers + 1];
    signal active_prefix[nSteps + 1];
    signal effective[nSteps];
    signal quorum_margin[nSteps];
    signal root[nSteps];
    signal raw_count_sequence[nSteps];

    component policy;
    component tag;
    component length_bits;
    component length_at_least_one;
    component length_within_capacity;
    component length_matches;
    component moved;
    component digest_zero;
    component digests[nSteps];
    component links[nSteps];
    component quorum[nSteps];
    component margin_bits[nSteps];

    // -- policy and domain separation are constants of the statement ---------
    policy = IsEqual();
    policy.in[0] <== threshold;
    policy.in[1] <== registeredThreshold;
    policy.out === 1;

    tag = IsEqual();
    tag.in[0] <== domain_tag;
    tag.in[1] <== CHAIN_TAG;
    tag.out === 1;

    // -- chain_length is a real length, not a number the prover likes --------
    // Num2Bits constrains the bits, so chain_length cannot be an arbitrary field
    // element dressed up as a small number.
    length_bits = Num2Bits(BITS);
    length_bits.in <== chain_length;

    length_at_least_one = GreaterEqThan(BITS);
    length_at_least_one.in[0] <== chain_length;
    length_at_least_one.in[1] <== 1;
    length_at_least_one.out === 1;

    length_within_capacity = LessEqThan(BITS);
    length_within_capacity.in[0] <== chain_length;
    length_within_capacity.in[1] <== nSteps;
    length_within_capacity.out === 1;

    // -- walk the chain ------------------------------------------------------
    // Inactive steps are no-ops: they add nothing to the active count (the
    // prefix below) and they leave the root exactly as it was.
    active_prefix[0] <== 0;

    for (var i = 0; i < nSteps; i++) {
        // activity is a bit
        is_active[i] * (is_active[i] - 1) === 0;

        // approvals are bits and the count is their exact running sum
        approvals_prefix[i][0] <== 0;
        for (var j = 0; j < nApprovers; j++) {
            approvals[i][j] * (approvals[i][j] - 1) === 0;
            approvals_prefix[i][j + 1] <== approvals_prefix[i][j] + approvals[i][j];
        }
        raw_count_sequence[i] <== approvals_prefix[i][nApprovers];

        // The padding gate. An inactive step contributes nothing to the count,
        // and this is an equality constraint, not a witness-side courtesy.
        effective[i] <== raw_count_sequence[i] * is_active[i];

        // A step that claims to be active must carry a quorum; an inactive step
        // must contribute exactly zero. Both are the same constraint:
        //   effective >= threshold * is_active
        quorum[i] = GreaterEqThan(BITS + 2);
        quorum[i].in[0] <== effective[i];
        quorum[i].in[1] <== threshold * is_active[i];
        quorum[i].out === 1;

        // The margin is range-checked as well, so a field-wrapping negative
        // margin cannot masquerade as a large positive one.
        quorum_margin[i] <== effective[i] - threshold * is_active[i];
        margin_bits[i] = Num2Bits(BITS + 2);
        margin_bits[i].in <== quorum_margin[i] + (1 << (BITS + 1));

        // The step's own evidence digest, tagged with its own DST.
        digests[i] = Poseidon(3);
        digests[i].inputs[0] <== DIGEST_TAG;
        digests[i].inputs[1] <== effective[i];
        digests[i].inputs[2] <== event_root;

        // The link: this step's digest applied to the previous root.
        links[i] = Poseidon(3);
        links[i].inputs[0] <== CHAIN_TAG;
        links[i].inputs[1] <== i == 0 ? chain_start_root : root[i - 1];
        links[i].inputs[2] <== digests[i].out;

        // The selector: an inactive step leaves the state exactly where it was.
        root[i] <== is_active[i] * (links[i].out - (i == 0 ? chain_start_root : root[i - 1]))
                   + (i == 0 ? chain_start_root : root[i - 1]);

        // The prover's declared intermediate root must be exactly the derived
        // one, so `intermediate_roots` is a convenience for the caller rather
        // than an input the prover controls.
        intermediate_roots[i] === root[i];

        active_prefix[i + 1] <== active_prefix[i] + is_active[i];
    }

    // -- the chain length is the number of steps that actually ran -----------
    length_matches = IsEqual();
    length_matches.in[0] <== active_prefix[nSteps];
    length_matches.in[1] <== chain_length;
    length_matches.out === 1;

    // -- the published end root is the last derived root ---------------------
    chain_end_root === root[nSteps - 1];

    // -- a chain that does not move the state is not a chain -----------------
    moved = IsEqual();
    moved.in[0] <== chain_start_root;
    moved.in[1] <== chain_end_root;
    moved.out === 0;

    // -- the digest of the first step is never the zero element --------------
    digest_zero = IsZero();
    digest_zero.in <== digests[0].out;
    digest_zero.out === 0;
}

// Four steps, three approvers per step, the same 2-of-3 policy the deployed BLS
// lane uses. Public input order is fixed by the verifier contract:
//
//   public_inputs[0] = chain_start_root
//   public_inputs[1] = chain_end_root   <-- the commitment the registry binds
//   public_inputs[2] = event_root
//   public_inputs[3] = threshold
//   public_inputs[4] = chain_length
//   public_inputs[5] = domain_tag
component main {public [chain_start_root, chain_end_root, event_root, threshold, chain_length, domain_tag]} = StepChainStatement(4, 3, 2);
