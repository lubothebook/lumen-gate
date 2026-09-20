// BurnRouter conformance suite. Every test here encodes a scenario from
// HARDENING-2.0.md section 4 that MUST fail on a naive implementation; the
// suite was written before src/BurnRouter.sol existed (first `forge test` run
// was red on the missing contract, by design - Annex lesson #4).
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

    // golden hookData for C_GATE, produced by the SAME Python oracle that
    // verified the checksums (24 zero bytes | uint32BE version 0 |
    // uint32BE recipient byte-length | recipient UTF-8), length 88
    bytes constant HOOK_GOLDEN = hex"00000000000000000000000000000000000000000000000000000000000000384343584a533542425a4a5a334c374951333645554e4b524d4e555a43425a41373435584a374f4233553537574b4154334f47573654325136";

    bytes32 FORWARDER = keccak256("mock-cctp-forwarder");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        token = new MockERC20("Play Token", "PLAY", 6);
        messenger = new MockTokenMessenger(address(usdc));
        swap = new MockSwapRouter(address(usdc));
        router = new BurnRouter(address(messenger), address(usdc), address(swap), 27, FORWARDER);

        token.mint(user, 1_000_000);
        vm.startPrank(user);
        token.approve(address(router), type(uint256).max); // user-side allowance is the user's own choice
        vm.stopPrank();
    }

    function burnOnce(address t, uint256 amt, uint256 minOut, uint64 deadline, string memory recip) internal {
        vm.prank(user);
        router.burn(t, amt, minOut, deadline, 0, 1000, recip);
    }

    // ---------- happy path + hook layout (4.4) ----------

    function test_HappyPath_BurnsDelta_AndHookByteByByte() public {
        // recipient = the live gate contract id: the golden hook was built from
        // THIS strkey by the independent oracle, so the burn target is it too
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_GATE);
        assertEq(messenger.callCount(), 1);
        assertEq(messenger.lastAmount(), 2_000); // 1000 token * rate 2
        assertEq(messenger.lastDomain(), 27);
        assertEq(uint256(messenger.lastMintRecipient()), uint256(FORWARDER));
        assertEq(uint256(messenger.lastDestCaller()), uint256(FORWARDER));
        assertEq(messenger.lastMinFinality(), 1000);
        assertEq(messenger.lastMaxFee(), 0);
        bytes memory hook = messenger.lastHook();
        assertEq(hook.length, 88);
        assertEq(keccak256(hook), keccak256(HOOK_GOLDEN)); // byte-byte vs external oracle
    }

    function test_Hook_LayoutPartsAndUtf8LengthField() public {
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        bytes memory hook = messenger.lastHook();
        for (uint256 i; i < 24; ++i) assertEq(uint8(hook[i]), 0, "header must be zero");
        assertEq(uint32(uint8(hook[24]))<<24 | uint32(uint8(hook[25]))<<16 | uint32(uint8(hook[26]))<<8 | uint32(uint8(hook[27])), 0, "version");
        // length field = BYTE count of the UTF-8 encoding, not a char-count
        // shortcut; ASCII strkeys make them equal so we also burn with a
        // non-ASCII-shaped rejection below - the field here is set from
        // bytes(recipient).length in the contract (see src) and verified by
        // the golden vector above.
        assertEq(uint32(uint8(hook[28]))<<24 | uint32(uint8(hook[29]))<<16 | uint32(uint8(hook[30]))<<8 | uint32(uint8(hook[31])), 56, "recipient byte length");
        bytes memory raw = bytes(G_VALID);
        for (uint256 i; i < 56; ++i) assertEq(hook[32 + i], raw[i], "recipient bytes");
    }

    // ---------- strkey negatives: format and checksum are SEPARATE (4.4) ----------

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
        // the annex's point: a 56-char G-prefixed string PASSES format checks;
        // only the CRC16-XModem verification can catch this one
        vm.expectRevert(BurnRouter.InvalidRecipientChecksum.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_BADCHK);
        assertEq(messenger.callCount(), 0);
    }

    function test_Reject_BadChecksum_Class() public {
        vm.expectRevert(BurnRouter.InvalidRecipientChecksum.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_BADCHK);
    }

    function test_Accepts_LiveContractId_StrKey() public {
        // C-class ids are legitimate recipients (D1 decision: contracts first)
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), C_GATE);
        assertEq(messenger.callCount(), 1);
    }

    // ---------- deadline / minOut / slippage (4.3) ----------

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

    // ---------- token behavior classes (4.5) ----------

    function test_FeeOnTransfer_BurnsOnlyWhatArrived() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(user, 100_000);
        vm.prank(user);
        fee.approve(address(router), type(uint256).max);
        // rate 2: 1000 requested, 1% fee inside the PULL: 990 arrives, the
        // router pushes the MEASURED 990, venue pays 1980 - the burn follows
        // the delta, never the claim (2000 would be the claim)
        burnOnce(address(fee), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.lastAmount(), 1_980);
        assertEq(usdc.balanceOf(address(router)), 0); // no drift
    }

    function test_RebasingUSDC_SwapUnderflow_Reverts() public {
        swap.setStealAll(true); // venue pays out nothing; router balance must not underflow
        vm.expectRevert(BurnRouter.NoDelta.selector);
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        assertEq(messenger.callCount(), 0);
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
        // representative of "blacklist-capable stablecoin" row: the venue pull on
        // USDC side failing must revert the whole flow with state intact
        usdc.setBlacklist(true, address(router)); // messenger can no longer pull from router
        vm.expectRevert();
        burnOnce(address(token), 1_000, 1, uint64(block.timestamp + 1 hours), G_VALID);
        usdc.setBlacklist(false, address(0));
        // and the user's tokens were NOT burned either: full revert semantics
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

    // ---------- donation / dust isolation (4.2) ----------

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

    // ---------- adminless proof at ABI level (Annex lesson #1, section 3) ----------

    function test_AdminlessSurface_DispatchLevelProof() public {
        // Annex lesson #1 (section 3): "no admin" is proven by EXPERIMENT at the
        // dispatch boundary, not by prose. Every classic privileged selector must
        // have no entry point: a plain call to the router must revert.
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
        // and the two entry points DO dispatch (burn here fails deeper than dispatch):
        vm.prank(user);
        vm.expectRevert(BurnRouter.ZeroMinOut.selector);
        router.burn(address(token), 1, 0, uint64(block.timestamp + 1), 0, 1000, G_VALID);
    }

    // ---------- fuzz invariants (4.6) ----------

    function testFuzz_RouterNeverGainsValue(uint96 rate, uint96 amountIn, uint96 minOut) public {
        rate = uint96(bound(rate, 0, 1000));
        amountIn = uint96(bound(amountIn, 1, 500_000));
        minOut = uint96(bound(minOut, 1, 2_000_000));
        swap.setRate(rate, 1);
        uint256 usdcBefore = usdc.balanceOf(address(router));
        uint256 tokBefore = token.balanceOf(address(router));
        vm.prank(user);
        try router.burn(address(token), amountIn, minOut, uint64(block.timestamp + 1 hours), 0, 1000, G_VALID) {}
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
        router.burn(address(token), 1, 1, uint64(block.timestamp + 1 hours), 0, 1000, junk);
    }
}
