// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";

contract Deploy is Script {
    function run() external returns (OfferRegistry registry, SLAEscrow escrow) {
        address owner = vm.envAddress("OWNER");
        address watcher = vm.envAddress("WATCHER");

        vm.startBroadcast();
        registry = new OfferRegistry();
        escrow = new SLAEscrow(address(registry), watcher, owner);
        vm.stopBroadcast();

        console2.log("OfferRegistry:", address(registry));
        console2.log("SLAEscrow:", address(escrow));
        console2.log("Owner:", owner);
        console2.log("Watcher:", watcher);
    }
}
