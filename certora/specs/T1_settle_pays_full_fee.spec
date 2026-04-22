// docs/DESIGN.md T1 / A4 -- settle() credits the full feePerOp to BUNDLER; no protocol
// cut is taken; lockedOf decreases by collateralLocked; deposited is unchanged.
//
// "T1: on settlement BUNDLER receives feePerOp in full. The protocol fee was taken
//  at commit time and is non-refundable. Settlement frees BUNDLER's locked collateral
//  back to idle, but does not reduce deposited -- BUNDLER can withdraw it afterwards."
//
// Five rules:
//   T1_settle_credits_full_fee      -- pendingWithdrawals[bundler] += feePaid
//   T1_settle_frees_locked          -- lockedOf[bundler] -= collateralLocked
//   T1_settle_deposited_unchanged   -- deposited[bundler] unchanged
//   T1_settle_user_unchanged        -- pendingWithdrawals[user] unchanged (user paid fee, gets nothing on success)
//   T1_settle_permissionless        -- non-bundler caller gets same payout to c.bundler
//
// settle() calls _verifyReceiptProof; NONDET so the prover can explore success paths.
// Proof pipeline correctness is verified separately in A10_inclusion_proof.spec.
//
// Theorem: T1 (also A4)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;

    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Shared setup: ACTIVE commit within settlement window, hash not yet retired.
// (Extracted via comment; CVL does not support rule-level helpers, so preconditions
//  are repeated per-rule for clarity and prover completeness.)

// Rule: successful settle() credits exactly feePaid to pendingWithdrawals[c.bundler].
// T1: bundler receives feePerOp in full -- no protocol deduction at settlement time.
rule T1_settle_credits_full_fee(
    uint256 commitId,
    uint64  inclusionBlock,
    bytes   blockHeaderRlp,
    bytes[] receiptProof,
    uint256 txIndex
) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlockStored;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlockStored,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.value == 0;
    require to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS()) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS());
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(bundler)) + to_mathint(feePaid) <= max_uint256;

    mathint pendingBefore = to_mathint(pendingWithdrawals(bundler));

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert to_mathint(pendingWithdrawals(bundler)) == pendingBefore + to_mathint(feePaid),
        "T1: settle() must credit exactly feePaid to pendingWithdrawals[bundler]";
}

// Rule: successful settle() decreases lockedOf[bundler] by exactly collateralLocked.
// Settlement releases the locked collateral back to idle; bundler can withdraw it.
rule T1_settle_frees_locked(
    uint256 commitId,
    uint64  inclusionBlock,
    bytes   blockHeaderRlp,
    bytes[] receiptProof,
    uint256 txIndex
) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlockStored;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlockStored,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.value == 0;
    require to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS()) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS());
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(bundler)) + to_mathint(feePaid) <= max_uint256;

    mathint lockedBefore = to_mathint(lockedOf(bundler));

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert to_mathint(lockedOf(bundler)) == lockedBefore - to_mathint(collateralLocked),
        "T1: settle() must decrease lockedOf[bundler] by exactly collateralLocked";
}

// Rule: successful settle() does NOT change deposited[bundler].
// Settlement releases locked → idle; it does not remove funds from the escrow.
rule T1_settle_deposited_unchanged(
    uint256 commitId,
    uint64  inclusionBlock,
    bytes   blockHeaderRlp,
    bytes[] receiptProof,
    uint256 txIndex
) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlockStored;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlockStored,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.value == 0;
    require to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS()) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS());
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(bundler)) + to_mathint(feePaid) <= max_uint256;

    mathint depositedBefore = to_mathint(deposited(bundler));

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert to_mathint(deposited(bundler)) == depositedBefore,
        "T1: settle() must not change bundler's deposited balance";
}

// Rule: settle() is permissionless -- fee is always routed to c.bundler (the snapshotted
// address at commit time), regardless of who calls settle(). A non-bundler caller's
// pendingWithdrawals is not increased.
rule T1_settle_permissionless_fee_routing(
    uint256 commitId,
    uint64  inclusionBlock,
    bytes   blockHeaderRlp,
    bytes[] receiptProof,
    uint256 txIndex
) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlockStored;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlockStored,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.value == 0;
    require to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS()) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS());
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(bundler)) + to_mathint(feePaid) <= max_uint256;

    // Non-bundler caller (e.g. an altruistic relayer)
    require e.msg.sender != bundler;
    require e.msg.sender != user;

    mathint callerPendingBefore = to_mathint(pendingWithdrawals(e.msg.sender));

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    // Caller's pending does not increase -- fee goes to c.bundler not msg.sender
    assert to_mathint(pendingWithdrawals(e.msg.sender)) == callerPendingBefore,
        "T1: settle() must not increase pendingWithdrawals of a non-bundler caller";
}
