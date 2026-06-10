// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";
import {ISLAEscrow, WatcherRegistry} from "src/WatcherRegistry.sol";

contract SLAEscrowTest is Test {
    OfferRegistry reg;
    SLAEscrow escrow;
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
        reg = new OfferRegistry();
        watcherRegistry = new WatcherRegistry(owner, feeRecipient, watcher);
        escrow = new SLAEscrow(address(reg), address(watcherRegistry), owner);

        vm.deal(provider, 10 ether);
        vm.deal(client, 10 ether);
        vm.deal(watcher, 10 ether);
        vm.deal(feeRecipient, 10 ether);

        uint256 lifetime = reg.MIN_LIFETIME();

        vm.prank(provider);
        offerId = reg.register(FEE, SLA_BLOCKS, COLLATERAL, lifetime);
    }

    function testInitialCommitIdIsOne() public view {
        assertEq(escrow.nextCommitId(), 1);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        address newOwner = address(0xB0B);

        escrow.transferOwnership(newOwner);

        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), newOwner);

        vm.prank(newOwner);
        escrow.acceptOwnership();

        assertEq(escrow.owner(), newOwner);
        assertEq(escrow.pendingOwner(), address(0));
    }

    function testCommitAcceptSettleReusesFeeAndWithdraw() public {
        _deposit(COLLATERAL);
        bytes32 userOpHash = bytes32(uint256(1));
        uint256 commitId = _commit(userOpHash, FEE);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Proposed);

        vm.prank(provider);
        escrow.accept(commitId);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Active);
        assertEq(escrow.lockedOf(provider), COLLATERAL);
        assertEq(escrow.idleBalance(provider), 0);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptedBlock + 1);

        _watcherSettle(commitId, c.acceptedBlock + 1);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Settled);
        assertEq(escrow.lockedOf(provider), 0);
        assertEq(escrow.balanceOf(provider), COLLATERAL + FEE);
        assertEq(escrow.idleBalance(provider), COLLATERAL + FEE);
        _assertUserOpHashStatus(userOpHash, SLAEscrow.UserOpHashStatus.Consumed);

        vm.prank(provider);
        escrow.withdraw(COLLATERAL + FEE);

        assertEq(provider.balance, 10 ether + FEE);
        assertEq(address(escrow).balance, 0);
    }

    function testRefundPaysClientFeeAndCollateral() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(2)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline + 1);

        _watcherRefund(commitId);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Refunded);
        assertEq(escrow.lockedOf(provider), 0);
        assertEq(escrow.balanceOf(provider), 0);
        assertEq(escrow.balanceOf(client), FEE + COLLATERAL);

        vm.prank(client);
        escrow.withdraw(FEE + COLLATERAL);

        assertEq(client.balance, 10 ether + COLLATERAL);
        assertEq(address(escrow).balance, 0);
    }

    function testCancelReturnsFeeToClient() public {
        bytes32 userOpHash = bytes32(uint256(3));
        uint256 commitId = _commit(userOpHash, FEE);

        vm.prank(client);
        escrow.cancel(commitId);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Cancelled);
        assertEq(escrow.balanceOf(client), FEE);
        _assertUserOpHashStatus(userOpHash, SLAEscrow.UserOpHashStatus.None);

        vm.prank(client);
        escrow.withdraw(FEE);

        assertEq(client.balance, 10 ether);
        assertEq(address(escrow).balance, 0);
    }

    function testCanCommitSameUserOpHashAfterCancel() public {
        bytes32 userOpHash = bytes32(uint256(10));
        uint256 firstCommitId = _commit(userOpHash, FEE);

        vm.prank(client);
        escrow.cancel(firstCommitId);

        uint256 secondCommitId = _commit(userOpHash, FEE);

        _assertStatus(firstCommitId, SLAEscrow.CommitStatus.Cancelled);
        _assertStatus(secondCommitId, SLAEscrow.CommitStatus.Proposed);
        _assertUserOpHashStatus(userOpHash, SLAEscrow.UserOpHashStatus.Active);
    }

    function testCannotCommitActiveUserOpHash() public {
        bytes32 userOpHash = bytes32(uint256(17));
        _commit(userOpHash, FEE);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.UserOpUnavailable.selector, userOpHash, SLAEscrow.UserOpHashStatus.Active)
        );
        escrow.commit{value: FEE}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function testCannotCommitConsumedUserOpHash() public {
        _deposit(COLLATERAL);
        bytes32 userOpHash = bytes32(uint256(18));
        uint256 commitId = _commit(userOpHash, FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptedBlock + 1);

        _watcherSettle(commitId, c.acceptedBlock + 1);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                SLAEscrow.UserOpUnavailable.selector, userOpHash, SLAEscrow.UserOpHashStatus.Consumed
            )
        );
        escrow.commit{value: FEE}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function testCommitCreatedEventIncludesTerms() public {
        uint256 fee = 0.0002 ether;
        bytes32 userOpHash = bytes32(uint256(11));
        escrow.setProtocolFee(fee);

        vm.expectEmit(true, true, true, true, address(escrow));
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
        uint256 commitId = escrow.commit{value: FEE + fee}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        assertEq(c.acceptDeadline, block.number + ACCEPT_WINDOW_BLOCKS);
        assertEq(c.deadline, 0);
    }

    function testCommitRejectsZeroAcceptWindow() public {
        bytes32 userOpHash = bytes32(uint256(19));

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.InvalidAcceptWindow.selector, 0, 1, escrow.MAX_ACCEPT_WINDOW_BLOCKS())
        );
        escrow.commit{value: FEE}(offerId, userOpHash, 0);
    }

    function testCommitRejectsAcceptWindowAboveMaximum() public {
        bytes32 userOpHash = bytes32(uint256(20));
        uint256 acceptWindowBlocks = escrow.MAX_ACCEPT_WINDOW_BLOCKS() + 1;

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                SLAEscrow.InvalidAcceptWindow.selector, acceptWindowBlocks, 1, escrow.MAX_ACCEPT_WINDOW_BLOCKS()
            )
        );
        escrow.commit{value: FEE}(offerId, userOpHash, acceptWindowBlocks);
    }

    function testCanAcceptAtAcceptDeadline() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(21)), FEE);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptDeadline);

        vm.prank(provider);
        escrow.accept(commitId);

        c = escrow.getCommit(commitId);
        _assertStatus(commitId, SLAEscrow.CommitStatus.Active);
        assertEq(c.deadline, c.acceptedBlock + SLA_BLOCKS);
    }

    function testCannotWithdrawLockedCollateral() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(4)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.InsufficientIdle.selector, 1, 0));
        escrow.withdraw(1);
    }

    function testProtocolFeeIsPaidToFeeRecipient() public {
        uint256 fee = 0.0002 ether;
        escrow.setProtocolFee(fee);

        uint256 commitId = _commit(bytes32(uint256(5)), FEE + fee);

        assertEq(escrow.balanceOf(feeRecipient), fee);

        vm.prank(client);
        escrow.cancel(commitId);

        vm.prank(client);
        escrow.withdraw(FEE);

        vm.prank(feeRecipient);
        escrow.withdraw(fee);

        assertEq(client.balance, 10 ether - fee);
        assertEq(feeRecipient.balance, 10 ether + fee);
        assertEq(address(escrow).balance, 0);
    }

    function testOwnerCanUpdateWatcherRegistry() public {
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        escrow.setWatcherRegistry(address(newRegistry));

        assertEq(address(escrow.watcherRegistry()), address(newRegistry));
    }

    function testNonOwnerCannotUpdateWatcherRegistry() public {
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        vm.prank(stranger);
        vm.expectRevert();
        escrow.setWatcherRegistry(address(newRegistry));
    }

    function testSetWatcherRegistryRejectsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.ZeroAddress.selector, SLAEscrow.AddressParam.WatcherRegistry));
        escrow.setWatcherRegistry(address(0));
    }

    function testSetWatcherRegistryRejectsSelf() public {
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.ZeroAddress.selector, SLAEscrow.AddressParam.WatcherRegistry));
        escrow.setWatcherRegistry(address(escrow));
    }

    function testUpdatedWatcherRegistryControlsResolution() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(22)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;
        vm.roll(inclusionBlock);

        WatcherRegistry oldRegistry = watcherRegistry;
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);
        escrow.setWatcherRegistry(address(newRegistry));

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotWatcherRegistry.selector, address(oldRegistry)));
        oldRegistry.settle(ISLAEscrow(address(escrow)), commitId, inclusionBlock);

        vm.prank(secondWatcher);
        newRegistry.settle(ISLAEscrow(address(escrow)), commitId, inclusionBlock);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Settled);
    }

    function testProtocolFeeUsesUpdatedWatcherRegistryFeeRecipient() public {
        uint256 fee = 0.0002 ether;
        WatcherRegistry newRegistry = new WatcherRegistry(owner, secondFeeRecipient, secondWatcher);

        escrow.setProtocolFee(fee);
        escrow.setWatcherRegistry(address(newRegistry));

        _commit(bytes32(uint256(23)), FEE + fee);

        assertEq(escrow.balanceOf(feeRecipient), 0);
        assertEq(escrow.balanceOf(secondFeeRecipient), fee);
    }

    function testOnlyProviderCanAccept() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(6)), FEE);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotProvider.selector, commitId, stranger));
        escrow.accept(commitId);
    }

    function testCannotAcceptAfterAcceptDeadline() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(15)), FEE);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptDeadline + 1);

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                SLAEscrow.AcceptDeadlineReached.selector, commitId, c.acceptDeadline, c.acceptDeadline + 1
            )
        );
        escrow.accept(commitId);
    }

    function testUnacceptedCommitCancelsAfterDeadlineWithoutSlash() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(16)), FEE);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptDeadline + 1);

        _watcherCancel(commitId);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Cancelled);
        assertEq(escrow.lockedOf(provider), 0);
        assertEq(escrow.balanceOf(provider), COLLATERAL);
        assertEq(escrow.balanceOf(client), FEE);
    }

    function testOnlyWatcherRegistryCanSettle() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(7)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotWatcherRegistry.selector, stranger));
        escrow.settle(commitId, block.number + 1);
    }

    function testOnlyWatcherRegistryCanRefund() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(12)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotWatcherRegistry.selector, client));
        escrow.refund(commitId);
    }

    function testCannotSettleWithLateInclusionBlock() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(8)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.InclusionAfterDeadline.selector, commitId, c.deadline, c.deadline + 1)
        );
        _watcherSettle(commitId, c.deadline + 1);
    }

    function testCannotSettleWithInclusionBeforeAccept() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(9)), FEE);

        vm.roll(block.number + 1);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);

        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.InclusionBeforeAccept.selector, commitId, c.acceptedBlock, c.acceptedBlock)
        );
        _watcherSettle(commitId, c.acceptedBlock);
    }

    function testCannotSettleFutureInclusionBlock() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(13)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);

        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.InclusionInFuture.selector, commitId, c.acceptedBlock, c.acceptedBlock + 1)
        );
        _watcherSettle(commitId, c.acceptedBlock + 1);
    }

    function testWatcherCanSettleLongAfterDeadlineWhenIncludedOnTime() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(14)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;
        vm.roll(c.deadline + 10_000);

        _watcherSettle(commitId, inclusionBlock);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Settled);
        assertEq(escrow.balanceOf(provider), COLLATERAL + FEE);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(provider);
        escrow.deposit{value: amount}();
    }

    function _commit(bytes32 userOpHash, uint256 value) internal returns (uint256 commitId) {
        vm.prank(client);
        commitId = escrow.commit{value: value}(offerId, userOpHash, ACCEPT_WINDOW_BLOCKS);
    }

    function _watcherCancel(uint256 commitId) internal {
        vm.prank(watcher);
        watcherRegistry.cancel(ISLAEscrow(address(escrow)), commitId);
    }

    function _watcherSettle(uint256 commitId, uint256 inclusionBlock) internal {
        vm.prank(watcher);
        watcherRegistry.settle(ISLAEscrow(address(escrow)), commitId, inclusionBlock);
    }

    function _watcherRefund(uint256 commitId) internal {
        vm.prank(watcher);
        watcherRegistry.refund(ISLAEscrow(address(escrow)), commitId);
    }

    function _assertStatus(uint256 commitId, SLAEscrow.CommitStatus status) internal view {
        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        assertEq(uint256(c.status), uint256(status));
    }

    function _assertUserOpHashStatus(bytes32 userOpHash, SLAEscrow.UserOpHashStatus status) internal view {
        assertEq(uint256(escrow.userOpHashStatus(userOpHash)), uint256(status));
    }
}
