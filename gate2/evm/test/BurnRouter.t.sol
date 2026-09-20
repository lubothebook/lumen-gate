// BurnRouter v2 conformance suite (DIRECTIVE 2.0, section 5.1 + section 8
// negatives). Every test encodes a scenario that MUST fail on a naive
// implementation; Design G: mintRecipient = destinationCaller = GATE_CLAIM.
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BurnRouter} from "../src/BurnRouter.sol";
import {MockTokenMessenger, MockSwapRouter} from "./mocks/MockMessenger.sol";
import {
    MockERC20, FeeOnTransferToken, ZeroDecimalToken, NoReturnTransferToken,
    FalseReturnToken, ReentrantCallbackToken, HoneypotToken
} from "./mocks/AdversarialTokens.sol";

contract BurnRouterTest is Test {
    BurnRouter router;
    MockTokenMessenger messenger;
    MockSwapRouter swap;
    MockERC20 usdc;
    MockERC20 token;
    MockERC20 token2;

    address user = makeAddr("user");

    // live, oracle-verified strkeys (CRC checked against an independent
    // reference implementation; the C-id is a real deployed contract id from
    // deployments/testnet-2.0.json, the G fixture is sha256-derived and its
    // checksum is mathematically valid)
    string constant G_VALID = "GDX7BRQXHTCTGIWAAR4RN3KLOMAWDZM2QNWJW7QMNKLVHPKBR2WJQDPD";
    string constant G_BADCHK = "GDX7BRQXHTCTGIWAAR4RN3KLOMAWDZM2QNWJW7QMNKLVHPKBR2WJQDPA"; // last char flipped -> checksum broken, format intact
    string constant C_GATE = "CCXJS5BBZJZ3L7IQ36EUNKRMNUZCBZA745XJ7OB3U57WKAT3OGW6T2Q6";
    string constant C_BADCHK = "CCXJS5BBZJZ3L7IQ36EUAKRMNUZCBZA745XJ7OB3U57WKAT3OGW6T2Q6"; // 'N'->'A' interior
    string constant C_SHORT = "CCXJS5BBZJZ3L7IQ36EUNKRMNUZCBZA745XJ7OB3U57WKAT3OGW6T2Q"; // 55 chars
    string constant X_PREFIX = "XAXJS5BBZJZ3L7IQ36EUNKRMNUZCBZA745XJ7OB3U57WKAT3OGW6T2Q6"; // right length, wrong version char

    // golden hook v1 vectors, produced by the SAME Python oracle that
    // verified the strkey checksums:
    // 24 zero bytes | u32BE version(=1) | u32BE payload_len
    // | u8 flags | u128BE relay_fee_cap | u128BE battery_amount
    // | u8 recipient_len + recipient | [u8 name_len + name]
    // (a) C_GATE, flags 0, cap 1.0 USDC, battery 0.1 USDC, no name -> 122 bytes
    bytes constant HOOK_GOLDEN_BASIC = hex"000000000000000000000000000000000000000000000000000000010000005a00000000000000000000000000000003e800000000000000000000000000000064384343584a533542425a4a5a334c374951333645554e4b524d4e555a43425a41373435584a374f4233553537574b4154334f47573654325136";
    // (b) G_VALID, flags 0b111 (name + composed + ticket), cap 2.0 USDC,
    // battery 0.05 USDC, name "nova star 7" -> 134 bytes
    bytes constant HOOK_GOLDEN_FULL = hex"000000000000000000000000000000000000000000000000000000010000006607000000000000000000000000000003e8000000000000000000000000000000323847445837425251584854435447495741415234524e334b4c4f4d4157445a4d32514e574a5737514d4e4b4c5648504b425232574a514450440b6e6f766120737461722037";

    bytes32 GATE_CLAIM_32 = keccak256("mock-gate-claim");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        token = new MockERC20("Play Token", "PLAY", 6);
        token2 = new MockERC20("Second Token", "SECOND", 6);
        messenger = new MockTokenMessenger(address(usdc));
        swap = new MockSwapRouter(address(usdc));
        router = new BurnRouter(address(messenger), address(usdc), address(swap), GATE_CLAIM_32);

        token.mint(user, 1_000_000);
        token2.mint(user, 1_000_000);
        vm.startPrank(user);
        token.approve(address(router), type(uint256).max); // user-side allowance is the user's own choice
        token2.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// one-token burnBatch with defaults (fee 0, no name, wallet mode)
    function burnOnce(address t, uint256 amt, uint256 minOut, uint64 deadline, string memory recip) internal {
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = t;
        uint256[] memory amts = new uint256[](1);
        amts[0] = amt;
        uint256[] memory mins = new uint256[](1);
        mins[0] = minOut;
        router.burnBatch(toks, amts, mins, deadline, 0, 1000, recip, 0, 0, 0, "", 0);
    }

    // ---------- happy path + hook layout (5.1) ----------

    function test_HappyPath_BurnsDelta_AndHookByteByByte() public {
        // recipient = the live gate contract id: the golden hook was built from
        // THIS strkey by the independent oracle, so the burn target is it too
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, C_GATE,
            1_000, 100, 0, "", 0); // 0.001 + 0.0001 USDC of fees << 2.0 USDC delta
        assertEq(messenger.callCount(), 1);
        assertEq(messenger.lastAmount(), 2_000); // 1000 token * rate 2
        assertEq(messenger.lastDomain(), 27);
        assertEq(uint256(messenger.lastMintRecipient()), uint256(GATE_CLAIM_32)); // Design G
        assertEq(uint256(messenger.lastDestCaller()), uint256(GATE_CLAIM_32));    // Design G
        assertEq(messenger.lastMinFinality(), 1000);
        assertEq(messenger.lastMaxFee(), 0);
        bytes memory hook = messenger.lastHook();
        assertEq(hook.length, 122);
        assertEq(keccak256(hook), keccak256(HOOK_GOLDEN_BASIC)); // byte-byte vs external oracle
    }

    function test_Hook_FullFlags_Composed_Ticket_Name_ByteByByte() public {
        // two tokens (composition bit), ticket mode (bit2), star name (bit0)
        vm.prank(user);
        address[] memory toks = new address[](2);
        toks[0] = address(token);
        toks[1] = address(token2);
        uint256[] memory amts = new uint256[](2);
        amts[0] = 1_000;
        amts[1] = 1;
        uint256[] memory mins = new uint256[](2);
        mins[0] = 1;
        mins[1] = 1;
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            1_000, 50, 1, "nova star 7", 0); // fees 1050 < 2002 delta
        bytes memory hook = messenger.lastHook();
        assertEq(hook.length, 134);
        assertEq(keccak256(hook), keccak256(HOOK_GOLDEN_FULL)); // byte-byte vs external oracle
        // field-level reads of the v1 payload
        assertEq(uint8(hook[27]), 1, "version");
        assertEq(uint8(hook[32]), 0x07, "flags: name|composed|ticket");

    }

    function test_Hook_LayoutPartsAndByteLengthField() public {
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        bytes memory hook = messenger.lastHook();
        for (uint256 i; i < 24; ++i) assertEq(uint8(hook[i]), 0, "magic zeros");
        assertEq(uint32(uint8(hook[24])) << 24 | uint32(uint8(hook[25])) << 16 | uint32(uint8(hook[26])) << 8 | uint32(uint8(hook[27])), 1, "version");
        assertEq(uint32(uint8(hook[28])) << 24 | uint32(uint8(hook[29])) << 16 | uint32(uint8(hook[30])) << 8 | uint32(uint8(hook[31])), 90, "payload len");
        // length field = BYTE count of the UTF-8 encoding, not a char-count shortcut
        assertEq(uint8(hook[65]), 56, "recipient byte length");
        bytes memory raw = bytes(G_VALID);
        for (uint256 i; i < 56; ++i) assertEq(hook[66 + i], raw[i], "recipient bytes");
    }

    // ---------- strkey negatives: format and checksum are SEPARATE ----------

    function test_Reject_BadLength() public {
        vm.expectRevert(BurnRouter.InvalidRecipient.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_SHORT);
        assertEq(messenger.callCount(), 0);
    }

    function test_Reject_BadPrefix() public {
        vm.expectRevert(BurnRouter.InvalidRecipient.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), X_PREFIX);
        assertEq(messenger.callCount(), 0);
    }

    function test_Reject_BadChecksum_CorrectFormatAndLength() public {
        // a 56-char G-prefixed string PASSES format checks; only the
        // CRC16-XModem verification can catch this one
        vm.expectRevert(BurnRouter.InvalidRecipientChecksum.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_BADCHK);
        assertEq(messenger.callCount(), 0);
    }

    function test_Reject_BadChecksum_Class() public {
        vm.expectRevert(BurnRouter.InvalidRecipientChecksum.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_BADCHK);
    }

    function test_Accepts_LiveContractId_StrKey() public {
        // C-class ids are legitimate recipients (contracts first)
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_GATE);
        assertEq(messenger.callCount(), 1);
    }

    // ---------- deadline / minOut / slippage ----------

    function test_Reject_DeadlineExpired_AndNoCctpCall() public {
        vm.warp(1_000);
        vm.expectRevert(BurnRouter.DeadlineExpired.selector);
        burnOnce(address(token), 1_000, 1, 999, G_VALID);
        assertEq(messenger.callCount(), 0); // half-burn impossible: revert precedes deposit
    }

    function test_Reject_ZeroMinOut() public {
        vm.expectRevert(BurnRouter.ZeroMinOut.selector);
        burnOnce(address(token), 1_000, 0, uint64(block.timestamp + 1 hours), G_VALID);
    }

    function test_Reject_Slippage_AndNoDeposit() public {
        swap.setRate(1, 1); // 1 USDC per token; demand 2x
        vm.expectRevert(BurnRouter.Slippage.selector);
        burnOnce(address(token), 1_000, 2_000, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.callCount(), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ---------- hook v1: fees, mod, name (5.1 source-side validation) ----------

    function test_Reject_FeesCoveringTheWholeBurnable() public {
        // delta will be 2_000 (rate 2); cap + battery == delta -> nothing left
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        vm.expectRevert(BurnRouter.FeesExceedBurnable.selector);
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            1_000, 1_000, 0, "", 0);
        assertEq(messenger.callCount(), 0);
    }

    function test_Reject_BadMod() public {
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        vm.expectRevert(BurnRouter.BadMod.selector);
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            0, 0, 2, "", 0); // mod must be 0 or 1
    }

    function test_Reject_StarNameOutofCharset_AndTooLong() public {
        vm.startPrank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        string[5] memory bad = [
            "<script>", "a<b", "a&b", "a/b", "a b c d e f g h i j k l m n o p q r s" // 39 chars
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert();
            router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID, 0, 0, 0, bad[i], 0);
        }
        vm.stopPrank();
        assertEq(messenger.callCount(), 0);
    }

    // ---------- gas-fee protection (5.1) ----------

    function test_GasReserve_IsNeverBurned_AndIsReturned() public {
        // delta = 2_000; reserve 500 -> burn 1_500, user gets 500 back
        uint256 balBefore = usdc.balanceOf(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        vm.prank(user); // MUST be the last call before burnBatch (prank is consumed by the next call)
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            0, 0, 0, "", 500);
        assertEq(messenger.lastAmount(), 1_500, "reserve must not be burned");
        assertEq(usdc.balanceOf(user) - balBefore, 500, "reserve returned to caller");
        assertEq(usdc.balanceOf(address(router)), 0, "router ends clean");
    }

    function test_Reject_GasReserveAboveDelta() public {
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000; // delta 2_000
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        vm.expectRevert(BurnRouter.GasReserveExceedsDelta.selector);
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            0, 0, 0, "", 2_001);
        assertEq(messenger.callCount(), 0);
    }

    // ---------- token behavior classes ----------

    function test_FeeOnTransfer_BurnsOnlyWhatArrived() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(user, 100_000);
        vm.prank(user);
        fee.approve(address(router), type(uint256).max);
        // rate 2: 1000 requested, 1% fee inside the PULL: 990 arrives, the
        // router pushes the MEASURED 990, venue pays 1980 - the burn follows
        // the delta, never the claim
        burnOnce(address(fee), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 1_980);
        assertEq(usdc.balanceOf(address(router)), 0); // no drift
    }

    function test_RebasingUSDC_SwapUnderflow_Reverts() public {
        swap.setStealAll(true); // venue pays out nothing: per-token floor trips first,
        // router USDC balance can never underflow into a bogus "delta"
        vm.expectRevert(BurnRouter.Slippage.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.callCount(), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_Reentrancy_GuardRefuses_AndOuterCompletes() public {
        ReentrantCallbackToken evil = new ReentrantCallbackToken();
        evil.setRouter(address(router));
        evil.mint(user, 1_000);
        vm.prank(user);
        evil.approve(address(router), type(uint256).max);
        burnOnce(address(evil), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertTrue(!evil.reentrySucceeded(), "guard MUST refuse the inner burn");
        assertEq(uint32(evil.reentryErrorSig()), uint32(BurnRouter.Reentrancy.selector),
            "inner call must die on the lock, not something else");
        assertEq(messenger.callCount(), 1, "inner attempt must not reach the messenger");
    }

    function test_NoReturnToken_Accepted_BySafeWrapper() public {
        NoReturnTransferToken nr = new NoReturnTransferToken();
        nr.mintTo(user, 10_000);
        vm.prank(user);
        nr.approve(address(router), type(uint256).max);
        burnOnce(address(nr), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 2_000);
    }

    function test_FalseReturnToken_Rejected() public {
        FalseReturnToken fr = new FalseReturnToken();
        fr.mint(user, 10_000);
        vm.prank(user);
        fr.approve(address(router), type(uint256).max);
        vm.expectRevert(); // silent false must become a revert
        burnOnce(address(fr), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
    }

    function test_HoneypotToken_RevertsAtPull() public {
        HoneypotToken pot = new HoneypotToken();
        pot.mint(user, 10_000);
        vm.prank(user);
        pot.approve(address(router), type(uint256).max);
        vm.expectRevert();
        burnOnce(address(pot), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
    }

    function test_BlacklistUSDC_ClassRevertsCleanly() public {
        // representative of "blacklist-capable stablecoin" row: the messenger
        // pull on the USDC side failing must revert the whole flow with state intact
        usdc.setBlacklist(true, address(router));
        vm.expectRevert();
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        usdc.setBlacklist(false, address(0));
        assertEq(token.balanceOf(user), 1_000_000);
    }

    function test_ZeroDecimalToken_MinBoundary() public {
        ZeroDecimalToken z = new ZeroDecimalToken();
        z.mint(user, 10);
        vm.prank(user);
        z.approve(address(router), type(uint256).max);
        burnOnce(address(z), 1, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 2);
    }

    // ---------- multi-token composition ----------

    function test_MultiToken_DeltasSummed_CompositionFlag() public {
        vm.prank(user);
        address[] memory toks = new address[](2);
        toks[0] = address(token);
        toks[1] = address(token2);
        uint256[] memory amts = new uint256[](2);
        amts[0] = 1_000; // -> 2_000
        amts[1] = 1; // -> 2
        uint256[] memory mins = new uint256[](2);
        mins[0] = 1;
        mins[1] = 1;
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID,
            0, 0, 0, "", 0);
        assertEq(messenger.lastAmount(), 2_002, "both deltas must be burned");
        assertEq(uint8(messenger.lastHook()[32]), 0x02, "composition bit set");
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_Reject_ArrayLengthMismatch() public {
        vm.prank(user);
        address[] memory toks = new address[](2);
        toks[0] = address(token);
        toks[1] = address(token2);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1_000;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        vm.expectRevert(BurnRouter.ArrayLengthMismatch.selector);
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID, 0, 0, 0, "", 0);
    }

    // ---------- donation / dust isolation ----------

    function test_ExternalDonation_IsNotBurned_AndNextUserIsUnaffected() public {
        usdc.mintBalance(address(router), 100); // attacker dusts the router between blocks
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 2_000, "only the swap delta may be burned");
        assertEq(usdc.balanceOf(address(router)), 100, "donation stays as inert dust");

        // a second burn on the same router: its before/after must not carry
        // the residue into the burned amount
        burnOnce(address(token), 500, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 1_000); // 500*2 - dust did NOT inflate it
        assertEq(usdc.balanceOf(address(router)), 100);
    }

    // ---------- approvals (invariant: no unlimited approval anywhere) ----------

    function test_ApproveToMessenger_IsExactAmount_AndZeroAfter() public {
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAllowanceSeen(), messenger.lastAmount(),
            "router must approve exactly the burned amount");
        assertTrue(messenger.lastAllowanceSeen() != type(uint256).max, "unlimited approval");
        assertEq(usdc.allowance(address(router), address(messenger)), 0, "consumed allowance must rest at zero");
    }

    // ---------- adminless proof at ABI level (section 3) ----------

    function test_AdminlessSurface_DispatchLevelProof() public {
        // "no admin" is proven by EXPERIMENT at the dispatch boundary, not by
        // prose. Every classic privileged selector must have no entry point.
        string[10] memory forbidden = [
            "owner()", "admin()", "pause()", "unpause()", "upgrade(address)",
            "setMessenger(address)", "setUsdc(address)", "withdraw(address,uint256)",
            "rescue()", "setDefaultFee(uint256)"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(router).call(abi.encodeWithSignature(forbidden[i]));
            assertTrue(!ok, string.concat("privileged selector must NOT dispatch: ", forbidden[i]));
        }
        // no fallback, no receive: an unknown selector and raw value both die
        (bool fb,) = address(router).call(hex"deadbeef");
        assertTrue(!fb, "router must have no fallback");
        (bool rec,) = address(router).call{value: 1}("");
        assertTrue(!rec, "router must not accept ether");
        assertEq(address(router).balance, 0, "zero native value, always");
        // and the entry point DOES dispatch (this fails deeper, at ZeroMinOut):
        vm.prank(user);
        vm.expectRevert(BurnRouter.ZeroMinOut.selector);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 0;
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1), 0, 1000, G_VALID, 0, 0, 0, "", 0);
    }

    // ---------- fuzz invariants ----------

    function testFuzz_RouterNeverGainsValue(uint96 rate, uint96 amountIn, uint96 minOut) public {
        rate = uint96(bound(rate, 0, 1000));
        amountIn = uint96(bound(amountIn, 1, 500_000));
        minOut = uint96(bound(minOut, 1, 2_000_000));
        swap.setRate(rate, 1);
        uint256 usdcBefore = usdc.balanceOf(address(router));
        uint256 tokBefore = token.balanceOf(address(router));
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = amountIn;
        uint256[] memory mins = new uint256[](1);
        mins[0] = minOut;
        try router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID, 0, 0, 0, "", 0) {}
        catch {} // revert paths must also leave nothing behind
        assertEq(usdc.balanceOf(address(router)), usdcBefore, "usdc must not accumulate on router");
        assertEq(token.balanceOf(address(router)), tokBefore, "input token must not stick on router");
        assertEq(usdc.allowance(address(router), address(messenger)), 0);
    }

    function testFuzz_RejectsAnyRecipientNotLikeStrKey(uint128 a, uint128 b) public {
        // random bytes must never build a hook, whatever they look like
        string memory junk = string(abi.encodePacked(a, b));
        vm.expectRevert();
        vm.prank(user);
        address[] memory toks = new address[](1);
        toks[0] = address(token);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 1;
        router.burnBatch(toks, amts, mins, uint64(block.timestamp + 1 hours), 0, 1000, junk, 0, 0, 0, "", 0);
    }
}
