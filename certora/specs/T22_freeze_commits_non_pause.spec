// docs/DESIGN.md T22 / Non-goals -- "freezeCommits() is NOT a pause or emergency stop."
//
// "The protocol has no pause mechanism. commitsFrozen is a one-way latch that only
//  blocks commit(). All resolution paths remain open when commitsFrozen is true:
//  BUNDLER can still accept PROPOSED commits, CLIENT can still cancel, anyone
//  with a valid proof can still settle ACTIVE commits, refunds remain claimable,
//  and pull-payment withdrawal is unaffected."
//
// This spec proves exactly that claim: when commitsFrozen == true, none of the
// resolution and payout functions are blocked by the flag.
//
//   NP1. accept()      -- PROPOSED → ACTIVE transition still works
//   NP2. cancel()      -- PROPOSED → CANCELLED still works (CLIENT always authorized)
//   NP3. claimRefund() -- ACTIVE → REFUNDED still works after window
//   NP4. withdraw()    -- pull-payment still works
//
// settle() with commitsFrozen is NOT included here: settle() calls
// _verifyReceiptProof (external library chain) and is covered in
// A10_inclusion_proof.spec under similar symbolic assumptions.
//
// Theorem: T22 (non-pause subclaim)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function commitsFrozen() external returns (bool) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function reservedBalance() external returns (uint256) envfree;
    function idleBalance(address) external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // Address.sendValue contains a raw call{value}("") whose target the prover cannot
    // precisely resolve (warning 1277565207). Without a summary, the prover may assume
    // the call returns success=false and manufacture a FailedInnerCall revert even when
    // all balance preconditions hold. NONDET models the transfer as non-reverting.
    // Same rationale as T2_idle_withdrawable (see that spec for full explanation).
    function Address.sendValue(address payable, uint256) internal => NONDET;

    // ReentrancyGuardTransient uses EIP-1153 tload/tstore. Certora models transient
    // storage as arbitrary symbolic state (not zero-initialized per EIP-1153 semantics).
    // For a top-level transaction call -- the only scenario we model in this spec --
    // the guard is never entered. ALWAYS(false) encodes that invariant and prevents
    // spurious reentrancy-guard reverts from polluting the NP4 liveness proof.
    function ReentrancyGuardTransient._reentrancyGuardEntered() internal returns (bool) => ALWAYS(false);
}

// NP1: commitsFrozen does not gate accept(). A PROPOSED commit with a valid bundler,
// within the accept window and with sufficient idle collateral, can always be accepted.
rule NP1_frozen_does_not_block_accept(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require commitsFrozen();
    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));
    require to_mathint(deposited(bundler)) - to_mathint(lockedOf(bundler))
          >= to_mathint(collateralLocked);
    require to_mathint(lockedOf(bundler)) + to_mathint(collateralLocked) <= max_uint256;
    // Overflow guard for deadline computation inside accept()
    require to_mathint(e.block.number) + to_mathint(slaBlocks) <= max_uint64;

    accept@withrevert(e, commitId);

    assert !lastReverted,
        "NP1: commitsFrozen must not block accept() on a valid PROPOSED commit";
}

// NP2: commitsFrozen does not gate cancel(). CLIENT is always authorized to cancel
// a PROPOSED commit (during or after the accept window).
rule NP2_frozen_does_not_block_cancel(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require commitsFrozen();
    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == user; // CLIENT is always authorized
    require e.msg.value == 0;
    // Overflow guard for pendingWithdrawals[user] += feePaid
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel@withrevert(e, commitId);

    assert !lastReverted,
        "NP2: commitsFrozen must not block cancel() by CLIENT on a PROPOSED commit";
}

// NP3: commitsFrozen does not gate claimRefund(). An expired ACTIVE commit can be
// refunded by CLIENT after the refund window opens.
rule NP3_frozen_does_not_block_claimRefund(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require commitsFrozen();
    require user != 0;
    require accepted && !cancelled && !settled && !refunded; // ACTIVE
    require e.msg.sender == user; // CLIENT path (always authorized)
    require e.msg.value == 0;

    // Past refund window: block.number >= deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    uint64 refundGrace     = REFUND_GRACE_BLOCKS();
    mathint unlocksAt = to_mathint(deadline) + to_mathint(settlementGrace)
                      + to_mathint(refundGrace) + 1;
    require unlocksAt <= max_uint64;
    // Contract casts uint64(block.number); bound it so the cast doesn't truncate
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;

    // Slash preconditions: bundler has enough deposited to slash
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(collateralLocked);
    // Overflow guard for pendingWithdrawals[user] += feePaid + collateralLocked
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    claimRefund@withrevert(e, commitId);

    assert !lastReverted,
        "NP3: commitsFrozen must not block claimRefund() on an expired ACTIVE commit";
}

// NP4: commitsFrozen does not gate withdraw(). Pull-payment withdrawal of idle
// collateral or pending payouts is unaffected by the freeze flag.
//
// Preconditions mirror T2_idle_withdraw_never_reverts exactly (which PASSES),
// with the addition of `commitsFrozen()` to prove the flag has no effect.
// Uses idleBalance() intermediary following T2's verified pattern.
rule NP4_frozen_does_not_block_withdraw(uint256 amount) {
    env e;

    require commitsFrozen();

    // withdraw() is non-payable.
    require e.msg.value == 0;

    // withdrawTo(payable(msg.sender), ...) reverts if msg.sender == 0.
    // Exclude the contract itself: SLAEscrow has no receive() and cannot call
    // withdraw() against itself via any public path (mirrors T2 modelling).
    require e.msg.sender != 0;
    require e.msg.sender != escrow;

    // idleBalance intermediary -- mirrors T2_idle_withdraw_never_reverts exactly.
    uint256 idle = idleBalance(e.msg.sender);
    require amount > 0;
    require to_mathint(amount) <= to_mathint(idle);

    // A4 global accounting chain (not derivable by Certora from the rule alone):
    //   reservedBalance >= deposited[sender]: keeps `reservedBalance -= amount` safe.
    //   nativeBalances[escrow] >= reservedBalance: keeps Address.sendValue balance check safe.
    require to_mathint(reservedBalance()) >= to_mathint(deposited(e.msg.sender));
    require to_mathint(nativeBalances[escrow]) >= to_mathint(reservedBalance());

    withdraw@withrevert(e, amount);

    assert !lastReverted,
        "NP4: commitsFrozen must not block withdraw() of idle collateral";
}
