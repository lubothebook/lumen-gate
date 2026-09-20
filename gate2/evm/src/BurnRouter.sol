// SPDX-License-Identifier: MIT
pragma solidity 0.8.30; // fixed version per HARDENING-2.0.md 4.6: the compiler pin is itself a frozen assumption

/// Minimal interfaces for the two external contracts the router touches.
/// Deliberately hand-written (no OpenZeppelin import): the annex says guard or
/// equivalent; fewer dependencies shrinks both the supply-chain surface and the
/// bytecode size cap (4.6).
interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface ISwapVenue {
    // venue settles against whatever balance it was just PUSHED (the router
    // never grants swap-side allowances - unlimited-approval ban applies to
    // the router's own approvals too, and a venue that demanded one would
    // reintroduce it)
    function settle(address token, uint256 amount, address payer) external returns (uint256);
}

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

/// BurnRouter: user tokens -> venue swap -> USDC delta -> Circle V2
/// depositForBurnWithHook with a Stellar CCTP-Forwarder hook that names the
/// final recipient. The router holds no value between interactions and has no
/// owner, no pause and no upgrade path (DIRECTIVE 2.0 section 3; the
/// kill-switch consequence in HARDENING-2.0.md 4.7 is a frontend config
/// removal, documented in docs/GATE2_TRUST_MODEL.md).
///
/// Order of operations is checks-effects-interactions per 4.1: every
/// user-supplied string, number and deadline is validated BEFORE any external
/// call; the only external calls run token-pull, venue-swap, exact-approve,
/// deposit - in that sequence, once each, with no router state mutated after
/// the first interaction (there is no mutable state to speak of).
contract BurnRouter {
    // ---------- errors (no revert strings on hot paths: cheap to match, cheap to read) ----------
    error Reentrancy();
    error InvalidRecipient();          // length/prefix/charset - format layer (4.4 negative A)
    error InvalidRecipientChecksum();  // well-formed but CRC16-XModem mismatch (4.4 negative B)
    error DeadlineExpired();
    error ZeroMinOut();
    error Slippage();
    error NoDelta();
    error TokenCallFailed();
    error RouterValueDrift();          // any USDC left on router other than pre-existing dust (4.2)

    event BurnInitiated(
        address indexed burner,
        address indexed token,
        uint256 usdcBurned,
        uint64 indexed nonce,
        uint64 burnNonceDomain27,
        string recipient
    );

    ITokenMessengerV2 public immutable MESSENGER;
    IERC20Like public immutable USDC;
    ISwapVenue public immutable SWAP;
    uint32 public immutable DEST_DOMAIN;
    bytes32 public immutable FORWARDER; // mintRecipient AND destinationCaller (D1: the forwarder)

    // ReentrancyGuard-equivalent in OpenZeppelin's exact pattern and naming,
    // so both the auditor and static analysis (slither's guarded-function
    // skip) recognize it; semantics identical to the annex 4.1 requirement.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _locked = _NOT_ENTERED;

    modifier nonReentrant() {
        if (_locked != _NOT_ENTERED) revert Reentrancy();
        _locked = _ENTERED;
        _;
        _locked = _NOT_ENTERED;
    }

    constructor(address messenger, address usdc, address swapVenue, uint32 destinationDomain, bytes32 forwarder) {
        MESSENGER = ITokenMessengerV2(messenger);
        USDC = IERC20Like(usdc);
        SWAP = ISwapVenue(swapVenue);
        DEST_DOMAIN = destinationDomain;
        FORWARDER = forwarder;
    }

    /// @param token      input ERC-20 (user-approved pull)
    /// @param amountIn   requested pull amount (NEVER trusted for burn size - measured)
    /// @param minOut     minimum USDC delta accepted; 0 is rejected (4.3)
    /// @param deadline   last block timestamp the user will execute at (4.3)
    /// @param maxFee     pass-through to Circle V2 (fees are explicit, never implicit)
    /// @param minFinalityThreshold Circle fast=1000 / standard=2000
    /// @param recipient  Stellar strkey (G, C or M class) that must land the funds
    function burn(
        address token,
        uint256 amountIn,
        uint256 minOut,
        uint64 deadline,
        uint16 maxFee,
        uint240 minFinalityThreshold,
        string calldata recipient
    ) external nonReentrant returns (uint64 nonce) {
        // ---- checks (all local, before any interaction) ----
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (minOut == 0) revert ZeroMinOut();
        bytes memory hook = _buildHook(recipient); // full strkey verification inside

        IERC20Like src = IERC20Like(token);
        uint256 usdcBefore = USDC.balanceOf(address(this));
        uint256 tokBefore = src.balanceOf(address(this)); // per-token isolated pair (4.2)

        // ---- interactions (each once, ordered, no router state changes after) ----
        _safeTransferFrom(src, msg.sender, address(this), amountIn);
        uint256 tokDelta = src.balanceOf(address(this)) - tokBefore; // fee-on-transfer shrinks this, never the USDC measure
        if (tokDelta == 0) revert NoDelta();
        _safeTransfer(src, address(SWAP), tokDelta); // push what ARRIVED, not what was asked
        SWAP.settle(token, tokDelta, address(this));

        uint256 usdcAfter = USDC.balanceOf(address(this));
        if (usdcAfter <= usdcBefore) revert NoDelta(); // checked underflow guard for rebase/steal windows
        uint256 delta = usdcAfter - usdcBefore;        // per-call ISOLATED balance delta (4.2)
        if (delta < minOut) revert Slippage();

        // exact-amount approval only: the no-unlimited-approval invariant holds
        // for the router's own approvals, not just for the user's
        _safeApprove(USDC, address(MESSENGER), delta);
        nonce = MESSENGER.depositForBurnWithHook(
            delta, DEST_DOMAIN, FORWARDER, address(USDC), FORWARDER, maxFee, minFinalityThreshold, hook
        );

        // post-state proof: swap+burn must have left the router exactly as it was
        // found; foreign dust neither burned nor grown (4.2 isolation)
        if (USDC.balanceOf(address(this)) != usdcBefore) revert RouterValueDrift();

        emit BurnInitiated(msg.sender, token, delta, nonce, nonce, recipient);
    }

    /// Read-only recipient verifier for the web layer's double verification
    /// (HARDENING-2.0.md 7.1): frontend computes strkey validity, then eth_calls
    /// this and compares - the contract is the arbiter, the UI is not.
    /// Returns 0 = valid, 1 = format, 2 = checksum.
    function checkRecipient(string calldata recipient) external pure returns (uint8) {
        bytes memory raw = bytes(recipient);
        if (raw.length != 56) return 1;
        if (!_isBase32(raw)) return 1;
        uint8 version = _decodeVersion(raw);
        if (version != 48 && version != 16 && version != 96) return 1; // G, C, M
        return _crcOk(raw) ? 0 : 2;
    }

    // ---------- hook construction (4.4) ----------

    function _buildHook(string memory recipient) private pure returns (bytes memory) {
        bytes memory raw = bytes(recipient);
        if (raw.length != 56) revert InvalidRecipient();
        if (!_isBase32(raw)) revert InvalidRecipient();
        uint8 version = _decodeVersion(raw);
        if (version != 48 && version != 16 && version != 96) revert InvalidRecipient();
        if (!_crcOk(raw)) revert InvalidRecipientChecksum();

        // Circle's documented Forwarder hook layout: 24 zero bytes |
        // uint32BE hook version (0) | uint32BE recipient BYTE length | recipient UTF-8.
        // The length field is bytes(recipient).length, never a char-count
        // shortcut (off-by-one there pins funds per 4.4).
        bytes memory hook = new bytes(88);
        for (uint256 i; i < 24; ++i) hook[i] = 0x00;
        hook[24] = 0x00; hook[25] = 0x00; hook[26] = 0x00; hook[27] = 0x00; // version 0
        hook[28] = 0x00; hook[29] = 0x00; hook[30] = 0x00; hook[31] = 0x38; // 56 bytes BE
        for (uint256 j; j < 56; ++j) hook[32 + j] = raw[j];
        return hook;
    }

    function _isBase32(bytes memory raw) private pure returns (bool) {
        for (uint256 i; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            bool ok = (c >= 65 && c <= 90) || (c >= 50 && c <= 55); // A-Z, 2-7
            if (!ok) return false;
        }
        return true;
    }

    function _toVal(uint8 c) private pure returns (uint8) {
        // charset already verified upstream: A-Z (65-90) or 2-7 (50-55).
        // (a `c <= 90` branch once swallowed the digits into c-65 - underflow
        // panic, caught by the harness because the same bug killed all 13
        // otherwise-unrelated tests at once; fixed on the range side)
        return c >= 65 ? c - 65 : c - 24; // A-Z -> 0-25, '2'(50) -> 26 .. '7'(55) -> 31
    }

    function _decodeVersion(bytes memory raw) private pure returns (uint8) {
        // first byte = 5 bits of char0 followed by top 3 bits of char1
        return _toVal(uint8(raw[0])) * 8 + _toVal(uint8(raw[1])) / 4;
    }

    /// CRC16/XModem (poly 0x1021, init 0, little-endian tail) over the decoded
    /// 33-byte payload (version byte + 32 raw key bytes), compared against
    /// decoded bytes 33..34 - the full Stellar StrKey verification, not a
    /// format proxy.
    function _crcOk(bytes memory raw) private pure returns (bool) {
        uint16 crc = 0;
        uint256 bitBuf = 0;
        uint256 bits = 0;
        uint256 byteIdx = 0;
        uint32 stored = 0;
        for (uint256 i; i < 56; ++i) {
            bitBuf = (bitBuf << 5) | uint256(_toVal(uint8(raw[i])));
            bits += 5;
            while (bits >= 8) {
                uint8 b = uint8(bitBuf >> (bits - 8));
                bits -= 8;
                bitBuf &= (1 << bits) - 1;
                if (byteIdx < 33) {
                    crc ^= uint16(b) << 8;
                    for (uint256 bit; bit < 8; ++bit) {
                        crc = (crc & 0x8000) == 0 ? crc << 1 : (crc << 1) ^ 0x1021;
                    }
                } else {
                    stored = (stored << 8) | b; // 2 checksum bytes (little-endian pair)
                }
                ++byteIdx;
            }
        }
        uint16 want = uint16(stored & 0xFF) << 8 | uint16(stored >> 8);
        return crc == want;
    }

    // ---------- SafeERC20-equivalent wrappers (4.5 row 5: raw calls banned) ----------

    function _safeTransferFrom(IERC20Like t, address from, address to, uint256 v) private {
        (bool s, bytes memory r) = address(t).call(abi.encodeWithSelector(t.transferFrom.selector, from, to, v));
        if (!s || (r.length != 0 && !abi.decode(r, (bool)))) revert TokenCallFailed();
    }

    function _safeTransfer(IERC20Like t, address to, uint256 v) private {
        (bool s, bytes memory r) = address(t).call(abi.encodeWithSelector(t.transfer.selector, to, v));
        if (!s || (r.length != 0 && !abi.decode(r, (bool)))) revert TokenCallFailed();
    }

    function _safeApprove(IERC20Like t, address spender, uint256 v) private {
        (bool s, bytes memory r) = address(t).call(abi.encodeWithSelector(t.approve.selector, spender, v));
        if (!s || (r.length != 0 && !abi.decode(r, (bool)))) revert TokenCallFailed();
    }
}
