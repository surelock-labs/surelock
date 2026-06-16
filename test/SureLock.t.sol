// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {ISureLock} from "src/ISureLock.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract SureLockTest is Test {
    SureLock surelock;
    WatcherRegistry watcherRegistry;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address secondWatcher = address(0xB0B);
    address feeRecipient = address(0xFEE);
    address secondFeeRecipient = address(0xF00);
    address provider = address(0xCAFE);
    address client = address(0xC11E);
    address stranger = address(0xBAD);

    uint256 constant FEE = 0.01 ether;
    uint256 constant COLLATERAL = 0.03 ether;
    uint256 constant SLA_BLOCKS = 20;
    uint256 constant ACCEPT_WINDOW_BLOCKS = 5;
    uint256 offerId;

    event CommitCreated(
        uint256 indexed commitId,
        uint256 indexed offerId,
        address indexed user,
        address provider,
        bytes32 userOpHash,
        uint256 feePaid,
        uint256 collateral,
        uint256 slaBlocks,
        uint256 acceptDeadline,
        uint256 protocolFee
    );

    function setUp() public {
        watcherRegistry = new WatcherRegistry(owner, feeRecipient, watcher);
        surelock = new SureLock(address(watcherRegistry), owner);

        vm.deal(provider, 10 ether);
        vm.deal(client, 10 ether);
        vm.deal(watcher, 10 ether);
        vm.deal(feeRecipient, 10 ether);

        uint256 lifetime = surelock.MIN_LIFETIME();

        vm.prank(provider);
        offerId = surelock.register(FEE, SLA_BLOCKS, COLLATERAL, lifetime);
    }

    function testInitialCommitIdIsOne() public view {
        assertEq(surelock.nextCommitId(), 1);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        address newOwner = address(0xB0B);

        surelock.transferOwnership(newOwner);

        assertEq(surelock.owner(), owner);
        assertEq(surelock.pendingOwner(), newOwner);

        vm.prank(newOwner);
        surelock.acceptOwnership();

        assertEq(surelock.owner(), newOwner);
        assertEq(surelock.pendingOwner(), address(0));
    }

    function testCommitAcceptSettleReusesFeeAndWithdraw() public {
        _deposit(COLLATERAL);
        bytes32 userOpHash = bytes32(uint256(1));
        uint256 commitId = _commit(userOpHash, FEE);

        _assertStatus(commitId, SureLock.CommitStatus.Proposed);

        vm.prank(provider);
        surelock.accept(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Active);
        assertEq(surelock.lockedOf(provider), COLLATERAL);
        assertEq(surelock.idleBalance(provider), 0);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.acceptedBlock + 1);

        _watcherSettle(commitId, c.acceptedBlock + 1);

        _assertStatus(commitId, SureLock.CommitStatus.Settled);
        assertEq(surelock.lockedOf(provider), 0);
        assertEq(surelock.balanceOf(provider), COLLATERAL + FEE);
        assertEq(surelock.idleBalance(provider), COLLATERAL + FEE);
        _assertUserOpHashStatus(userOpHash, SureLock.UserOpHashStatus.Consumed);

        vm.prank(provider);
        surelock.withdraw(COLLATERAL + FEE);

        assertEq(provider.balance, 10 ether + FEE);
        assertEq(address(surelock).balance, 0);
    }

    function testRefundPaysClientFeeAndCollateral() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(2)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.deadline + 1);

        _watcherRefund(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Refunded);
        assertEq(surelock.lockedOf(provider), 0);
        assertEq(surelock.balanceOf(provider), 0);
        assertEq(surelock.balanceOf(client), FEE + COLLATERAL);

        vm.prank(client);
        surelock.withdraw(FEE + COLLATERAL);

        assertEq(client.balance, 10 ether + COLLATERAL);
        assertEq(address(surelock).balance, 0);
    }

    function testCancelReturnsFeeToClient() public {
        bytes32 userOpHash = bytes32(uint256(3));
        uint256 commitId = _commit(userOpHash, FEE);

        vm.prank(client);
        surelock.cancel(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Cancelled);
        assertEq(surelock.balanceOf(client), FEE);
        _assertUserOpHashStatus(userOpHash, SureLock.UserOpHashStatus.None);

        vm.prank(client);
        surelock.withdraw(FEE);

        assertEq(client.balance, 10 ether);
        assertEq(address(surelock).balance, 0);
    }

    function testCanCommitSameUserOpHashAfterCancel() public {
        bytes32 userOpHash = bytes32(uint256(10));
        uint256 firstCommitId = _commit(userOpHash, FEE);

        vm.prank(client);
        surelock.cancel(firstCommitId);

        uint256 secondCommitId = _commit(userOpHash, FEE);

        _assertStatus(firstCommitId, SureLock.CommitStatus.Cancelled);
        _assertStatus(secondCommitId, SureLock.CommitStatus.Proposed);
        _assertUserOpHashStatus(userOpHash, SureLock.UserOpHashStatus.Active);
    }

    function testCannotCommitActiveUserOpHash() public {
        bytes32 userOpHash = bytes32(uint256(17));
        _commit(userOpHash, FEE);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SureLock.UserOpUnavailable.selector, userOpHash, SureLock.UserOpHashStatus.Active)
        );
        surelock.commit{value: FEE}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function testCannotCommitConsumedUserOpHash() public {
        _deposit(COLLATERAL);
        bytes32 userOpHash = bytes32(uint256(18));
        uint256 commitId = _commit(userOpHash, FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.acceptedBlock + 1);

        _watcherSettle(commitId, c.acceptedBlock + 1);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SureLock.UserOpUnavailable.selector, userOpHash, SureLock.UserOpHashStatus.Consumed)
        );
        surelock.commit{value: FEE}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitCreatedEventIncludesTerms() public {
        uint256 fee = 0.0002 ether;
        bytes32 userOpHash = bytes32(uint256(11));
        surelock.setProtocolFee(fee);

        vm.expectEmit(true, true, true, true, address(surelock));
        emit CommitCreated(
            1,
            offerId,
            client,
            provider,
            userOpHash,
            FEE,
            COLLATERAL,
            SLA_BLOCKS,
            block.number + ACCEPT_WINDOW_BLOCKS,
            fee
        );

        vm.prank(client);
        uint256 commitId = surelock.commit{value: FEE + fee}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        assertEq(c.acceptDeadline, block.number + ACCEPT_WINDOW_BLOCKS);
        assertEq(c.deadline, 0);
    }

    function testCommitRejectsZeroAcceptWindow() public {
        bytes32 userOpHash = bytes32(uint256(19));

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InvalidAcceptWindow.selector, 0, 1, surelock.MAX_ACCEPT_WINDOW_BLOCKS())
        );
        surelock.commit{value: FEE}(offerId, userOpHash, 0);
    }

    function testCommitRejectsAcceptWindowAboveMaximum() public {
        bytes32 userOpHash = bytes32(uint256(20));
        uint256 acceptWindowBlocks = surelock.MAX_ACCEPT_WINDOW_BLOCKS() + 1;

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                SureLock.InvalidAcceptWindow.selector, acceptWindowBlocks, 1, surelock.MAX_ACCEPT_WINDOW_BLOCKS()
            )
        );
        surelock.commit{value: FEE}(offerId, userOpHash, acceptWindowBlocks);
    }

    function testCommitRejectsMissingOffer() public {
        uint256 missingOfferId = offerId + 1;

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.OfferNotFound.selector, missingOfferId));
        surelock.commit{value: FEE}(missingOfferId, bytes32(uint256(24)), ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitRejectsDeactivatedOffer() public {
        vm.prank(provider);
        surelock.deactivate(offerId);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.OfferInactive.selector, offerId));
        surelock.commit{value: FEE}(offerId, bytes32(uint256(25)), ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitRejectsExpiredOffer() public {
        vm.roll(block.number + surelock.MIN_LIFETIME() + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.OfferInactive.selector, offerId));
        surelock.commit{value: FEE}(offerId, bytes32(uint256(26)), ACCEPT_WINDOW_BLOCKS);
    }

    function testCanAcceptAtAcceptDeadline() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(21)), FEE);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.acceptDeadline);

        vm.prank(provider);
        surelock.accept(commitId);

        c = surelock.getCommit(commitId);
        _assertStatus(commitId, SureLock.CommitStatus.Active);
        assertEq(c.deadline, c.acceptedBlock + SLA_BLOCKS);
    }

    function testCannotWithdrawLockedCollateral() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(4)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SureLock.InsufficientIdle.selector, 1, 0));
        surelock.withdraw(1);
    }

    function testProtocolFeeIsPaidToFeeRecipient() public {
        uint256 fee = 0.0002 ether;
        surelock.setProtocolFee(fee);

        uint256 commitId = _commit(bytes32(uint256(5)), FEE + fee);

        assertEq(surelock.balanceOf(feeRecipient), fee);

        vm.prank(client);
        surelock.cancel(commitId);

        vm.prank(client);
        surelock.withdraw(FEE);

        vm.prank(feeRecipient);
        surelock.withdraw(fee);

        assertEq(client.balance, 10 ether - fee);
        assertEq(feeRecipient.balance, 10 ether + fee);
        assertEq(address(surelock).balance, 0);
    }

    function testOwnerCanUpdateWatcherRegistry() public {
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        surelock.setWatcherRegistry(address(newRegistry));

        assertEq(address(surelock.watcherRegistry()), address(newRegistry));
    }

    function testNonOwnerCannotUpdateWatcherRegistry() public {
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        vm.prank(stranger);
        vm.expectRevert();
        surelock.setWatcherRegistry(address(newRegistry));
    }

    function testSetWatcherRegistryRejectsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.ZeroAddress.selector, SureLock.AddressParam.WatcherRegistry));
        surelock.setWatcherRegistry(address(0));
    }

    function testSetWatcherRegistryRejectsSelf() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.ZeroAddress.selector, SureLock.AddressParam.WatcherRegistry));
        surelock.setWatcherRegistry(address(surelock));
    }

    function testUpdatedWatcherRegistryControlsResolution() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(22)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;
        vm.roll(inclusionBlock);

        WatcherRegistry oldRegistry = watcherRegistry;
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);
        surelock.setWatcherRegistry(address(newRegistry));

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotWatcherRegistry.selector, address(oldRegistry)));
        oldRegistry.settle(ISureLock(address(surelock)), commitId, inclusionBlock);

        vm.prank(secondWatcher);
        newRegistry.settle(ISureLock(address(surelock)), commitId, inclusionBlock);

        _assertStatus(commitId, SureLock.CommitStatus.Settled);
    }

    function testProtocolFeeUsesUpdatedWatcherRegistryFeeRecipient() public {
        uint256 fee = 0.0002 ether;
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        surelock.setProtocolFee(fee);
        surelock.setWatcherRegistry(address(newRegistry));

        _commit(bytes32(uint256(23)), FEE + fee);

        assertEq(surelock.balanceOf(feeRecipient), 0);
        assertEq(surelock.balanceOf(secondFeeRecipient), fee);
    }

    function testOnlyProviderCanAccept() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(6)), FEE);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotProvider.selector, commitId, stranger));
        surelock.accept(commitId);
    }

    function testCannotAcceptAfterAcceptDeadline() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(15)), FEE);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.acceptDeadline + 1);

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                SureLock.AcceptDeadlineReached.selector, commitId, c.acceptDeadline, c.acceptDeadline + 1
            )
        );
        surelock.accept(commitId);
    }

    function testUnacceptedCommitCancelsAfterDeadlineWithoutSlash() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(16)), FEE);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.acceptDeadline + 1);

        _watcherCancel(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Cancelled);
        assertEq(surelock.lockedOf(provider), 0);
        assertEq(surelock.balanceOf(provider), COLLATERAL);
        assertEq(surelock.balanceOf(client), FEE);
    }

    function testOnlyClientCanCancelDuringAcceptWindow() public {
        uint256 commitId = _commit(bytes32(uint256(33)), FEE);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SureLock.Unauthorized.selector, commitId, provider));
        surelock.cancel(commitId);

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(SureLock.Unauthorized.selector, commitId, address(watcherRegistry)));
        watcherRegistry.cancel(ISureLock(address(surelock)), commitId);
    }

    function testProviderCanCancelExpiredProposedCommitWithoutSlash() public {
        _deposit(COLLATERAL);
        uint256 commitId = _expiredProposedCommit(bytes32(uint256(34)));

        vm.prank(provider);
        surelock.cancel(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Cancelled);
        assertEq(surelock.lockedOf(provider), 0);
        assertEq(surelock.balanceOf(provider), COLLATERAL);
        assertEq(surelock.balanceOf(client), FEE);
    }

    function testStrangerCannotCancelExpiredProposedCommit() public {
        uint256 commitId = _expiredProposedCommit(bytes32(uint256(35)));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SureLock.Unauthorized.selector, commitId, stranger));
        surelock.cancel(commitId);

        _assertStatus(commitId, SureLock.CommitStatus.Proposed);
    }

    function testOnlyWatcherRegistryCanSettle() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(7)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotWatcherRegistry.selector, stranger));
        surelock.settle(commitId, block.number + 1);
    }

    function testOnlyWatcherRegistryCanRefund() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(12)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SureLock.NotWatcherRegistry.selector, client));
        surelock.refund(commitId);
    }

    function testCannotSettleWithLateInclusionBlock() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(8)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InclusionAfterDeadline.selector, commitId, c.deadline, c.deadline + 1)
        );
        _watcherSettle(commitId, c.deadline + 1);
    }

    function testCannotSettleWithInclusionBeforeAccept() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(9)), FEE);

        vm.roll(block.number + 1);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InclusionBeforeAccept.selector, commitId, c.acceptedBlock, c.acceptedBlock)
        );
        _watcherSettle(commitId, c.acceptedBlock);
    }

    function testCannotSettleFutureInclusionBlock() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(13)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InclusionInFuture.selector, commitId, c.acceptedBlock, c.acceptedBlock + 1)
        );
        _watcherSettle(commitId, c.acceptedBlock + 1);
    }

    function testWatcherCanSettleLongAfterDeadlineWhenIncludedOnTime() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(14)), FEE);

        vm.prank(provider);
        surelock.accept(commitId);

        SureLock.Commit memory c = surelock.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;
        vm.roll(c.deadline + 10_000);

        _watcherSettle(commitId, inclusionBlock);

        _assertStatus(commitId, SureLock.CommitStatus.Settled);
        assertEq(surelock.balanceOf(provider), COLLATERAL + FEE);
    }

    function testCanSettleWithInclusionAtDeadline() public {
        uint256 commitId = _activeCommit(bytes32(uint256(27)));
        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.roll(c.deadline);
        _watcherSettle(commitId, c.deadline);

        _assertStatus(commitId, SureLock.CommitStatus.Settled);
    }

    function testCannotRefundAtDeadline() public {
        uint256 commitId = _activeCommit(bytes32(uint256(28)));
        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.roll(c.deadline);

        vm.expectRevert(abi.encodeWithSelector(SureLock.DeadlineNotReached.selector, commitId, c.deadline, c.deadline));
        _watcherRefund(commitId);
    }

    function testActiveCommitCannotBeCancelled() public {
        uint256 commitId = _activeCommit(bytes32(uint256(29)));

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SureLock.InvalidCommitStatus.selector, commitId, SureLock.CommitStatus.Active)
        );
        surelock.cancel(commitId);
    }

    function testSettledCommitCannotBeResolvedAgain() public {
        uint256 commitId = _settledCommit(bytes32(uint256(30)));
        SureLock.Commit memory c = surelock.getCommit(commitId);

        _expectTerminalTransitionsRevert(commitId, SureLock.CommitStatus.Settled, c.acceptedBlock + 1);
    }

    function testRefundedCommitCannotBeResolvedAgain() public {
        uint256 commitId = _refundedCommit(bytes32(uint256(31)));
        SureLock.Commit memory c = surelock.getCommit(commitId);

        _expectTerminalTransitionsRevert(commitId, SureLock.CommitStatus.Refunded, c.acceptedBlock + 1);
    }

    function testCancelledCommitCannotBeResolvedAgain() public {
        uint256 commitId = _cancelledCommit(bytes32(uint256(32)));

        _expectTerminalTransitionsRevert(commitId, SureLock.CommitStatus.Cancelled, block.number);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(provider);
        surelock.deposit{value: amount}();
    }

    function _commit(bytes32 userOpHash, uint256 value) internal returns (uint256 commitId) {
        vm.prank(client);
        commitId = surelock.commit{value: value}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function _watcherCancel(uint256 commitId) internal {
        vm.prank(watcher);
        watcherRegistry.cancel(ISureLock(address(surelock)), commitId);
    }

    function _watcherSettle(uint256 commitId, uint256 inclusionBlock) internal {
        vm.prank(watcher);
        watcherRegistry.settle(ISureLock(address(surelock)), commitId, inclusionBlock);
    }

    function _watcherRefund(uint256 commitId) internal {
        vm.prank(watcher);
        watcherRegistry.refund(ISureLock(address(surelock)), commitId);
    }

    function _activeCommit(bytes32 userOpHash) internal returns (uint256 commitId) {
        _deposit(COLLATERAL);
        commitId = _commit(userOpHash, FEE);

        vm.prank(provider);
        surelock.accept(commitId);
    }

    function _settledCommit(bytes32 userOpHash) internal returns (uint256 commitId) {
        commitId = _activeCommit(userOpHash);
        SureLock.Commit memory c = surelock.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;

        vm.roll(inclusionBlock);
        _watcherSettle(commitId, inclusionBlock);
    }

    function _refundedCommit(bytes32 userOpHash) internal returns (uint256 commitId) {
        commitId = _activeCommit(userOpHash);
        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.roll(c.deadline + 1);
        _watcherRefund(commitId);
    }

    function _cancelledCommit(bytes32 userOpHash) internal returns (uint256 commitId) {
        commitId = _commit(userOpHash, FEE);

        vm.prank(client);
        surelock.cancel(commitId);
    }

    function _expiredProposedCommit(bytes32 userOpHash) internal returns (uint256 commitId) {
        commitId = _commit(userOpHash, FEE);
        SureLock.Commit memory c = surelock.getCommit(commitId);

        vm.roll(c.acceptDeadline + 1);
    }

    function _expectTerminalTransitionsRevert(uint256 commitId, SureLock.CommitStatus status, uint256 inclusionBlock)
        internal
    {
        bytes memory expected = abi.encodeWithSelector(SureLock.InvalidCommitStatus.selector, commitId, status);

        vm.expectRevert(expected);
        _watcherSettle(commitId, inclusionBlock);

        vm.expectRevert(expected);
        _watcherRefund(commitId);

        vm.prank(client);
        vm.expectRevert(expected);
        surelock.cancel(commitId);

        vm.prank(provider);
        vm.expectRevert(expected);
        surelock.accept(commitId);
    }

    function _assertStatus(uint256 commitId, SureLock.CommitStatus status) internal view {
        SureLock.Commit memory c = surelock.getCommit(commitId);
        assertEq(uint256(c.status), uint256(status));
    }

    function _assertUserOpHashStatus(bytes32 userOpHash, SureLock.UserOpHashStatus status) internal view {
        assertEq(uint256(surelock.userOpHashStatus(userOpHash)), uint256(status));
    }
}
