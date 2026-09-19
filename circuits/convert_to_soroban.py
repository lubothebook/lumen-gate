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
        [--public-names a,b,c,...] [--rust-out path] [--expect-inputs N]
        [--label "the execution trace circuit"]

Public input handling is count-driven rather than fixed: the single-statement
circuit has four public signals, the multi-step chained circuit has six, and the
verifier contract's VK layout follows the same count. A hard-coded four would
have made the second circuit look like a format error instead of a new circuit.
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


DEFAULT_NAMES = {
    4: ["prev_state_root", "event_root", "threshold", "state_root"],
    6: ["chain_start_root", "chain_end_root", "event_root", "threshold", "chain_length", "domain_tag"],
}


def main():
    argv = sys.argv[1:]
    names_override = None
    rust_out = None
    expect_inputs = None
    label = "the multi-step chained circuit"
    positional = []
    index = 0
    while index < len(argv):
        if argv[index] == "--public-names":
            names_override = argv[index + 1].split(",")
            index += 2
        elif argv[index] == "--rust-out":
            rust_out = argv[index + 1]
            index += 2
        elif argv[index] == "--expect-inputs":
            expect_inputs = int(argv[index + 1])
            index += 2
        elif argv[index] == "--label":
            label = argv[index + 1]
            index += 2
        else:
            positional.append(argv[index])
            index += 1
    if len(positional) < 4:
        raise SystemExit(__doc__)
    vk_path, proof_path, public_path, prefix = positional[:4]

    vk = json.load(open(vk_path))
    proof = json.load(open(proof_path))
    public = json.load(open(public_path))

    # snarkjs says "bn128"; Soroban says BN254. Same curve, different name.
    assert vk["protocol"] == "groth16", vk["protocol"]
    assert vk["curve"] in ("bn128", "bn254"), vk["curve"]
    if expect_inputs is not None:
        assert vk["nPublic"] == expect_inputs, (
            f"this artifact was expected to have {expect_inputs} public inputs, got {vk['nPublic']}"
        )
    assert vk["nPublic"] >= 1, "a circuit with no public inputs binds nothing"
    assert len(vk["IC"]) == vk["nPublic"] + 1

    vb = vk_bytes(vk)
    pb = proof_bytes(proof)

    # Explicit size checks. The contract rejects a wrong-length proof or key, and
    # it must: a decoder that accepts extra or missing bytes is a decoder that
    # reads a shift of the intended values. The expected lengths are derived from
    # the public input count, not assumed.
    expected_vk = 64 + 3 * 128 + (vk["nPublic"] + 1) * 64
    assert len(vb) == expected_vk, f"vk must be {expected_vk} bytes, got {len(vb)}"
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

    names = names_override or DEFAULT_NAMES.get(n)
    for position, val in enumerate(inputs):
        label = names[position] if names and position < len(names) else f"public_{position}"
        print(f"  [{label:>15}] {val}")

    if rust_out:
        write_rust_vectors(rust_out, vk, vb, pb, inputs, names, label)


def write_rust_vectors(path, vk, vb, pb, inputs, names, label):
    """Emits the Rust test-vector module so `cargo test` replays these bytes.

    A committed vector that no test loads is decoration. This writes the module
    the contract tests import, with the values that were just proved, so the
    verifier is exercised in the Soroban host against the real encoding rather
    than against something reconstructed later by hand.
    """
    labels = names or [f"public_{i}" for i in range(len(inputs))]
    lines = [
        "//! Generated by circuits/convert_to_soroban.py -- do not edit by hand.",
        "//!",
        f"//! Verifying key, proof and public inputs for {label},",
        "//! serialized in the byte layout the Soroban verifier reads.",
        "//! The contract tests replay exactly these bytes in the Soroban host.",
        "",
        f'pub const VK_HEX: &str = "{vb.hex()}";',
        "",
        f'pub const PROOF_HEX: &str = "{pb.hex()}";',
        "",
        f"pub const PUBLIC_INPUTS_HEX: [&str; {len(inputs)}] = [",
    ]
    for val in inputs:
        lines.append(f'    "{int(val).to_bytes(32, "big").hex()}",')
    lines.append("];")
    lines.append("")
    lines.append("/// Public signal order, so the contract test and this file cannot drift apart.")
    lines.append(f"pub const PUBLIC_INPUT_ORDER: [&str; {len(inputs)}] = [")
    for label in labels:
        lines.append(f'    "{label}",')
    lines.append("];")
    lines.append("")
    open(path, "w").write("\n".join(lines))
    print(f"rust   : {path}")


if __name__ == "__main__":
    main()
