//! Gate 2.0 skeleton. The claim contract itself is F2 work, gated on the S1
//! spike (deployments/testnet-2.0.json). Until then this crate exists only so
//! the workspace member list in the root Cargo.toml is honest and compiles;
//! there is deliberately no contract logic and no claim to test.
#![no_std]
// The SDK dependency below is what supplies the panic handler for
// wasm32v1-none; referencing it keeps that guarantee explicit (the 1.0 ci's
// clippy/wasm steps failed on a no_std crate whose only dependency sat
// unused - fixed at the root instead of by silencing the lint).
#[allow(unused_imports)]
use soroban_sdk as _;
#[cfg(test)]
mod test {
    #[test]
    fn skeleton_compiles() {}
}
