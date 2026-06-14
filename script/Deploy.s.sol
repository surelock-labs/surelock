// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract Deploy is Script {
    function run() external returns (WatcherRegistry watcherRegistry, SureLock surelock) {
        address owner = vm.envAddress("OWNER");
        address watcher = vm.envAddress("WATCHER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast();
        watcherRegistry = new WatcherRegistry(owner, feeRecipient, watcher);
        surelock = new SureLock(address(watcherRegistry), owner);
        vm.stopBroadcast();

        console2.log("WatcherRegistry:", address(watcherRegistry));
        console2.log("SureLock:", address(surelock));
        console2.log("Owner:", owner);
        console2.log("Watcher:", watcher);
        console2.log("FeeRecipient:", feeRecipient);
    }
}
