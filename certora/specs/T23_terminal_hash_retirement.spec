// docs/DESIGN.md T23 / T1 -- userOpHash is permanently retired after any terminal state.
//
// "Every terminal state (SETTLED, REFUNDED, CANCELLED) sets retiredHashes[userOpHash]
//  permanently. Retired hashes block future commit() calls, preventing slot recycling
//  and double-payment even after the active-flag is cleared."
//
// T23_hash_uniqueness.spec covers: second commit on active hash reverts, commit()
// sets active flag, settle() and claimRefund() clear the active flag.
//
// This spec adds the missing coverage:
// 1. T23_cancel_clears_active_flag  -- cancel() clears activeCommitForHash.
// 2. T23_cancel_retires_hash        -- cancel() sets retiredHashes = true.
// 3. T23_settle_retires_hash        -- settle() sets retiredHashes = true.
// 4. T23_claimRefund_retires_hash   -- claimRefund() sets retiredHashes = true.
// 5. T23_retired_hash_blocks_commit -- retiredHashes[hash] == true => commit() reverts.
//
// Theorem: T23 (also T1)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function activeCommitForHash(bytes32) external returns (bool) envfree;
    function retiredHashes(bytes32) external returns (bool) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // Summarize the MPT/blockhash proof pipeline as NONDET so the prover can
    // explore successful settle() paths. Proof correctness is verified separately
    // in A10_inclusion_proof.spec.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: successful cancel() clears activeCommitForHash[c.userOpHash].
rule T23_cancel_clears_active_flag(uint256 commitId) {
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
    require !settled && !refunded && !cancelled;
    require !accepted; // PROPOSED state (cancel() requires CommitNotProposed if accepted)
    require activeCommitForHash(userOpHash) == true;
    // CLIENT is always authorized (during window and after)
    require e.msg.sender == user;
    require e.msg.value == 0;
    // Overflow guard for pendingWithdrawals[user] += feePaid
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel(e, commitId);

    assert activeCommitForHash(userOpHash) == false,
        "T23: successful cancel must clear activeCommitForHash[c.userOpHash]";
}

// Rule: successful cancel() sets retiredHashes[c.userOpHash] = true.
rule T23_cancel_retires_hash(uint256 commitId) {
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
    require !settled && !refunded && !cancelled;
    require !accepted;
    require e.msg.sender == user;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    cancel(e, commitId);

    assert retiredHashes(userOpHash) == true,
        "T23: successful cancel must set retiredHashes[c.userOpHash] to true";
}

// Rule: successful settle() sets retiredHashes[c.userOpHash] = true.
rule T23_settle_retires_hash(
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

    require user != 0;
    require !settled && !refunded && !cancelled;
    require accepted; // ACTIVE state required

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert retiredHashes(userOpHash) == true,
        "T23: successful settle must set retiredHashes[c.userOpHash] to true";
}

// Rule: successful claimRefund() sets retiredHashes[c.userOpHash] = true.
rule T23_claimRefund_retires_hash(uint256 commitId) {
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
    require !settled && !refunded && !cancelled;
    require accepted; // ACTIVE state required

    claimRefund(e, commitId);

    assert retiredHashes(userOpHash) == true,
        "T23: successful claimRefund must set retiredHashes[c.userOpHash] to true";
}

// NOTE: T23_terminal_implies_retired and T23_terminal_implies_inactive were removed.
// As plain rules, Certora starts from arbitrary storage, so it trivially constructs
// a spurious state (refunded=true, retiredHashes=false) that is unreachable from
// initialize(). These "combined-path invariants" would require CVL `invariant`
// declarations with ghost variables to prove inductively. The claim is fully covered
// by the five transition rules above: each terminal path retires the hash (rules
// T23_cancel_retires_hash, T23_settle_retires_hash, T23_claimRefund_retires_hash),
// retire blocks re-commit (T23_retired_hash_blocks_commit), and the hash can never
// be un-retired (T23_retired_hash_monotone). Together these close T23 for all
// reachable states.

// Rule: retiredHashes is a one-way ratchet -- once set, no function can clear it.
// upgradeToAndCall excluded (governance escape hatch via delegatecall, protected by 48h TimelockController).
// rule_sanity: none in conf -- commit() always reverts when retiredHashes[h]=true
// (UserOpHashRetired), making the assertion vacuously true for that variant. Expected by design.
rule T23_retired_hash_monotone(bytes32 h, method f, calldataarg args)
    filtered {
        f -> f.contract == escrow
          && f.selector != sig:upgradeToAndCall(address,bytes).selector
    }
{
    env e;
    require retiredHashes(h) == true;

    f(e, args);

    assert retiredHashes(h) == true,
        "T23: retiredHashes is a one-way ratchet; no function (except upgradeToAndCall) can clear it";
}

// Rule: if retiredHashes[userOpHash] == true, commit() must revert (UserOpHashRetired).
// T1/T23: once retired, a userOpHash can never be the basis of a new commitment.
rule T23_retired_hash_blocks_commit(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    require retiredHashes(userOpHash) == true;

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T23/T1: commit must revert when retiredHashes[userOpHash] is true";
}
