// Test-side mocks only. These are deliberately adversarial: each one embodies
// a token behavior class from HARDENING-2.0.md section 4.5. The router must
// survive all of them; none of these files ship to any chain.
pragma solidity 0.8.30;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    error InsufficientBalance();
    error Blocked();

    bool public blacklisted; // when true, transfers FROM the router fail (token class: blacklist-capable)
    address public blockedFrom;

    constructor(string memory n, string memory s, uint8 d) {
        name = n; symbol = s; decimals = d;
    }

    function setBlacklist(bool on, address who) external {
        blacklisted = on;
        blockedFrom = who;
    }

    function mint(address to, uint256 a) external {
        mintBalance(to, a);
    }

    // test-venue helpers (mock USDC mints payouts; messenger "burns" like Circle does)
    function mintBalance(address to, uint256 a) public {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function burnBalance(uint256 a) public {
        balanceOf[msg.sender] -= a;
        totalSupply -= a;
    }

    function approve(address sp, uint256 a) external returns (bool) {
        allowance[msg.sender][sp] = a;
        return true;
    }

    function _move(address from, address to, uint256 a) internal {
        if (blacklisted && from == blockedFrom) revert Blocked();
        if (balanceOf[from] < a) revert InsufficientBalance();
        unchecked { balanceOf[from] -= a; }
        balanceOf[to] += a;
        onMove(from, to, a); // ERC777-style callback surface for the reentrancy class
    }

    function onMove(address, address, uint256) internal virtual {}

    function transfer(address to, uint256 a) external virtual returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external virtual returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= a, "allowance");
            unchecked { allowance[from][msg.sender] -= a; }
        }
        _move(from, to, a);
        return true;
    }
}

// Class: fee-on-transfer - delivers strictly less than requested.
contract FeeOnTransferToken is MockERC20 {
    uint96 public feeBps = 100; // 1%
    constructor() MockERC20("FeeToken", "FEE", 6) {}
    function transferFrom(address from, address to, uint256 a) external override returns (bool) {
        if (balanceOf[from] < a) revert InsufficientBalance();
        uint256 fee = (a * uint256(feeBps)) / 10000;
        unchecked { balanceOf[from] -= a; balanceOf[to] += a - fee; totalSupply -= fee; }
        return true;
    }
}

// Class: zero-decimals extreme (section 4.5 row 4, boundary arithmetic).
contract ZeroDecimalToken is MockERC20 {
    constructor() MockERC20("UnitToken", "UNIT", 0) {}
}

// Class: transfer()/transferFrom() that return nothing at all (old USDT-style).
// A router using raw external calls with `abi.decode(bool)` would silently
// revert on the EMPTY returndata; SafeERC20-equivalent wrapping must treat
// empty success as success and false as failure. Standalone: not the same ABI
// as the base mock by design.
contract NoReturnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mintTo(address a, uint256 v) external { balanceOf[a] += v; }
    function approve(address sp, uint256 v) external { allowance[msg.sender][sp] = v; }

    function _mv(address from, address to, uint256 a) internal {
        require(balanceOf[from] >= a, "balance");
        unchecked { balanceOf[from] -= a; }
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external { _mv(msg.sender, to, a); }
    function transferFrom(address from, address to, uint256 a) external {
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= a, "allowance");
            unchecked { allowance[from][msg.sender] -= a; }
        }
        _mv(from, to, a);
    }
}

// Class: returns false instead of reverting (USDC-failure style).
contract FalseReturnToken is MockERC20 {
    constructor() MockERC20("FalseReturn", "FR", 6) {}
    function transfer(address, uint256) external pure override returns (bool) {
        return false; // silent failure must be caught on the venue-push path...
    }
    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false; // ...and on the router-pull path (missing override here once let the suite "pass" by accident)
    }
}

// Class: callback-bearing token (ERC777 family) - attacks reentrancy during
// transferFrom. The outer burn is EXPECTED to complete: proof of the guard is
// that the inner call was refused with the lock selector (recorded here) and
// that the messenger saw exactly one deposit.
contract ReentrantCallbackToken is MockERC20 {
    address public router;
    bool public reentrySucceeded;
    bool public attacked;
    bytes4 public reentryErrorSig;

    constructor() MockERC20("Evil", "EVIL", 6) {}

    function setRouter(address r) external { router = r; }

    function onMove(address, address to, uint256) internal override {
        if (to != router || msg.sender != router || attacked) return;
        attacked = true;
        // classic malicious hook: call back into the router mid-transfer with a
        // fully valid payload (correct checksum G-strkey, live oracle vector),
        // so the ONLY thing that can stop it is the reentrancy guard itself.
        bytes memory inner = abi.encodeWithSignature(
            "burn(address,uint256,uint256,uint64,uint16,uint240,string)",
            address(this),
            1,
            1,
            type(uint64).max,
            uint16(0),
            uint240(1000),
            "GDX7BRQXHTCTGIWAAR4RN3KLOMAWDZM2QNWJW7QMNKLVHPKBR2WJQDPD"
        );
        (bool ok, bytes memory err) = router.call(inner);
        if (ok) {
            reentrySucceeded = true; // guard failed (and the outer tx must not have completed)
        } else if (err.length >= 4) {
            // uint32 math: `bytes4(x) << n` silently drops bits WITHIN four
            // bytes, which is how a real guard-revert was once mis-read as a
            // wrong selector (measurement bug, not contract bug - fixed here)
            reentryErrorSig = bytes4(
                uint32(uint8(err[0])) << 24 | uint32(uint8(err[1])) << 16 | uint32(uint8(err[2])) << 8 | uint32(uint8(err[3]))
            );
        }
    }
}

// Class: honeypot - accept deposits, refuse withdrawal at swap time.
contract HoneypotToken is MockERC20 {
    constructor() MockERC20("Honey", "POT", 6) {}
    function transfer(address, uint256) external pure override returns (bool) {
        revert("honeypot");
    }
}
