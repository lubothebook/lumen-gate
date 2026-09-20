//! Gate 2.0 skeleton: the consumer demo (tiers over GateClaim.get_migration)
//! is F5 work. No logic until its acceptance evidence exists.
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
