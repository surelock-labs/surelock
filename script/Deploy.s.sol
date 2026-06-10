// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract Deploy is Script {
    function run() external returns (OfferRegistry registry, WatcherRegistry watcherRegistry, SLAEscrow escrow) {
        address owner = vm.envAddress("OWNER");
        address watcher = vm.envAddress("WATCHER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast();
        registry = new OfferRegistry();
        watcherRegistry = new WatcherRegistry(owner, feeRecipient, watcher);
        escrow = new SLAEscrow(address(registry), address(watcherRegistry), owner);
        vm.stopBroadcast();

        console2.log("OfferRegistry:", address(registry));
        console2.log("WatcherRegistry:", address(watcherRegistry));
        console2.log("SLAEscrow:", address(escrow));
        console2.log("Owner:", owner);
        console2.log("Watcher:", watcher);
        console2.log("FeeRecipient:", feeRecipient);
    }
}
