// TestVenue conformance: the deterministic Sepolia venue for the 2.0 test
// lane. Pins the exact semantics the BurnRouter relies on (measurement, not
// claim; no admin; inventory floor).
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestVenue} from "../src/TestVenue.sol";
import {MockERC20, FeeOnTransferToken} from "./mocks/AdversarialTokens.sol";

contract TestVenueTest is Test {
    TestVenue venue;
    MockERC20 usdc;
    MockERC20 token;
    address router = makeAddr("router");
    address anyone = makeAddr("anyone");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        token = new MockERC20("Play Token", "PLAY", 6);
        venue = new TestVenue(address(usdc));
        // operator pre-loads the venue with USDC inventory (real Sepolia flow:
        // a one-time transfer from the operator wallet)
        usdc.mintBalance(address(venue), 1_000_000);
        token.mint(router, 1_000_000);
        vm.startPrank(router);
        token.approve(address(venue), type(uint256).max);
        vm.stopPrank();
    }

    function push(address t, uint256 amt) internal {
        vm.prank(router);
        MockERC20(t).transfer(address(venue), amt);
    }

    function test_DefaultRate_OneToOne() public {
        push(address(token), 1_000);
        uint256 bal = usdc.balanceOf(router);
        uint256 out = venue.settle(address(token), 1_000, router);
        assertEq(out, 1_000);
        assertEq(usdc.balanceOf(router) - bal, 1_000);
    }

    function test_CustomRate_Applies() public {
        venue.setRate(address(token), 3, 2); // 1.5:1
        push(address(token), 1_000);
        uint256 bal = usdc.balanceOf(router);
        uint256 out = venue.settle(address(token), 1_000, router);
        assertEq(out, 1_500);
        assertEq(usdc.balanceOf(router) - bal, 1_500);
    }

    function test_RateSettable_ByAnyone_NoAdmin() public {
        vm.prank(anyone);
        venue.setRate(address(token), 1, 10);
        push(address(token), 1_000);
        assertEq(venue.settle(address(token), 1_000, router), 100);
    }

    function test_Clamp_ResidueFromEarlierCalls_DoesNotInflate() public {
        // first call leaves residue (the venue keeps the pushed tokens)
        push(address(token), 100);
        venue.settle(address(token), 100, router);
        // second call: held = 100 (residue) + 50 = 150, but the claim is 50
        push(address(token), 50);
        uint256 bal = usdc.balanceOf(router);
        uint256 out = venue.settle(address(token), 50, router);
        assertEq(out, 50, "payout must follow THIS push, not the residue");
        assertEq(usdc.balanceOf(router) - bal, 50);
    }

    function test_FeeOnTransfer_PaysWhatArrived() public {
        // a token that delivers 99% of the push: the venue pays for the 990
        // actually held, not the 1000 claimed (mirrors the router's delta rule)
        MockERC20 fee = new FeeOnTransferToken();
        fee.mint(router, 1_000_000);
        vm.startPrank(router);
        fee.approve(address(venue), type(uint256).max);
        vm.stopPrank();
        vm.prank(router);
        fee.transferFrom(router, address(venue), 1_000); // 1% fee inside: 990 arrives
        uint256 bal = usdc.balanceOf(router);
        uint256 out = venue.settle(address(fee), 1_000, router);
        assertEq(out, 990);
        assertEq(usdc.balanceOf(router) - bal, 990);
    }

    function test_NoInventory_Reverts_NotUnderpay() public {
        MockERC20 big = new MockERC20("Big", "BIG", 6);
        big.mint(router, 10_000_000);
        vm.startPrank(router);
        big.approve(address(venue), type(uint256).max);
        vm.stopPrank();
        vm.prank(router);
        big.transfer(address(venue), 2_000_000); // exceeds the 1_000_000 inventory 1:1
        vm.expectRevert(TestVenue.NoInventory.selector);
        venue.settle(address(big), 2_000_000, router);
    }

    function test_ZeroDenominator_OnlyMeansDefault() public {
        // den 0 with num != 0 must be rejected (den 0 is reserved for "default")
        vm.expectRevert(TestVenue.ZeroDenominator.selector);
        venue.setRate(address(token), 5, 0);
    }

    function testFuzz_SettlePaysAtMostClaimed(uint96 amount) public {
        uint256 amt = bound(amount, 1, 500_000);
        push(address(token), amt);
        uint256 bal = usdc.balanceOf(router);
        uint256 out = venue.settle(address(token), amt, router);
        assertLe(out, amt, "default 1:1 never overpays the claim");
        assertEq(usdc.balanceOf(router) - bal, out);
    }
}
