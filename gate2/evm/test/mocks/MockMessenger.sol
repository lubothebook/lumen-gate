pragma solidity 0.8.30;

import {MockERC20} from "./AdversarialTokens.sol";

// Minimal view of the Circle V2 source-chain messenger, per
// developers.circle.com CCTP docs (Stellar path uses depositForBurnWithHook
// with destinationCaller + maxFee + minFinalityThreshold + hookData).
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint16 maxFee,
        uint240 minFinalityThreshold,
        bytes calldata hookData
    ) external returns (uint64);
}

// Records exactly what the router asked Circle to do; actually pulls the USDC
// like the real burn flow does (transferFrom), so router-side accounting is
// exercised end-to-end.
contract MockTokenMessenger is ITokenMessengerV2 {
    MockERC20 public immutable usdc;
    uint64 public nonceCounter = 4241;
    uint64 public lastNonce;

    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastMintRecipient;
    bytes32 public lastDestCaller;
    uint16 public lastMaxFee;
    uint240 public lastMinFinality;
    bytes public lastHook;
    uint256 public callCount;
    uint256 public lastAllowanceSeen; // lets tests prove the exact-amount approve (never type(uint256).max)

    constructor(address usdc_) { usdc = MockERC20(usdc_); }

    function depositForBurnWithHook(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient,
        address /* burnToken */, bytes32 destinationCaller, uint16 maxFee,
        uint240 minFinalityThreshold, bytes calldata hookData
    ) external returns (uint64) {
        callCount += 1;
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastDestCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinality = minFinalityThreshold;
        lastHook = hookData;
        lastAllowanceSeen = usdc.allowance(msg.sender, address(this));
        // exact-amount consume, real-USDC semantics: allowance decremented
        usdc.transferFrom(msg.sender, address(this), amount);
        unchecked { usdc.burnBalance(amount); }
        lastNonce = ++nonceCounter;
        return lastNonce;
    }

    function hookLen() external view returns (uint256) { return lastHook.length; }
}

// Fixed-rate swap venue stub. `rateNum/rateDen` scale token->USDC so tests can
// force slippage below minOut or simulate hostile fills. `stealOnSwap` models
// a venue (or rebase) that leaves the router holding less than delivered.
contract MockSwapRouter {
    MockERC20 public immutable usdc;
    uint256 public rateNum = 2; // 2 USDC per token
    uint256 public rateDen = 1;
    bool public stealAll;       // swap returns zero USDC

    error SwapFailed();

    constructor(address usdc_) { usdc = MockERC20(usdc_); }

    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function setStealAll(bool s) external { stealAll = s; }

    // the router PUSHED tokens to this venue; settle pays USDC out for whatever
    // balance is actually here (fee-on-transfer shrinks it - measurement, not claim)
    function settle(address token, uint256 amount, address payer) external returns (uint256 out) {
        MockERC20 t = MockERC20(token);
        uint256 held = t.balanceOf(address(this));
        if (held > amount) held = amount; // pay for THIS push, state carried across calls must not inflate it
        if (stealAll) return 0;
        out = (held * rateNum) / rateDen;
        usdc.mintBalance(payer, out);
        return out;
    }
}
