// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "script/Deploy.s.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract DeployTest is Test {
    address owner = address(0xA11CE);
    address watcher = address(0xB0B);
    address feeRecipient = address(0xFEE);

    function setUp() public {
        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("WATCHER", vm.toString(watcher));
        vm.setEnv("FEE_RECIPIENT", vm.toString(feeRecipient));
    }

    function testDeployScriptWiresContracts() public {
        Deploy deploy = new Deploy();

        (WatcherRegistry watcherRegistry, SureLock surelock) = deploy.run();

        assertTrue(address(watcherRegistry) != address(0));
        assertTrue(address(surelock) != address(0));

        assertEq(address(surelock.watcherRegistry()), address(watcherRegistry));
        assertEq(surelock.owner(), owner);

        assertEq(watcherRegistry.owner(), owner);
        assertEq(watcherRegistry.feeRecipient(), feeRecipient);
        assertTrue(watcherRegistry.isWatcher(watcher));

        assertEq(surelock.nextOfferId(), 1);
        assertEq(surelock.nextCommitId(), 1);
    }
}
