//! The Poseidon(t=3) permutation over the BN254 scalar field, matching the
//! pinned circomlib `PoseidonEx(2, 1)` template that `Poseidon(2)` instantiates
//! — the very component the circuit uses.
//!
//! Why a port and not a dependency: the machine's hash opcode and the circuit's
//! program-root fold must agree with circomlib to the last round constant, and
//! the only authority is `node_modules/circomlib/circuits/poseidon.circom`.
//! The constants in `poseidon_consts.rs` are machine-parsed from that file
//! (see `circuits/gen_poseidon3.py`), and this file mirrors the template's
//! round structure line for line:
//!
//! * `state = [initialState, x0, x1]` with `initialState = 0` (template lines
//!   wiring `ark[0]`).
//! * 4 leading full rounds: sigma all, add C, MDS `M`; the fourth full round
//!   before the partial phase uses the P matrix (`mix[nRoundsF\2-1] = Mix(t,P)`,
//!   the optimized final-round-before-partial variant).
//! * 57 partial rounds through `MixS`, which folds the next round's constant
//!   addition for all but the sbox'd element — hence the S array's
//!   `(2t-1)`-wide rows.
//! * 3 trailing full rounds with constants `C[71 + 3r]`, then the final sigma
//!   and `MixLast(t, M, 0)` — and no ark after it: circomlib's last round is
//!   ark-free, which the Rust side must also respect.
//!
//! A disagreement here cannot pass silently: the circuit re-computes every
//! poseidon step the trace claims, so wrong constants mean the witness simply
//! fails to satisfy the constraints at proving time.

use crate::field::Fp;

mod consts {
    #![allow(clippy::all)]
    include!("poseidon_consts.rs");
}

const N_FULL: usize = 8;
const N_PARTIAL: usize = 57; // PoseidonEx indexes N_ROUNDS_P[t-2]; t=3 -> 57
const T: usize = 3;

fn sigma_all(state: &mut [Fp; T]) {
    for slot in state.iter_mut() {
        *slot = slot.pow5();
    }
}

fn mds(m: &[Fp; 9], state: &[Fp; T]) -> [Fp; T] {
    // The template's Mix: out[i] = Σ_j M[j][i] * in[j]  (column j, row i).
    let mut out = [Fp::ZERO; T];
    for (i, slot) in out.iter_mut().enumerate() {
        for j in 0..T {
            *slot = slot.add(&m[j * T + i].mul(&state[j]));
        }
    }
    out
}

/// `Poseidon(2)` as the circuit computes it: two field elements in, one out.
pub fn poseidon2(x0: &Fp, x1: &Fp) -> Fp {
    let c = &consts::C;
    let s = &consts::S;
    let m = &consts::M;
    let p = &consts::P;

    let mut state = [Fp::ZERO, x0.clone(), x1.clone()];
    // ark[0]
    for j in 0..T {
        state[j] = state[j].add(&c[j]);
    }
    // Leading full rounds except the last (template loop r < nRoundsF/2 - 1).
    for r in 0..(N_FULL / 2 - 1) {
        sigma_all(&mut state);
        for j in 0..T {
            state[j] = state[j].add(&c[(r + 1) * T + j]);
        }
        state = mds(m, &state);
    }
    // The round that enters the partial phase: sigma, ark, then P.
    sigma_all(&mut state);
    for j in 0..T {
        state[j] = state[j].add(&c[(N_FULL / 2) * T + j]);
    }
    state = mds(p, &state);
    // Partial rounds. MixS consumes the sigma'd, constant-added first element.
    for r in 0..N_PARTIAL {
        state[0] = state[0].pow5().add(&c[(N_FULL / 2 + 1) * T + r]);
        let first = state[0].clone();
        let mut next = [Fp::ZERO; T];
        for i in 0..T {
            next[0] = next[0].add(&s[(T * 2 - 1) * r + i].mul(&state[i]));
        }
        for i in 1..T {
            next[i] = state[i].add(&first.mul(&s[(T * 2 - 1) * r + T + i - 1]));
        }
        state = next;
    }
    // Trailing full rounds.
    for r in 0..(N_FULL / 2 - 1) {
        sigma_all(&mut state);
        for j in 0..T {
            state[j] = state[j].add(&c[(N_FULL / 2 + 1) * T + N_PARTIAL + r * T + j]);
        }
        state = mds(m, &state);
    }
    // Final sigma and MixLast(t, M, 0); no ark, exactly as the template ends.
    sigma_all(&mut state);
    let mut out = Fp::ZERO;
    for j in 0..T {
        out = out.add(&m[j * T].mul(&state[j]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_poseidon_is_deterministic_and_non_degenerate() {
        let a = poseidon2(&Fp::ZERO, &Fp::ZERO);
        let b = poseidon2(&Fp::ZERO, &Fp::ONE);
        assert_ne!(a, b);
        assert!(!a.is_zero());
        assert_eq!(a, poseidon2(&Fp::ZERO, &Fp::ZERO));
    }
}
