# BurnRouter build toolchain pin (Ek A 4.6: no floating assumptions)

- foundry 1.8.3 (foundryup stable, 2026-09-15 build cae51ad458)
- solc 0.8.30 pinned in foundry.toml; via_ir + optimizer 200 runs (stack-too-deep at 8-arg Circle V2 call without IR)
- forge-std: cloned at CI time (`git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std`), not vendored into git; tests import it, the production contract imports NOTHING (no OpenZeppelin dependency - the guard is a documented same-pattern equivalent)
- slither 0.30.x via pip, --solc ~/.svm/0.8.30/solc-0.8.30
- reproduce: `foundryup && forge test && forge build --sizes`
