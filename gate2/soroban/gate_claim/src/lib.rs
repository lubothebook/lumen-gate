//! Gate 2.0 skeleton. The claim contract itself is F2 work, gated on the S1
//! spike (deployments/testnet-2.0.json). Until then this crate exists only so
//! the workspace member list in the root Cargo.toml is honest and compiles;
//! there is deliberately no contract logic and no claim to test.
#![no_std]
#[cfg(test)]
mod test {
    #[test]
    fn skeleton_compiles() {}
}
