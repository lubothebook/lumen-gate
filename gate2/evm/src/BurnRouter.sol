// SPDX-License-Identifier: MIT
pragma solidity 0.8.30; // fixed version per HARDENING-2.0.md 4.6: the compiler pin is itself a frozen assumption

/// BurnRouter v2 (DIRECTIVE 2.0 section 5.1, Design G per D1/S1):
/// user tokens -> venue swap -> measured USDC delta -> Circle V2
/// depositForBurnWithHook with destinationDomain 27 and
/// mintRecipient = destinationCaller = the GateClaim contract (D1: only the
/// Gate can consume the message; the CctpForwarder path was rejected at S1).
///
/// The hook carries the v1 instruction payload (DIRECTIVE 5.1 layout):
///   24 zero bytes (magic) | uint32 version(=1) | uint32 payload_len
///   payload: uint8 flags (bit0 star name, bit1 composition, bit2 ticket mod)
///            | uint128 relay_fee_cap (6 decimals)
///            | uint128 battery_amount (6 decimals)
///            | uint8 recipient_len + recipient strkey (UTF-8)
///            | [bit0] uint8 name_len + name (only [A-Za-z0-9 ], <= 24)
///
/// Source-side validation here (a wrong hook is unrecoverable loss on the
/// source side): shape/length of every field, recipient strkey (full
/// CRC16-XModem verification), name charset, mod domain, and
/// relay_fee_cap + battery_amount < burnable amount.
///
/// Gas-fee protection (5.1): when the input is ETH, the UI computes
/// estimateGas * maxFeePerGas * 1.5 and passes it as `gasReserve`; that
/// portion of the delta is NEVER burned — it is paid back to the caller in
/// the same transaction.
///
/// No owner, no pause, no upgrade, no fund-withdrawal (DIRECTIVE 2.0 section
/// 3 / 5.1): the only USDC ever leaving this contract are (a) the measured
/// swap proceeds going to the burn, and (b) the caller's own gasReserve in
/// the same call. The kill-switch consequence is a frontend config removal
/// (docs/GATE2_TRUST_MODEL.md).
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

contract BurnRouter {
    // ---------- errors (no revert strings on hot paths: cheap to match, cheap to read) ----------
    error Reentrancy();
    error ArrayLengthMismatch();
    error InvalidRecipient();          // length/prefix/charset - format layer
    error InvalidRecipientChecksum();  // well-formed but CRC16-XModem mismatch
    error BadMod();
    error BadStarName();               // character outside [A-Za-z0-9 ]
    error NameTooLong();               // > 24
    error FeeOverflow();               // relay_fee_cap or battery_amount > uint128
    error DeadlineExpired();
    error ZeroMinOut();
    error Slippage();
    error NoDelta();
    error FeesExceedBurnable();        // relay_fee_cap + battery_amount >= burnable
    error GasReserveExceedsDelta();
    error TokenCallFailed();
    error RouterValueDrift();          // any USDC left on router other than pre-existing dust

    event BurnBatchInitiated(
        address indexed burner,
        uint256 usdcBurned,
        uint64 indexed nonce,
        bytes32 indexed hookRecipient,
        string recipient,
        uint8 mod,
        string starName,
        uint256 gasReserve
    );

    ITokenMessengerV2 public immutable MESSENGER;
    IERC20Like public immutable USDC;
    ISwapVenue public immutable SWAP;
    bytes32 public immutable GATE_CLAIM; // mintRecipient AND destinationCaller (D1, Design G)
    uint32 public constant DEST_DOMAIN = 27; // Stellar testnet (D3: this deployment's domain)

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

    constructor(address messenger, address usdc, address swapVenue, bytes32 gateClaim) {
        MESSENGER = ITokenMessengerV2(messenger);
        USDC = IERC20Like(usdc);
        SWAP = ISwapVenue(swapVenue);
        GATE_CLAIM = gateClaim;
    }

    /// @param tokens            input ERC-20s (user-approved pulls), any length >= 1
    /// @param amountsIn         requested pull per token (NEVER trusted for burn size - measured)
    /// @param minOuts           minimum USDC delta per token; 0 is rejected (slippage guard)
    /// @param deadline          last block timestamp the user will execute at
    /// @param maxFee            pass-through to Circle V2 (fees are explicit, never implicit)
    /// @param minFinalityThreshold Circle fast=1000 / standard=2000 (D3: default standard)
    /// @param recipient         Stellar strkey (G, C or M class) that must land the funds
    /// @param relayFeeCap       relay fee ceiling, 6 decimals (a CEILING - competition drives it down)
    /// @param batteryAmount     Battery share, 6 decimals (D6 default min(1 USDC, 10%); user may pick 0)
    /// @param mod               0 = straight to wallet (default, D7), 1 = Ticket (conscious choice)
    /// @param starName          optional, only [A-Za-z0-9 ], <= 24 chars ("" = none)
    /// @param gasReserve        USDC of the delta that must NOT be burned (ETH gas protection, 5.1)
    function burnBatch(
        address[] calldata tokens,
        uint256[] calldata amountsIn,
        uint256[] calldata minOuts,
        uint64 deadline,
        uint16 maxFee,
        uint240 minFinalityThreshold,
        string calldata recipient,
        uint256 relayFeeCap,
        uint256 batteryAmount,
        uint8 mod,
        string calldata starName,
        uint256 gasReserve
    ) external nonReentrant returns (uint64 nonce) {
        // ---- checks: shape FIRST (a bad hook is unrecoverable source-side loss) ----
        uint256 n = tokens.length;
        if (n == 0 || n != amountsIn.length || n != minOuts.length) revert ArrayLengthMismatch();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (mod != 0 && mod != 1) revert BadMod();
        if (relayFeeCap > type(uint128).max || batteryAmount > type(uint128).max) revert FeeOverflow();
        bytes memory nameBytes = bytes(starName);
        if (nameBytes.length > 24) revert NameTooLong();
        for (uint256 i; i < nameBytes.length; ) {
            bytes1 c = nameBytes[i];
            bool ok = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x20;
            if (!ok) revert BadStarName();
            unchecked { ++i; }
        }
        bytes memory recipientRaw = _validatedRecipient(recipient);

        uint256 entryBalance = USDC.balanceOf(address(this));
        // ---- interactions: per-token pull -> push -> settle, USDC delta measured per token ----
        for (uint256 i; i < n; ) {
            IERC20Like src = IERC20Like(tokens[i]);
            uint256 amountIn = amountsIn[i];
            if (amountIn == 0 || minOuts[i] == 0) revert ZeroMinOut(); // every leg burns: no no-op legs
            uint256 tokBefore = src.balanceOf(address(this)); // per-token isolated pair
            _safeTransferFrom(src, msg.sender, address(this), amountIn);
            uint256 tokDelta = src.balanceOf(address(this)) - tokBefore; // fee-on-transfer shrinks this
            if (tokDelta == 0) revert NoDelta();
            _safeTransfer(src, address(SWAP), tokDelta); // push what ARRIVED, not what was asked
            uint256 tokUsdcBefore = USDC.balanceOf(address(this));
            SWAP.settle(tokens[i], tokDelta, address(this));
            uint256 tokUsdcDelta = USDC.balanceOf(address(this)) - tokUsdcBefore;
            if (tokUsdcDelta < minOuts[i]) revert Slippage();
            unchecked { ++i; }
        }

        // ---- the measured delta is the ONLY burn size (5.1: what was REALLY received) ----
        uint256 totalDelta = USDC.balanceOf(address(this)) - entryBalance;
        if (totalDelta == 0) revert NoDelta();
        if (totalDelta < gasReserve) revert GasReserveExceedsDelta();
        uint256 burnable = totalDelta - gasReserve;
        if (burnable == 0) revert NoDelta();
        if (relayFeeCap + batteryAmount >= burnable) revert FeesExceedBurnable();

        bytes memory hook = _buildHook(recipientRaw, uint128(relayFeeCap), uint128(batteryAmount), mod, n > 1, bytes(starName));

        // exact-amount approval only: the no-unlimited-approval invariant holds
        // for the router's own approvals, not just for the user's
        _safeApprove(USDC, address(MESSENGER), burnable);
        nonce = MESSENGER.depositForBurnWithHook(
            burnable, DEST_DOMAIN, GATE_CLAIM, address(USDC), GATE_CLAIM, maxFee, minFinalityThreshold, hook
        );

        // the reserved gas share goes BACK to the caller in the same tx
        if (gasReserve > 0) {
            _safeTransfer(USDC, msg.sender, gasReserve);
        }

        // post-state proof: swap+burn+reserve must have left the router exactly
        // as it was found; foreign dust neither burned nor grown (isolation)
        if (USDC.balanceOf(address(this)) != entryBalance) revert RouterValueDrift();

        emit BurnBatchInitiated(msg.sender, burnable, nonce, bytes32(uint256(keccak256(recipientRaw))), recipient, mod, starName, gasReserve);
    }

    // ---------- read-only recipient verifier (web double verification) ----------
    /// Returns 0 = valid, 1 = format, 2 = checksum.
    function checkRecipient(string calldata recipient) external pure returns (uint8) {
        bytes memory raw = bytes(recipient);
        if (raw.length != 56) return 1;
        if (!_isBase32(raw)) return 1;
        uint8 version = _decodeVersion(raw);
        if (version != 48 && version != 16 && version != 96) return 1; // G, C, M
        return _crcOk(raw) ? 0 : 2;
    }

    // ---------- recipient verification (full StrKey, not a format proxy) ----------

    function _validatedRecipient(string calldata recipient) private pure returns (bytes memory) {
        bytes memory raw = bytes(recipient);
        if (raw.length != 56) revert InvalidRecipient();
        if (!_isBase32(raw)) revert InvalidRecipient();
        uint8 version = _decodeVersion(raw);
        if (version != 48 && version != 16 && version != 96) revert InvalidRecipient();
        if (!_crcOk(raw)) revert InvalidRecipientChecksum();
        return raw;
    }

    function _isBase32(bytes memory raw) private pure returns (bool) {
        for (uint256 i; i < raw.length; ) {
            uint8 c = uint8(raw[i]);
            if (!((c >= 65 && c <= 90) || (c >= 50 && c <= 55))) return false; // A-Z, 2-7
            unchecked { ++i; }
        }
        return true;
    }

    function _toVal(uint8 c) private pure returns (uint8) {
        return c >= 65 ? c - 65 : c - 24; // A-Z -> 0-25, '2'(50) -> 26 .. '7'(55) -> 31
    }

    function _decodeVersion(bytes memory raw) private pure returns (uint8) {
        return _toVal(uint8(raw[0])) * 8 + _toVal(uint8(raw[1])) / 4;
    }

    /// CRC16/XModem (poly 0x1021, init 0) over the decoded 33-byte payload
    /// (version byte + 32 raw key bytes), compared against the two trailing
    /// checksum bytes (little-endian pair) - the full Stellar StrKey check.
    function _crcOk(bytes memory raw) private pure returns (bool) {
        uint16 crc = 0;
        uint256 bitBuf = 0;
        uint256 bits = 0;
        uint256 byteIdx = 0;
        uint32 stored = 0;
        for (uint256 i; i < 56; ) {
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
                    stored = (stored << 8) | b;
                }
                ++byteIdx;
            }
            unchecked { ++i; }
        }
        uint16 want = uint16(stored & 0xFF) << 8 | uint16(stored >> 8);
        return crc == want;
    }

    // ---------- hook v1 construction (DIRECTIVE 5.1) ----------

    /// 24 zero bytes | u32 version(=1) | u32 payload_len
    /// payload: u8 flags | u128 relay_fee_cap | u128 battery_amount
    ///          | u8 recipient_len + recipient strkey
    ///          | [bit0] u8 name_len + name
    function _buildHook(
        bytes memory recipientRaw,
        uint128 relayFeeCap,
        uint128 batteryAmount,
        uint8 mod,
        bool composed,
        bytes memory name
    ) private pure returns (bytes memory) {
        uint8 flags = 0;
        if (name.length > 0) flags |= 0x01; // bit0: star name present
        if (composed) flags |= 0x02;        // bit1: multi-token composition
        if (mod == 1) flags |= 0x04;        // bit2: ticket mode

        uint256 payloadLen = 1 + 16 + 16 + 1 + recipientRaw.length;
        if (name.length > 0) payloadLen += 1 + name.length;
        uint256 total = 24 + 4 + 4 + payloadLen;
        if (total > 256) revert NameTooLong(); // defensive: the layout cannot exceed 256

        bytes memory hook = new bytes(total);
        // [0..24) magic zeros - already zeroed by allocation
        // [24..28) version = 1
        hook[27] = 0x01;
        // [28..32) payload length, big-endian
        hook[31] = bytes1(uint8(payloadLen));
        hook[30] = bytes1(uint8(payloadLen >> 8));
        hook[29] = bytes1(uint8(payloadLen >> 16));
        hook[28] = bytes1(uint8(payloadLen >> 24));
        uint256 p = 32;
        hook[p] = bytes1(flags);
        ++p;
        for (uint256 i = 0; i < 16; ++i) {
            hook[p + i] = bytes1(uint8(relayFeeCap >> (120 - 8 * i)));
        }
        p += 16;
        for (uint256 i = 0; i < 16; ++i) {
            hook[p + i] = bytes1(uint8(batteryAmount >> (120 - 8 * i)));
        }
        p += 16;
        hook[p] = bytes1(uint8(recipientRaw.length)); // byte length, never a char-count shortcut
        ++p;
        for (uint256 i; i < recipientRaw.length; ++i) {
            hook[p + i] = recipientRaw[i];
        }
        p += recipientRaw.length;
        if (name.length > 0) {
            hook[p] = bytes1(uint8(name.length));
            ++p;
            for (uint256 i; i < name.length; ++i) {
                hook[p + i] = name[i];
            }
        }
        return hook;
    }

    // ---------- SafeERC20-equivalent wrappers (raw calls banned) ----------

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
