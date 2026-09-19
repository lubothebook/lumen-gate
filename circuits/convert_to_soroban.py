#!/usr/bin/env python3
"""
Convert snarkjs Groth16 artifacts into the exact byte layout the Lumen Gate
Soroban verifier expects.

The verifier (contracts/finality_registry/src/lib.rs, mod groth16) reads:

    proof : A(G1,64) || B(G2,128) || C(G1,64)                    = 256 bytes
    vk    : alpha(G1,64) || beta(G2,128) || gamma(G2,128)
            || delta(G2,128) || IC[0..n](G1,64 each)             = 768 bytes for n=4

Point encoding:

    G1 = X(32) || Y(32)                      big-endian field elements
    G2 = X(64) || Y(64)                      each Fp2 coordinate as c1(32) || c0(32)
                                             -- imaginary part FIRST

That last line is the trap. snarkjs writes Fp2 coordinates as [c0, c1] (real
first). Soroban wants the imaginary part first, so every G2 coordinate is
swapped here. Getting this backwards produces a 768-byte key of the right
length that simply fails every pairing check, which is the worst kind of bug:
it looks correct and fails at runtime.

Usage:
    python3 convert_to_soroban.py vk.json proof.json public.json out_prefix
"""

import json
import sys

# BN254 base field modulus (Fq), for sanity checks on coordinate width.
FQ_MODULUS_BITS = 254


def g1_point(p):
    """snarkjs G1 in affine form -> 64 bytes, X||Y big-endian."""
    x = int(p[0]) % (1 << FQ_MODULUS_BITS)
    y = int(p[1]) % (1 << FQ_MODULUS_BITS)
    return x.to_bytes(32, "big") + y.to_bytes(32, "big")


def g2_point(p):
    """snarkjs G2 -> 128 bytes.

    snarkjs encodes each Fp2 coordinate as [c0, c1]. Soroban (like most
    pairing precompiles) wants c1 first. Swap.
    """
    x_c0, x_c1 = int(p[0][0]), int(p[0][1])
    y_c0, y_c1 = int(p[1][0]), int(p[1][1])
    x = x_c1.to_bytes(32, "big") + x_c0.to_bytes(32, "big")
    y = y_c1.to_bytes(32, "big") + y_c0.to_bytes(32, "big")
    return x + y


def vk_bytes(vk):
    out = bytearray()
    out += g1_point(vk["vk_alpha_1"])
    out += g2_point(vk["vk_beta_2"])
    out += g2_point(vk["vk_gamma_2"])
    out += g2_point(vk["vk_delta_2"])
    for ic in vk["IC"]:
        out += g1_point(ic)
    return bytes(out)


def proof_bytes(proof):
    out = bytearray()
    out += g1_point(proof["pi_a"])
    out += g2_point(proof["pi_b"])
    out += g1_point(proof["pi_c"])
    return bytes(out)


def main():
    vk_path, proof_path, public_path, prefix = sys.argv[1:5]

    vk = json.load(open(vk_path))
    proof = json.load(open(proof_path))
    public = json.load(open(public_path))

    # snarkjs says "bn128"; Soroban says BN254. Same curve, different name.
    assert vk["protocol"] == "groth16", vk["protocol"]
    assert vk["curve"] in ("bn128", "bn254"), vk["curve"]
    assert vk["nPublic"] == 4, f"verifier expects 4 public inputs, got {vk['nPublic']}"
    assert len(vk["IC"]) == vk["nPublic"] + 1

    vb = vk_bytes(vk)
    pb = proof_bytes(proof)
    assert len(vb) == 768, f"vk must be 768 bytes, got {len(vb)}"
    assert len(pb) == 256, f"proof must be 256 bytes, got {len(pb)}"

    open(f"{prefix}_vk.hex", "w").write(vb.hex())
    open(f"{prefix}_proof.hex", "w").write(pb.hex())

    # Public signals layout differs across snarkjs versions: some emit a
    # leading "1" for the constant term, some go straight to the declared
    # public inputs. Normalise on the count rather than assuming either shape,
    # because silently keeping or dropping one element shifts every index and
    # the on-chain verifier would be reading the wrong vector.
    n = vk["nPublic"]
    if len(public) == n + 1 and public[0] == "1":
        inputs = public[1:]
    elif len(public) == n:
        inputs = public
    else:
        raise AssertionError(
            f"expected {n} public inputs (or {n + 1} with a leading constant), got {len(public)}"
        )
    open(f"{prefix}_public.json", "w").write(json.dumps(inputs, indent=2))

    print(f"vk     : {len(vb)} bytes -> {prefix}_vk.hex")
    print(f"proof  : {len(pb)} bytes -> {prefix}_proof.hex")
    print(f"inputs : {len(inputs)} -> {prefix}_public.json")
    for name, val in zip(
        ["prev_state_root", "event_root", "threshold", "state_root"], inputs
    ):
        print(f"  [{name:>15}] {val}")


if __name__ == "__main__":
    main()
