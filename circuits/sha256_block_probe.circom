pragma circom 2.0.0;

/*
  FEASIBILITY PROBE — not a lane. One unit of the only hash Stellar's
  transaction digests actually use: a single 512-bit SHA-256 compression,
  compiled from the pinned circomlib's own gadget, counted, and quoted.

  This number exists for one purpose: the outbound direction of a
  validator-light bridge (verify a Stellar-side burn inside a proof, see
  docs/BRIDGE_TRUST_MODEL.md) needs SHA-256 *inside* a BN254 circuit, so the
  per-block cost is the floor any such design pays before it adds signature
  aggregation on top. Measured on the stack we ship, not borrowed from a
  paper about someone else's. No witness is generated, no ceremony is spent;
  `snarkjs r1cs info` on the build report is the whole life of this file.
*/

include "circomlib/sha256/sha256.circom";

template Sha256BlockProbe() {
    signal input in[512];
    signal output out[256];

    component block = Sha256(512);
    for (var i = 0; i < 512; i++) {
        block.in[i] <== in[i];
    }
    for (var i = 0; i < 256; i++) {
        out[i] <== block.out[i];
    }
}

component main = Sha256BlockProbe();
