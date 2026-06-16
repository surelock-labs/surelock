// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISureLock} from "src/ISureLock.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract SureLockValidationTest is Test {
    SureLock surelock;
    WatcherRegistry watcherRegistry;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address feeRecipient = address(0xFEE);
    address provider = address(0xCAFE);
    address client = address(0xC11E);
    address stranger = address(0xBAD);

    uint256 constant FEE = 0.01 ether;
    uint256 constant COLLATERAL = 0.03 ether;
    uint256 constant SLA_BLOCKS = 20;
    uint256 constant ACCEPT_WINDOW_BLOCKS = 5;

    uint256 offerId;
    uint256 minSlaBlocks;
    uint256 maxSlaBlocks;
    uint256 minLifetime;
    uint256 maxLifetime;

    function setUp() public {
        watcherRegistry = new WatcherRegistry(owner, feeRecipient, watcher);
        surelock = new SureLock(address(watcherRegistry), owner);

        vm.deal(provider, 10 ether);
        vm.deal(client, 10 ether);

        minSlaBlocks = surelock.MIN_SLA_BLOCKS();
        maxSlaBlocks = surelock.MAX_SLA_BLOCKS();
        minLifetime = surelock.MIN_LIFETIME();
        maxLifetime = surelock.MAX_LIFETIME();

        offerId = _register(provider, FEE, SLA_BLOCKS, COLLATERAL, minLifetime);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SureLock(address(watcherRegistry), address(0));
    }

    function testConstructorRejectsZeroWatcherRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.ZeroAddress.selector, SureLock.AddressParam.WatcherRegistry));
        new SureLock(address(0), owner);
    }

    function testSetProtocolFeeRejectsAboveMaximum() public {
        uint256 fee = surelock.MAX_PROTOCOL_FEE() + 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidProtocolFee.selector, fee));
        surelock.setProtocolFee(fee);
    }

    function testSetProtocolFeeRejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        surelock.setProtocolFee(1);
    }

    function testAcceptOwnershipRejectsNonPendingOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        surelock.acceptOwnership();
    }

    function testTransferOwnershipToZeroClearsPendingOwner() public {
        surelock.transferOwnership(stranger);
        assertEq(surelock.pendingOwner(), stranger);

        surelock.transferOwnership(address(0));

        assertEq(surelock.owner(), owner);
        assertEq(surelock.pendingOwner(), address(0));
    }

    function testRegisterRejectsSlaAboveMaximum() public {
        uint256 slaBlocks = maxSlaBlocks + 1;

        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InvalidSlaBlocks.selector, slaBlocks, minSlaBlocks, maxSlaBlocks)
        );
        vm.prank(provider);
        surelock.register(FEE, slaBlocks, COLLATERAL, minLifetime);
    }

    function testRegisterRejectsZeroFee() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidFee.selector, 0));
        vm.prank(provider);
        surelock.register(0, SLA_BLOCKS, COLLATERAL, minLifetime);
    }

    function testRegisterRejectsCollateralEqualToFee() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidCollateral.selector, FEE, FEE));
        vm.prank(provider);
        surelock.register(FEE, SLA_BLOCKS, FEE, minLifetime);
    }

    function testRegisterRejectsCollateralBelowFee() public {
        uint256 collateral = FEE - 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidCollateral.selector, collateral, FEE));
        vm.prank(provider);
        surelock.register(FEE, SLA_BLOCKS, collateral, minLifetime);
    }

    function testRegisterRejectsLifetimeBelowMinimum() public {
        uint256 lifetime = minLifetime - 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidLifetime.selector, lifetime, minLifetime, maxLifetime));
        vm.prank(provider);
        surelock.register(FEE, SLA_BLOCKS, COLLATERAL, lifetime);
    }

    function testRegisterRejectsLifetimeAboveMaximum() public {
        uint256 lifetime = maxLifetime + 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidLifetime.selector, lifetime, minLifetime, maxLifetime));
        vm.prank(provider);
        surelock.register(FEE, SLA_BLOCKS, COLLATERAL, lifetime);
    }

    function testDeactivateRejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotOfferOwner.selector, offerId, stranger));
        surelock.deactivate(offerId);
    }

    function testRenewRejectsNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotOfferOwner.selector, offerId, stranger));
        vm.prank(stranger);
        surelock.renew(offerId, minLifetime);
    }

    function testRenewRejectsMissingOffer() public {
        uint256 missingOfferId = offerId + 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.NotOfferOwner.selector, missingOfferId, provider));
        vm.prank(provider);
        surelock.renew(missingOfferId, minLifetime);
    }

    function testRenewRejectsLifetimeBelowMinimum() public {
        uint256 lifetime = minLifetime - 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidLifetime.selector, lifetime, minLifetime, maxLifetime));
        vm.prank(provider);
        surelock.renew(offerId, lifetime);
    }

    function testRenewRejectsLifetimeAboveMaximum() public {
        uint256 lifetime = maxLifetime + 1;

        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidLifetime.selector, lifetime, minLifetime, maxLifetime));
        vm.prank(provider);
        surelock.renew(offerId, lifetime);
    }

    function testDepositRejectsZeroValue() public {
        vm.expectRevert(SureLock.ZeroAmount.selector);
        surelock.deposit();
    }

    function testWithdrawRejectsInsufficientIdle() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.InsufficientIdle.selector, 1, 0));
        surelock.withdraw(1);
    }

    function testWithdrawToRejectsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.ZeroAddress.selector, SureLock.AddressParam.To));
        surelock.withdrawTo(payable(address(0)), 1);
    }

    function testCommitRejectsZeroUserOpHash() public {
        vm.prank(client);
        vm.expectRevert(SureLock.InvalidUserOpHash.selector);
        surelock.commit{value: FEE}(offerId, bytes32(0), ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitRejectsSelfCommit() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SureLock.SelfCommitForbidden.selector, provider));
        surelock.commit{value: FEE}(offerId, bytes32(uint256(1)), ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitRejectsWrongFeeBelowRequired() public {
        uint256 sent = FEE - 1;

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.WrongFee.selector, sent, FEE));
        surelock.commit{value: sent}(offerId, bytes32(uint256(2)), ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitRejectsWrongFeeAboveRequired() public {
        uint256 sent = FEE + 1;

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.WrongFee.selector, sent, FEE));
        surelock.commit{value: sent}(offerId, bytes32(uint256(3)), ACCEPT_WINDOW_BLOCKS);
    }

    function testAcceptRejectsMissingCommit() public {
        uint256 missingCommitId = 999;

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SureLock.CommitNotFound.selector, missingCommitId));
        surelock.accept(missingCommitId);
    }

    function testAcceptRejectsInsufficientCollateral() public {
        uint256 commitId = _commit(bytes32(uint256(4)));

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SureLock.InsufficientCollateral.selector, COLLATERAL, 0));
        surelock.accept(commitId);
    }

    function testCancelRejectsMissingCommit() public {
        uint256 missingCommitId = 999;

        vm.expectRevert(abi.encodeWithSelector(SureLock.CommitNotFound.selector, missingCommitId));
        surelock.cancel(missingCommitId);
    }

    function testSettleRejectsMissingCommit() public {
        uint256 missingCommitId = 999;

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(SureLock.CommitNotFound.selector, missingCommitId));
        watcherRegistry.settle(ISureLock(address(surelock)), missingCommitId, block.number);
    }

    function testRefundRejectsMissingCommit() public {
        uint256 missingCommitId = 999;

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(SureLock.CommitNotFound.selector, missingCommitId));
        watcherRegistry.refund(ISureLock(address(surelock)), missingCommitId);
    }

    function _register(address account, uint256 feePerOp, uint256 slaBlocks, uint256 collateral, uint256 lifetime)
        internal
        returns (uint256 registeredOfferId)
    {
        vm.prank(account);
        registeredOfferId = surelock.register(feePerOp, slaBlocks, collateral, lifetime);
    }

    function _commit(bytes32 userOpHash) internal returns (uint256 commitId) {
        vm.prank(client);
        commitId = surelock.commit{value: FEE}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }
}

contract WatcherRegistryValidationTest is Test {
    WatcherRegistry registry;

    address owner = address(this);
    address feeRecipient = address(0xFEE);
    address watcher = address(0xA11CE);

    function setUp() public {
        registry = new WatcherRegistry(owner, feeRecipient, watcher);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new WatcherRegistry(address(0), feeRecipient, watcher);
    }

    function testConstructorRejectsZeroFeeRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.FeeRecipient)
        );
        new WatcherRegistry(owner, address(0), watcher);
    }

    function testConstructorRejectsZeroWatcher() public {
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.Watcher)
        );
        new WatcherRegistry(owner, feeRecipient, address(0));
    }

    function testSetFeeRecipientRejectsZeroAddress() public {
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.FeeRecipient)
        );
        registry.setFeeRecipient(address(0));
    }

    function testSetFeeRecipientRejectsNonOwner() public {
        address stranger = address(0xBAD);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setFeeRecipient(address(0xBEEF));
    }

    function testSetWatcherRejectsZeroAddress() public {
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.Watcher)
        );
        registry.setWatcher(address(0), true);
    }

    function testAcceptOwnershipRejectsNonPendingOwner() public {
        address stranger = address(0xBAD);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.acceptOwnership();
    }

    function testTransferOwnershipToZeroClearsPendingOwner() public {
        address pendingOwner = address(0xBEEF);

        registry.transferOwnership(pendingOwner);
        assertEq(registry.pendingOwner(), pendingOwner);

        registry.transferOwnership(address(0));

        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), address(0));
    }

    function testCancelRejectsZeroSureLockAddress() public {
        vm.prank(watcher);
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.SureLock)
        );
        registry.cancel(ISureLock(address(0)), 1);
    }

    function testSettleRejectsZeroSureLockAddress() public {
        vm.prank(watcher);
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.SureLock)
        );
        registry.settle(ISureLock(address(0)), 1, block.number);
    }

    function testRefundRejectsZeroSureLockAddress() public {
        vm.prank(watcher);
        vm.expectRevert(
            abi.encodeWithSelector(WatcherRegistry.ZeroAddress.selector, WatcherRegistry.AddressParam.SureLock)
        );
        registry.refund(ISureLock(address(0)), 1);
    }
}
