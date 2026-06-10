// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {ISLAEscrow, WatcherRegistry} from "src/WatcherRegistry.sol";

contract WatcherRegistryTest is Test {
    WatcherRegistry registry;

    address owner = address(this);
    address feeRecipient = address(0xFEE);
    address watcher = address(0xA11CE);
    address secondWatcher = address(0xB0B);
    address stranger = address(0xBAD);

    function setUp() public {
        registry = new WatcherRegistry(owner, feeRecipient, watcher);
    }

    function testInitialFeeRecipient() public view {
        assertEq(registry.feeRecipient(), feeRecipient);
    }

    function testOwnerCanUpdateFeeRecipient() public {
        address newRecipient = address(0xBEEF);

        registry.setFeeRecipient(newRecipient);

        assertEq(registry.feeRecipient(), newRecipient);
    }

    function testInitialWatcher() public view {
        assertTrue(registry.isWatcher(watcher));
    }

    function testOwnerCanRotateWatcher() public {
        registry.setWatcher(secondWatcher, true);
        assertTrue(registry.isWatcher(secondWatcher));

        registry.setWatcher(secondWatcher, false);
        assertFalse(registry.isWatcher(secondWatcher));
    }

    function testNonOwnerCannotSetWatcher() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.setWatcher(secondWatcher, true);
    }

    function testNonWatcherCannotForwardResolution() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WatcherRegistry.NotWatcher.selector, stranger));
        registry.refund(ISLAEscrow(address(0xBEEF)), 1);
    }
}
