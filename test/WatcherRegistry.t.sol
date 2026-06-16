// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {ISureLock} from "src/ISureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

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

    function testWatcherCanForwardCancel() public {
        MockSureLock mockSureLock = new MockSureLock();
        uint256 commitId = 42;

        vm.prank(watcher);
        registry.cancel(mockSureLock, commitId);

        assertEq(mockSureLock.cancelledCommitId(), commitId);
    }

    function testWatcherCanForwardSettle() public {
        MockSureLock mockSureLock = new MockSureLock();
        uint256 commitId = 42;
        uint256 inclusionBlock = 100;

        vm.prank(watcher);
        registry.settle(mockSureLock, commitId, inclusionBlock);

        assertEq(mockSureLock.settledCommitId(), commitId);
        assertEq(mockSureLock.settledInclusionBlock(), inclusionBlock);
    }

    function testWatcherCanForwardRefund() public {
        MockSureLock mockSureLock = new MockSureLock();
        uint256 commitId = 42;

        vm.prank(watcher);
        registry.refund(mockSureLock, commitId);

        assertEq(mockSureLock.refundedCommitId(), commitId);
    }

    function testNonOwnerCannotSetWatcher() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.setWatcher(secondWatcher, true);
    }

    function testNonWatcherCannotForwardCancel() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WatcherRegistry.NotWatcher.selector, stranger));
        registry.cancel(ISureLock(address(0xBEEF)), 1);
    }

    function testNonWatcherCannotForwardSettle() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WatcherRegistry.NotWatcher.selector, stranger));
        registry.settle(ISureLock(address(0xBEEF)), 1, block.number);
    }

    function testNonWatcherCannotForwardRefund() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WatcherRegistry.NotWatcher.selector, stranger));
        registry.refund(ISureLock(address(0xBEEF)), 1);
    }
}

contract MockSureLock is ISureLock {
    uint256 public cancelledCommitId;
    uint256 public settledCommitId;
    uint256 public settledInclusionBlock;
    uint256 public refundedCommitId;

    function cancel(uint256 commitId) external {
        cancelledCommitId = commitId;
    }

    function settle(uint256 commitId, uint256 inclusionBlock) external {
        settledCommitId = commitId;
        settledInclusionBlock = inclusionBlock;
    }

    function refund(uint256 commitId) external {
        refundedCommitId = commitId;
    }
}
