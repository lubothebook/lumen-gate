// Deterministic test venue for the Gate 2.0 test lane (operator decision,
// DIRECTIVE 2.0 S1-style call: testnet uses a deterministic venue, mainnet
// venue is a separate directive). Deployed to Sepolia and labeled as such in
// deployments/testnet-2.0.json at deploy time.
//
// Properties (pinned by the venue test suite):
//   - NO owner, NO pause, NO privileged path: `setRate` is callable by anyone,
//     so there is no admin who can silently change economics mid-flow.
//   - Default rate is 1:1 for ANY ERC20 pushed in; per-token override via
//     setRate (num/den, den=0 means "use the 1:1 default").
//   - Pays USDC from its own INVENTORY (pre-loaded by the operator); it never
//     mints, never calls unknown addresses, its only external call is
//     USDC.transfer.
//   - `settle` pays for the balance actually HELD after the push, clamped to
//     this call's claimed amount: fee-on-transfer tokens deliver less, and
//     the venue (like the router) measures rather than claims. State carried
//     across calls must not inflate the payout (the clamp).
//   - Inventory exhaustion reverts (NoInventory) instead of paying short:
//     a venue that silently underpays would mask a router slippage bug.
pragma solidity 0.8.30;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TestVenue {
    IERC20Like public immutable USDC;

    struct Rate {
        uint256 num;
        uint256 den; // 0 => default 1:1
    }

    // den == 0 (unset) means 1:1
    mapping(address => Rate) public rate;

    event RateSet(address indexed token, uint256 num, uint256 den);

    error ZeroDenominator();
    error NoInventory();
    error UsdcPayFailed();

    constructor(address usdc_) {
        USDC = IERC20Like(usdc_);
    }

    function setRate(address token, uint256 num, uint256 den) external {
        if (den == 0 && num != 0) revert ZeroDenominator(); // den 0 is reserved for "default"
        rate[token] = Rate(num, den);
        emit RateSet(token, num, den);
    }

    /// @dev Called by the BurnRouter immediately after it PUSHED `amount`
    ///      tokens to this venue. Pays USDC out to `payer` (the router).
    function settle(address token, uint256 amount, address payer) external returns (uint256 out) {
        IERC20Like t = IERC20Like(token);
        uint256 held = t.balanceOf(address(this));
        if (held > amount) held = amount; // pay for THIS push; residue from earlier calls must not inflate
        Rate memory r = rate[token];
        out = r.den == 0 ? held : (held * r.num) / r.den;
        if (USDC.balanceOf(address(this)) < out) revert NoInventory();
        if (!USDC.transfer(payer, out)) revert UsdcPayFailed();
    }
}
