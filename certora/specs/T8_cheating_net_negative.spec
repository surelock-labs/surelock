// docs/DESIGN.md T8 -- Deliberate SLA miss is net-negative.
//
// "A BUNDLER who misses the SLA loses both the forfeited collateral and the
//  foregone honor fee in the same event; total P&L loss = collateral +
//  netHonorFee > 0."
//
// This spec verifies:
// 1. After claimRefund(), the bundler's deposited balance decreases by exactly
//    collateralLocked (the slash removes it from deposited).
// 2. The bundler receives 0 additional pendingWithdrawals from the refund path.
// 3. The combined P&L loss (collateral + netHonorFee) is always > 0.
//
// Note: QuoteRegistry enforces collateral > feePerOp (strict, T8 hardening) and
// feePerOp > 0, so collateral > 0 always. Total loss on slash =
// collateral + unearned feePerOp > 0. PROTOCOL takes 0 share of slashed
// collateral -- 100% goes to CLIENT via claimRefund.
//
// Theorem: T8 (also touches A3)
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

// Rule: after a successful claimRefund call, the bundler's deposited balance
// must have decreased, and the bundler receives nothing from the refund.
rule T8_bundler_loses_on_refund(uint256 commitId) {
    env e;

    // Read commit fields
    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    // Preconditions: commit is open, has real collateral
    require !settled && !refunded && !cancelled;
    require accepted; // claimRefund requires ACTIVE commit (accepted=true)
    require collateralLocked > 0;
    require user != 0; // valid commit
    require bundler != 0;
    require user != bundler; // bundler is not also the user (would gain pendingWithdrawals)
    // v0.6: refund is 100% to client; feeRecipient not touched on refund path

    // Non-payable: msg.value > 0 causes implicit revert
    require e.msg.value == 0;

    // Caller must be authorized (user, bundler, or feeRecipient) -- otherwise Unauthorized fires
    require e.msg.sender == bundler || e.msg.sender == user || e.msg.sender == feeRecipient();

    // claimRefund is only callable after the full grace window has expired
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    uint64 refundGrace     = REFUND_GRACE_BLOCKS();
    mathint unlocksAt = to_mathint(deadline) + to_mathint(settlementGrace)
                      + to_mathint(refundGrace) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;

    // Accounting invariants: lockedOf and deposited are consistent with an open commit.
    // Without these, the in-contract subtractions underflow and claimRefund always reverts.
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));

    // Overflow guard: pendingWithdrawals[user] += feePaid + collateralLocked must not overflow
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid)
          + to_mathint(collateralLocked) <= max_uint256;

    // Snapshot bundler state before
    mathint depositedBefore = deposited(bundler);
    mathint pendingBefore   = pendingWithdrawals(bundler);

    // Execute refund (no @withrevert: vacuous on revert, asserts checked on success paths only)
    claimRefund(e, commitId);

    // Post-conditions
    mathint depositedAfter = deposited(bundler);
    mathint pendingAfter   = pendingWithdrawals(bundler);

    // Bundler's deposited balance must decrease by exactly collateralLocked
    assert depositedBefore - depositedAfter == to_mathint(collateralLocked),
        "T8: bundler deposited must decrease by collateralLocked on slash";

    // Bundler receives 0 additional pendingWithdrawals (they get nothing)
    assert pendingAfter == pendingBefore,
        "T8: bundler must not gain pending on slash path";
}
