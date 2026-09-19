pragma circom 2.0.0;

/*
  FEASIBILITY PROBE — not a lane. This file exists to answer one measured
  question, and the answer is a number, not a promise: what does checking a
  signature *inside* a circuit cost in constraints, using the stack this
  repository already pins?

  The subject is circomlib's EdDSAPoseidonVerifier: a full Schnorr-style
  verify over the babyjubjub group — decompose the 253-bit scalar, reject
  S >= subgroup order, decompose the message, hash (Ax, Ay, M) with
  Poseidon, then recover the Edwards point from its Montgomery u-coordinate
  and check `[S]B == R8 + [h]A` as point arithmetic. That pipeline — bit
  decomposition of scalars, a hash into the scalar field, a fixed-window
  ladder of mixed additions — is the *shape* any signature gadget has,
  including one for BLS over BN254, whose pairing step the lane would still
  owe on top. It is not the same scheme and nobody should read it as one;
  it is the closest honest measurement available without vendoring a
  pairing library, and the ratio it establishes — verifier gadget versus
  everything else a lane already costs — is what the budget verdict in
  docs/PROVING_SYSTEM.md §5e uses.

  No input here is a secret from any live system; no ceremony is spent on
  it; nothing imports it. If a signature lane is ever built, it starts by
  deleting this file and starting from its measured numbers.
*/

include "circomlib/eddsaposeidon.circom";

component main = EdDSAPoseidonVerifier();
