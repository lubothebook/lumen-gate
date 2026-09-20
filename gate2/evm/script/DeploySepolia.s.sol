// Sepolia deployment script for the Gate 2.0 test lane.
//
// Deploys, in order:
//   1. TestVenue      (deterministic, no-admin, 1:1 default)
//   2. BurnRouter     (Design G: mintRecipient = destinationCaller = gate_claim)
//
// Constructor inputs are the LIVE Circle CCTP V2 Sepolia reference addresses
// from deployments/testnet-2.0.json (circle_testnet_reference.sepolia_domain0)
// and the canonical hardened gate_claim contract id (CDQ3PA5L..., deployed
// aa421501 / initialized 21c53dfe on Stellar testnet) decoded with the
// official stellar-strkey crate.
//
// Usage (operator, funded Sepolia key, testnet ONLY):
//   forge script script/DeploySepolia.s.sol \
//     --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PK \
//     --broadcast
//
// After a successful broadcast: record venue + router addresses, deploy tx
// hashes and ledger-equivalent block numbers in deployments/testnet-2.0.json
// (evidence-first: nothing is written there from this script alone).
// The operator also transfers USDC inventory to the venue (the venue never
// mints) and, per the live probes, the user wallet needs a ChangeTrust/
// funding path for the probe tokens.
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {BurnRouter} from "../src/BurnRouter.sol";
import {TestVenue} from "../src/TestVenue.sol";

contract DeploySepolia is Script {
    // LIVE references (deployments/testnet-2.0.json, sepolia_domain0)
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    // gate_claim canonical hardened (strkey CDQ3PA5LBLIS22VXJSHXLOPFDD2ZDWPQWODIBLA5KPBOTKIXKOUZI4K2)
    // decoded with the official stellar-strkey crate (0.0.18), cross-checked
    // byte-for-byte against the crate's own decoder in the session record.
    bytes32 constant GATE_CLAIM_32 = 0xe1b783ab0ad12d6ab74c8f75b9e518f591d9f0b38680ac1d53c2e9a91753a994;

    function run() external {
        uint256 pk = vm.envOr("SEPOLIA_PK", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();

        TestVenue venue = new TestVenue(USDC);
        console2.log("TestVenue:", address(venue));

        BurnRouter router = new BurnRouter(TOKEN_MESSENGER_V2, USDC, address(venue), GATE_CLAIM_32);
        console2.log("BurnRouter:", address(router));

        vm.stopBroadcast();
    }
}
