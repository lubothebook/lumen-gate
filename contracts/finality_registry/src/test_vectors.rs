//! Static vectors captured from the live Groth16/BN254 lane and replayed by
//! the unit tests in `lib.rs`.
//!
//! # What these numbers are
//!
//! * `VK_HEX` is the 768-byte verification key produced by `snarkjs zkey export
//!   verificationkey` for `circuits/finality_statement.circom`, serialized with
//!   `circuits/convert_to_soroban.py`. The same 768 bytes were uploaded to the
//!   live registry with `set_vk` before its admin was renounced.
//! * `PROOF_HEX` is a 256-byte Groth16 proof (`A` G1 64 B, `B` G2 128 B, `C` G1
//!   64 B) for the block below. A byte-identical proof was accepted by the live
//!   registry on Stellar testnet; see README for the transaction.
//! * `PUBLIC_INPUTS_HEX` are the four public signals in circuit order:
//!   `[prev_state_root, event_root, threshold, state_root]`.
//! * `HEIGHT` / `STATE_ROOT_HEX` are the source block the proof is about. The
//!   contract takes the height and the root from the evidence payload and
//!   requires the last public signal to equal that root, so a valid proof for a
//!   different root is not a finality proof for this evidence.
//!
//! # Why the vectors are committed
//!
//! A verifier that never rejects anything is not a verifier. These vectors let
//! `cargo test` check three things without a network connection: the exact byte
//! encoding is accepted, a one-byte mutation of the proof is rejected, and a
//! proof whose public signals describe another root is rejected. The tests run
//! in the Soroban test host, so the BN254 pairing arithmetic that runs is the
//! same code the validators run in production.

/// Source-domain adapter id of the live source chain (sha256 of adapter id).
pub const ADAPTER_HEX: &str =
    "3dcbf6f582455337083d5f6d36721f6d63d47af0bef870a043c02aca7850dac9";

pub const NETWORK: &str = "source-testnet";

/// Verification key, 768 bytes.
pub const VK_HEX: &str = "29a17f2cc005065d9594a2a41c726dc6de9f494e01aa0d4fa11e34dccf92606814dfa067ddb0fce12ddea392adbcaffb7b9881eb37ca63dc9e19186908c46fac2092b8ec3c644c326566ec0736f9096fae4e7e8f7d5297a39897dc9782dec84123b885b82694e3ef883307ce9cb437e755ed33dcd0c77c0380a5201d1fac3fa626f4127764f82f05144546dc85f7b6e69270a09d44c7a67b416cffc11747e6fc1fe6a6e96aa78407632ff8c6096389275a5ee67415b047178c28b82eed68ad98198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa15c19a0ad86d87f9eeb73c0458e053e0a81f41b0961a04c28a5cd06e679448ab1ea01c46f144b941c1c216a157463af83cad305141ac16df2933ee846035ae4722eb340b9170b550bb00a1461b240c711711b8ee3f1e095e04de9906f246d69314c182ba976104693818240036506588a17ed45b0c6b5de8e3fef6096a398c2302c6f57442230071c6516f1c31c131335725a12e363e0644168b611d09be95c2025783fc6402a941c1945f1ddaad9f71cc1166b342923b9f5602b455f21acafd21a2ed783f6109a54ff252d6b4dca32501013b912ac3079722a8b1364a6d8a7103757619733d44d0a9174ae62ba8097d4f668c3ef27d9efbced3a2577f887e3007fe0ee501deda183270d6b7dc59874e9653bfb1f1b0b527965f5870d50cee1d14cc73d072f556944719e5ef19d820e7a8723a5f039718749831f6c0f2816a790a86cf7ec82fc40761289a9b353f7d96b09812166f1e5c04de077d1b3b9760510babcf7686bf69afd33069067105483a3acce74b2a2ce3f464b5ad2f61af14ac278feee9e1bbaad7d9a6d4c4de5d1be9b78728cc12a59f7f7af8bce0e39912752deff879b0c26f95ba4154e12ebcbee37dad4d3eedd92b6aaadce0afe2dab5a6";

/// Groth16 proof, 256 bytes.
pub const PROOF_HEX: &str = "03fd4f4d7643c88eb5eb7d0bdc029fe10554c25668280f9b8dfa794016d51f9e279e92f9d1927c9786a98f3a85c151f38daf7200da871984890a65def6b196ec25f9007f89594e14bfead9107adab2e12ecb7d7e4d66309f388161c34d4f4d5717c578d110bb62c6ce5428789872eb42223b5e04ac0802c92a7448bab16aeccf0ed8942847b6aca7cb0cc9cbce0cb86309b31d5273c61ea5bae67210ffb6e7070cdf71aeb8bc8f642fb8f77257fc6bd3b45c2d2530940de6d4c521bc0fa9870a2782c354c530d1ed16372ab5a1489d28dededc127df3f3b886ec470f18c2727821315f6f1aa9c6c842c71b809869ee60d6d40a8a56a00dddccb818e4aeb7adae";

/// Circuit public signals in circuit order.
pub const PUBLIC_INPUTS_HEX: [&str; 4] = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "22a028a4199a4e44c746b9a238235bc3ade9f89a45869a19ebdf1fe22056eae1",
    "0000000000000000000000000000000000000000000000000000000000000003",
    "0b2f6840916c8684b34c4e6ca3602d12526e23e1e4e6a9f2ddfef70342a67ff1",
];

/// Source block height the proof commits to.
pub const HEIGHT: u64 = 59;

/// Source state root the proof commits to (last public signal).
pub const STATE_ROOT_HEX: &str = "0b2f6840916c8684b34c4e6ca3602d12526e23e1e4e6a9f2ddfef70342a67ff1";

/// A state root that no proof in this file is about.
pub const OTHER_ROOT_HEX: &str =
    "00000000000000000000000000000000000000000000000000000000000000aa";
