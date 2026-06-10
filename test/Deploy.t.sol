// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "script/Deploy.s.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";
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

        (OfferRegistry registry, WatcherRegistry watcherRegistry, SLAEscrow escrow) = deploy.run();

        assertTrue(address(registry) != address(0));
        assertTrue(address(watcherRegistry) != address(0));
        assertTrue(address(escrow) != address(0));

        assertEq(address(escrow.registry()), address(registry));
        assertEq(address(escrow.watcherRegistry()), address(watcherRegistry));
        assertEq(escrow.owner(), owner);

        assertEq(watcherRegistry.owner(), owner);
        assertEq(watcherRegistry.feeRecipient(), feeRecipient);
        assertTrue(watcherRegistry.isWatcher(watcher));

        assertEq(registry.nextOfferId(), 1);
        assertEq(escrow.nextCommitId(), 1);
    }
}
