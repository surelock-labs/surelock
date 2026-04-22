// docs/DESIGN.md A9 -- Authority windows for cancel() and claimRefund().
//
// "A9: resolution authority is time-bounded and caller-bounded.
//
//  cancel():
//    During accept window  (block.number <= acceptDeadline):
//      Only CLIENT (c.user) may cancel -- BUNDLER and feeRecipient are excluded.
//    After accept window   (block.number >  acceptDeadline):
//      CLIENT, BUNDLER, or feeRecipient may cancel.
//      Third parties are always excluded.
//
//  claimRefund():
//    Before refund window opens (block.number < deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1):
//      Always reverts with NotExpired.
//    At or after refund window:
//      CLIENT, BUNDLER, or feeRecipient may trigger.
//      Third parties are always excluded."
//
// Nine rules:
//  W1. cancel by non-user during window reverts
//  W2. cancel by CLIENT during window succeeds
//  W3. cancel by CLIENT after window succeeds
//  W4. cancel by BUNDLER after window succeeds
//  W5. cancel by feeRecipient after window succeeds
//  W6. cancel by third party after window reverts
//  W7. claimRefund before window opens reverts
//  W8. claimRefund by third party after window opens reverts
//  W9. claimRefund by CLIENT after window opens succeeds
//
// Theorem: A9 (also T12)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
}

// -- cancel window rules ---------------------------------------------------

// W1: non-user cancel during accept window reverts.
rule W1_cancel_non_user_during_window_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline); // within window
    require e.msg.sender != user; // not CLIENT
    require e.msg.value == 0;

    cancel@withrevert(e, commitId);

    assert lastReverted,
        "W1: cancel() must revert for non-user caller during the accept window";
}

// W2: CLIENT cancel during accept window succeeds.
rule W2_cancel_client_during_window_succeeds(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    require e.msg.sender == user;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel@withrevert(e, commitId);

    assert !lastReverted,
        "W2: cancel() must succeed for CLIENT caller during the accept window";
}

// W3: CLIENT cancel after accept window succeeds.
rule W3_cancel_client_after_window_succeeds(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) > to_mathint(acceptDeadline); // after window
    require e.msg.sender == user;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel@withrevert(e, commitId);

    assert !lastReverted,
        "W3: cancel() must succeed for CLIENT caller after the accept window";
}

// W4: BUNDLER cancel after accept window succeeds.
rule W4_cancel_bundler_after_window_succeeds(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) > to_mathint(acceptDeadline);
    require bundler != user; // distinct addresses
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel@withrevert(e, commitId);

    assert !lastReverted,
        "W4: cancel() must succeed for BUNDLER caller after the accept window";
}

// W5: feeRecipient cancel after accept window succeeds.
rule W5_cancel_feeRecipient_after_window_succeeds(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    address fr = feeRecipient();
    require user != 0 && fr != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) > to_mathint(acceptDeadline);
    require fr != user && fr != bundler; // distinct addresses
    require e.msg.sender == fr;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel@withrevert(e, commitId);

    assert !lastReverted,
        "W5: cancel() must succeed for feeRecipient caller after the accept window";
}

// W6: third-party cancel after accept window reverts.
// Only CLIENT, BUNDLER, and feeRecipient are authorized after the accept window.
rule W6_cancel_third_party_after_window_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    address fr = feeRecipient();
    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require to_mathint(e.block.number) > to_mathint(acceptDeadline);
    // Third party: not user, not bundler, not feeRecipient
    require e.msg.sender != user;
    require e.msg.sender != bundler;
    require e.msg.sender != fr;
    require e.msg.value == 0;

    cancel@withrevert(e, commitId);

    assert lastReverted,
        "W6: cancel() must revert for third-party callers after the accept window";
}

// -- claimRefund window rules -----------------------------------------------

// W7: claimRefund() reverts before the refund window opens.
// A9: non-overlapping settle and refund windows; cannot claim refund during settle window.
rule W7_claimRefund_before_window_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require accepted && !settled && !refunded && !cancelled;
    // Only authorized callers (to isolate the timing revert from the auth revert)
    address fr = feeRecipient();
    require e.msg.sender == user || e.msg.sender == bundler || e.msg.sender == fr;
    require e.msg.value == 0;

    // Before refund window: block.number < unlocksAt
    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) < unlocksAt;

    claimRefund@withrevert(e, commitId);

    assert lastReverted,
        "W7: claimRefund() must revert before the refund window opens";
}

// W8: third-party claimRefund after window opens reverts.
// Only CLIENT, BUNDLER, or feeRecipient may trigger resolution (T12/A9).
rule W8_claimRefund_third_party_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    address fr = feeRecipient();
    require user != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender != user && e.msg.sender != bundler && e.msg.sender != fr;
    require e.msg.value == 0;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    // claimRefund uses uint64(block.number); bound to prevent truncation
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;

    claimRefund@withrevert(e, commitId);

    assert lastReverted,
        "W8: claimRefund() must revert for third-party callers at any time";
}

// W9: CLIENT claimRefund after window opens succeeds.
// The positive path confirms the window logic does not over-constrain authorized callers.
rule W9_claimRefund_client_after_window_succeeds(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender == user;
    require e.msg.value == 0;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    // claimRefund uses uint64(block.number); bound to prevent truncation
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;

    require to_mathint(lockedOf(bundler))  >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    claimRefund@withrevert(e, commitId);

    assert !lastReverted,
        "W9: claimRefund() must succeed for CLIENT after the refund window opens";
}
