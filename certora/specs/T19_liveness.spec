// docs/DESIGN.md T19 -- No funds can be permanently locked.
//
// "Every wei is assigned to a claimant. Every commitment resolves within a
//  bounded time horizon. No combination of actor inaction can trap funds
//  indefinitely."
//
// The liveness-critical case is: CLIENT disappears after commit but before
// claimRefund. T12 says BUNDLER can self-trigger after the full grace window.
// This spec is the symbolic complement of the Kontrol property
// `testProp_T19_bundlerCanFreeLockedCollateral`: whereas Kontrol explores the
// property over concrete traces, this rule proves it symbolically against the
// compiled bytecode for any reachable open commit.
//
// Rule: for any open commit c, once the current block is at or past
// c.deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1, calling
// claimRefund(commitId) from c.bundler with msg.value == 0 must succeed
// (not revert).
//
// Theorem: T19 (subsumes T12 liveness; also touches A4, A8, A9)
// Contract: SLAEscrow
// Status: READY

using SLAEscrow as escrow;

methods {
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function reservedBalance() external returns (uint256) envfree;
    function nextCommitId() external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
}

// Rule: BUNDLER can always free their locked collateral after the full grace
// window. No combination of state (client silent, owner absent) can trap it.
rule T19_claimRefund_always_available(uint256 commitId) {
    env e;

    // Read the commit tuple.
    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    // Preconditions: commit is open (non-finalized) and has a real bundler.
    require !settled && !refunded && !cancelled;
    require accepted; // claimRefund requires ACTIVE commit (accepted=true)
    require user != 0;
    require bundler != 0;

    // Caller = bundler; claimRefund is non-payable.
    require e.msg.sender == bundler;
    require e.msg.value == 0;

    // Bound uint64 arithmetic so unlocksAt and block.number do not wrap.
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    uint64 refundGrace     = REFUND_GRACE_BLOCKS();
    mathint unlocksAt = to_mathint(deadline)
                      + to_mathint(settlementGrace)
                      + to_mathint(refundGrace) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;

    // We are at or past the end of the refund grace window.
    require to_mathint(e.block.number) >= unlocksAt;

    // Contract-level invariants Certora cannot auto-derive: locked and
    // deposited accounting are consistent with an open commit.
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));

    // v0.6: refund is 100% to client; feeRecipient not touched on refund path.
    // pendingWithdrawals arithmetic must not overflow when userTotal is added.
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid)
          + to_mathint(collateralLocked) <= max_uint256;

    // Execute -- must NOT revert. If this rule holds, BUNDLER capital is never
    // permanently locked regardless of CLIENT or OWNER behaviour.
    claimRefund@withrevert(e, commitId);

    assert !lastReverted,
        "T19: claimRefund from bundler must always succeed past the refund grace window";
}
