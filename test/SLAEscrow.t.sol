// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";

contract SLAEscrowTest is Test {
    OfferRegistry reg;
    SLAEscrow escrow;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address provider = address(0xCAFE);
    address client = address(0xC11E);
    address stranger = address(0xBAD);

    uint256 constant FEE = 0.01 ether;
    uint256 constant COLLATERAL = 0.03 ether;
    uint256 constant SLA_BLOCKS = 20;
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
        uint256 protocolFee,
        uint256 deadline
    );

    function setUp() public {
        reg = new OfferRegistry();
        escrow = new SLAEscrow(address(reg), watcher, owner);

        vm.deal(provider, 10 ether);
        vm.deal(client, 10 ether);
        vm.deal(watcher, 10 ether);

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

        vm.prank(watcher);
        escrow.settle(commitId, c.acceptedBlock + 1);

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

        vm.prank(watcher);
        escrow.refund(commitId);

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
        escrow.commit{value: FEE}(offerId, userOpHash);
    }

    function testCannotCommitConsumedUserOpHash() public {
        _deposit(COLLATERAL);
        bytes32 userOpHash = bytes32(uint256(18));
        uint256 commitId = _commit(userOpHash, FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.acceptedBlock + 1);

        vm.prank(watcher);
        escrow.settle(commitId, c.acceptedBlock + 1);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                SLAEscrow.UserOpUnavailable.selector, userOpHash, SLAEscrow.UserOpHashStatus.Consumed
            )
        );
        escrow.commit{value: FEE}(offerId, userOpHash);
    }

    function testCommitCreatedEventIncludesTerms() public {
        uint256 fee = 0.0002 ether;
        bytes32 userOpHash = bytes32(uint256(11));
        escrow.setProtocolFee(fee);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit CommitCreated(
            1, offerId, client, provider, userOpHash, FEE, COLLATERAL, SLA_BLOCKS, fee, block.number + SLA_BLOCKS
        );

        vm.prank(client);
        escrow.commit{value: FEE + fee}(offerId, userOpHash);
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

    function testProtocolFeeIsPaidToWatcher() public {
        uint256 fee = 0.0002 ether;
        escrow.setProtocolFee(fee);

        uint256 commitId = _commit(bytes32(uint256(5)), FEE + fee);

        assertEq(escrow.balanceOf(watcher), fee);

        vm.prank(client);
        escrow.cancel(commitId);

        vm.prank(client);
        escrow.withdraw(FEE);

        vm.prank(watcher);
        escrow.withdraw(fee);

        assertEq(client.balance, 10 ether - fee);
        assertEq(watcher.balance, 10 ether + fee);
        assertEq(address(escrow).balance, 0);
    }

    function testOnlyProviderCanAccept() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(6)), FEE);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotProvider.selector, commitId, stranger));
        escrow.accept(commitId);
    }

    function testCannotAcceptAtDeadline() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(15)), FEE);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.DeadlineReached.selector, commitId, c.deadline, c.deadline));
        escrow.accept(commitId);
    }

    function testUnacceptedCommitCancelsAfterDeadlineWithoutSlash() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(16)), FEE);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.prank(watcher);
        escrow.cancel(commitId);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Cancelled);
        assertEq(escrow.lockedOf(provider), 0);
        assertEq(escrow.balanceOf(provider), COLLATERAL);
        assertEq(escrow.balanceOf(client), FEE);
    }

    function testOnlyWatcherCanSettle() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(7)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotWatcher.selector, stranger));
        escrow.settle(commitId, block.number + 1);
    }

    function testOnlyWatcherCanRefund() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(12)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        vm.roll(c.deadline + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.NotWatcher.selector, client));
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
        vm.prank(watcher);
        escrow.settle(commitId, c.deadline + 1);
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
        vm.prank(watcher);
        escrow.settle(commitId, c.acceptedBlock);
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
        vm.prank(watcher);
        escrow.settle(commitId, c.acceptedBlock + 1);
    }

    function testWatcherCanSettleLongAfterDeadlineWhenIncludedOnTime() public {
        _deposit(COLLATERAL);
        uint256 commitId = _commit(bytes32(uint256(14)), FEE);

        vm.prank(provider);
        escrow.accept(commitId);

        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        uint256 inclusionBlock = c.acceptedBlock + 1;
        vm.roll(c.deadline + 10_000);

        vm.prank(watcher);
        escrow.settle(commitId, inclusionBlock);

        _assertStatus(commitId, SLAEscrow.CommitStatus.Settled);
        assertEq(escrow.balanceOf(provider), COLLATERAL + FEE);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(provider);
        escrow.deposit{value: amount}();
    }

    function _commit(bytes32 userOpHash, uint256 value) internal returns (uint256 commitId) {
        vm.prank(client);
        commitId = escrow.commit{value: value}(offerId, userOpHash);
    }

    function _assertStatus(uint256 commitId, SLAEscrow.CommitStatus status) internal view {
        SLAEscrow.Commit memory c = escrow.getCommit(commitId);
        assertEq(uint256(c.status), uint256(status));
    }

    function _assertUserOpHashStatus(bytes32 userOpHash, SLAEscrow.UserOpHashStatus status) internal view {
        assertEq(uint256(escrow.userOpHashStatus(userOpHash)), uint256(status));
    }
}
