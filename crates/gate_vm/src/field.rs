//! BN254 scalar-field arithmetic for the gate VM witness generator.
//!
//! Values are stored as four little-endian u64 limbs in standard form so the
//! generated constant tables can be `const`; arithmetic converts to
//! `num-bigint` on the spot. That is deliberately not fast — and it must not
//! be wrong in a subtle way: a field bug here produces traces the circuit
//! refuses, which is a loud failure, but a field bug that happens to agree
//! with the circuit's mistakes would be silent. The single formula every
//! operation shares with the circuit is `(a op b) mod p`, so the conversion
//! keeps the semantics in one line each.

use num_bigint::BigUint;
use num_traits::{One, Zero};

/// The BN254 scalar modulus, decimal.
///
/// The canonical hex of the same prime is
/// `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`,
/// and the test below re-checks that pairing digit by digit: a mistyped
/// decimal here would not fail loudly, it would build a *wrong field* the
/// circuit quietly refuses.
const MODULUS: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fp {
    limbs: [u64; 4],
}

impl Fp {
    pub const ZERO: Fp = Fp {
        limbs: [0, 0, 0, 0],
    };
    pub const ONE: Fp = Fp {
        limbs: [1, 0, 0, 0],
    };

    /// Const constructor from a 64-hex-character big-endian literal, so the
    /// generated constant tables need no runtime initialiser.
    const fn nibble(c: u8) -> u64 {
        match c {
            b'0'..=b'9' => (c - b'0') as u64,
            b'a'..=b'f' => (c - b'a') as u64 + 10,
            b'A'..=b'F' => (c - b'A') as u64 + 10,
            _ => panic!("non-hex character"),
        }
    }

    pub const fn from_hex(text: &str) -> Fp {
        let bytes = text.as_bytes();
        if bytes.len() != 64 {
            panic!("expected 64 hex characters");
        }

        let mut limbs = [0u64; 4];
        let mut slot = 0;
        while slot < 4 {
            // Big-endian text: limb 0 carries the last 16 characters.
            let base = (3 - slot) * 16;
            let mut j = 0;
            while j < 16 {
                limbs[slot] = (limbs[slot] << 4) | Self::nibble(bytes[base + j]);
                j += 1;
            }
            slot += 1;
        }
        Fp { limbs }
    }

    fn modulus() -> BigUint {
        MODULUS.parse::<BigUint>().expect("decimal modulus")
    }

    fn to_big(&self) -> BigUint {
        let mut acc = BigUint::zero();
        for limb in self.limbs.iter().rev() {
            acc <<= 64;
            acc += BigUint::from(*limb);
        }
        acc
    }

    /// Parse an unsigned decimal string, reduced mod p. The golden Poseidon
    /// fixtures are decimal for exactly this constructor's benefit: both the
    /// snarkjs side and this one speak plain integers, so no hex convention
    /// can drift between them.
    pub fn from_decimal(s: &str) -> Result<Fp, String> {
        let v = s.trim().parse::<BigUint>().map_err(|e| e.to_string())?;
        Ok(Self::from_big(&(v % Self::modulus())))
    }

    pub fn to_decimal(&self) -> String {
        self.to_big().to_string()
    }

    fn from_big(v: &BigUint) -> Fp {
        let mut limbs = [0u64; 4];
        let bytes = v.to_bytes_le();
        // The cap is checked up front — on the byte length, so no partial
        // write can land before the refusal — and the loop is a plain fold.
        assert!(bytes.len() <= 32, "value exceeds 256 bits");
        let mut slot = 0usize;
        for chunk in bytes.chunks(8) {
            let mut limb = 0u64;
            // Little-endian bytes in a little-endian limb: forward order, no
            // reversal. (A reversed read is invisible for values that fit in
            // one short chunk and corrupts everything above; this comment is
            // the tombstone of exactly that bug.)
            for (i, byte) in chunk.iter().enumerate() {
                limb |= (*byte as u64) << (i * 8);
            }
            limbs[slot] = limb;
            slot += 1;
        }
        Fp { limbs }
    }

    pub fn add(&self, other: &Fp) -> Fp {
        let m = Self::modulus();
        Self::from_big(&((self.to_big() + other.to_big()) % &m))
    }

    pub fn sub(&self, other: &Fp) -> Fp {
        let m = Self::modulus();
        let a = self.to_big();
        let b = other.to_big();
        if a >= b {
            Self::from_big(&((a - b) % &m))
        } else {
            Self::from_big(&((&m - (b - a)) % &m))
        }
    }

    pub fn mul(&self, other: &Fp) -> Fp {
        let m = Self::modulus();
        Self::from_big(&((self.to_big() * other.to_big()) % &m))
    }

    /// x^5 — the S-box the circomlib Sigma template computes.
    pub fn pow5(&self) -> Fp {
        let x2 = self.mul(self);
        let x4 = x2.mul(&x2);
        x4.mul(self)
    }

    pub fn inverse(&self) -> Option<Fp> {
        let m = Self::modulus();
        let a = self.to_big();
        if a.is_zero() {
            return None;
        }
        // Fermat: a^(m-2) is the inverse in a prime field.
        Some(Self::from_big(&a.modpow(&(&m - BigUint::from(2u64)), &m)))
    }

    pub fn is_zero(&self) -> bool {
        self.to_big().is_zero()
    }

    pub fn is_one(&self) -> bool {
        self.to_big() == BigUint::one()
    }

    pub fn to_hex(&self) -> String {
        let bytes = self.to_big().to_bytes_be();
        let mut out = String::from("0x");
        // Two hex characters per missing byte, not one: a field element with
        // a leading zero byte is otherwise one character short of canonical,
        // and "one character short" is invisible until a hash of it never
        // matches. Padding is expressed on the byte axis to stay honest to
        // to_bytes_be, the encoding the registry actually consumes.
        for _ in bytes.len()..32 {
            out.push_str("00");
        }
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    /// Big-endian, left-padded to 32 bytes — the root encoding every lane of
    /// the registry consumes.
    pub fn to_bytes_be(&self) -> Vec<u8> {
        let bytes = self.to_big().to_bytes_be();
        let mut out = vec![0u8; 32 - bytes.len().min(32)];
        out.extend_from_slice(&bytes);
        out
    }

    pub fn to_hex64(&self) -> String {
        self.to_hex()[2..].to_string()
    }

    pub fn from_u64(v: u64) -> Fp {
        Fp {
            limbs: [v, 0, 0, 0],
        }
    }

    pub fn limbs(&self) -> &[u64; 4] {
        &self.limbs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_hex64_keeps_leading_zero_bytes() {
        // The canonical 32-byte encoding pads on the byte axis; a value
        // whose top byte is zero must still print 64 characters. An earlier
        // version of this padding pushed a single '0' per missing byte and
        // produced a 63-character root — matching nothing, erroring never.
        let v = Fp::from_u64(0xff);
        let h = v.to_hex64();
        assert_eq!(h.len(), 64);
        assert_eq!(&h[..62], "0".repeat(62).as_str());
        assert_eq!(&h[62..], "ff");
        assert_eq!(Fp::ZERO.to_hex64(), "0".repeat(64));
    }

    #[test]
    fn test_modulus_is_the_prime_the_circuit_uses() {
        // Guards the MODULUS string against a silent typo: the value must be
        // the BN254 scalar prime in its canonical hex form, bit-exact.
        let m = Fp::modulus();
        let want = BigUint::parse_bytes(
            b"30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
            16,
        )
        .unwrap();
        assert_eq!(m, want);
        assert_eq!(
            m.bits(),
            254,
            "p must be 254 bits; anything else is not this curve's field"
        );
    }

    #[test]
    fn test_from_hex_matches_u64_constructor() {
        let a = Fp::from_u64(0xdead_beef);
        let b = Fp::from_hex(&format!("{:064x}", 0xdead_beefu64));
        assert_eq!(a, b);
    }

    #[test]
    fn test_field_axioms() {
        let x = Fp::from_u64(7);
        let y = Fp::from_u64(11);
        assert_eq!(x.mul(&y), y.mul(&x));
        assert_eq!(x.add(&y), Fp::from_u64(18));
        assert_eq!(x.sub(&x), Fp::ZERO);
        let inv = x.inverse().expect("non-zero");
        assert_eq!(x.mul(&inv), Fp::ONE);
        // Fermat's little theorem on a generator-scale value.
        let g = Fp::from_u64(5);
        let m_minus_1: BigUint = Fp::modulus() - BigUint::one();
        assert_eq!(
            Fp::from_big(&g.to_big().modpow(&m_minus_1, &Fp::modulus())),
            Fp::ONE
        );
    }
}

#[cfg(test)]
mod dbg_tests {
    use super::*;
    #[test]
    fn dbg_modpow() {
        let m = Fp::modulus();
        let e: BigUint = &m - BigUint::one();
        let r = BigUint::from(5u32).modpow(&e, &m);
        println!("bits m {} bits e {} res {}", m.bits(), e.bits(), r);
        let small = BigUint::from(5u32).modpow(&BigUint::from(6u32), &BigUint::from(7u32));
        println!("sanity 5^6 mod 7 = {} (want 1)", small);
    }
}
