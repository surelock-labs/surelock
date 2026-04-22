// docs/DESIGN.md A4 -- Conservation of value, commit() path.
//
// "Every wei is always assigned to exactly one claimant."
//
// commit() moves msg.value from CLIENT into the escrow:
//   reservedBalance                   += msg.value
//   pendingWithdrawals[feeRecipient]  += protocolFeeWei  (if non-zero)
//   commits[id].feePaid                = offer.feePerOp  (= msg.value - protocolFeeWei)
//   lockedOf[bundler]                  unchanged  (T25: no collateral locked before accept)
//
// A4_eth_conservation.spec proves the global reservedBalance invariant and per-function
// rules for deposit(), withdraw(), claimPayout(), and claimRefund(). This spec adds the
// commit() accounting rules that were missing there:
//
// 1. A4_commit_increases_reserved_by_msg_value
// 2. A4_commit_credits_protocol_fee
// 3. A4_commit_does_not_modify_lockedOf   (T25 corollary -- no lock before accept)
//
// Rules 1 and 2 use @withrevert + implication so they hold on any state where commit()
// may or may not succeed. rule_sanity: basic verifies that a non-reverting path exists
// (vacuity check) -- with optimistic_fallback: true the prover finds a valid path via
// the external registry call returning favorable symbolic values.
//
// Theorem: A4 (commit() path; also T25)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function reservedBalance() external returns (uint256) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function protocolFeeWei() external returns (uint256) envfree;
    function nextCommitId() external returns (uint256) envfree;
    function ACCEPT_GRACE_BLOCKS() external returns (uint64) envfree;
    function activeCommitForHash(bytes32) external returns (bool) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // settle() calls _verifyReceiptProof (variable-length arrays). Same NONDET rationale
    // as A4_eth_conservation.spec: proof pipeline writes no reservedBalance slot.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: commit() increases reservedBalance by exactly msg.value on success.
rule A4_commit_increases_reserved_by_msg_value(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    mathint reservedBefore = reservedBalance();

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);
    bool revertedR = lastReverted; // capture before any subsequent envfree calls

    mathint reservedAfter = reservedBalance();

    // On revert, storage is rolled back and reservedAfter == reservedBefore trivially.
    assert !revertedR => (reservedAfter == reservedBefore + to_mathint(e.msg.value)),
        "A4: commit() must increase reservedBalance by exactly msg.value";
}

// Rule: commit() increases pendingWithdrawals[feeRecipient] by exactly protocolFeeWei
// on success. When protocolFeeWei == 0, feeRecipient's pending is unchanged.
rule A4_commit_credits_protocol_fee(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    address fr    = feeRecipient();
    mathint feeBefore = pendingWithdrawals(fr);
    mathint fee       = to_mathint(protocolFeeWei());

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);
    bool revertedF = lastReverted; // capture before any subsequent envfree calls

    mathint feeAfter = pendingWithdrawals(fr);

    assert !revertedF => (feeAfter == feeBefore + fee),
        "A4: commit() must credit exactly protocolFeeWei to pendingWithdrawals[feeRecipient]";
}

// Rule: successful commit() creates a correctly-snapshotted PROPOSED record.
// Verifies that the new commit at commits[nextCommitId_before] has:
//   user == msg.sender, bundler/collateral/quoteId/userOpHash/slaBlocks as supplied,
//   feePaid == msg.value - protocolFeeWei, deadline == 0, accepted/cancelled/settled/refunded == false,
//   acceptDeadline == block.number + ACCEPT_GRACE_BLOCKS, activeCommitForHash[userOpHash] == true.
rule A4_commit_creates_proposed_record(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    uint256 idBefore   = nextCommitId();
    uint64  grace      = ACCEPT_GRACE_BLOCKS();
    mathint expectedAcceptDeadline = to_mathint(e.block.number) + to_mathint(grace);
    mathint feeBefore  = to_mathint(protocolFeeWei());
    require expectedAcceptDeadline <= max_uint64; // overflow guard for uint64 cast in commit()

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);
    bool revertedC = lastReverted; // capture before any subsequent envfree calls

    address rUser; uint96 rFeePaid; address rBundler; uint96 rColl;
    uint64 rDeadline; bool rSettled; bool rRefunded;
    uint256 rQuoteId; bytes32 rUserOpHash; uint64 rInclusionBlock;
    bool rAccepted; bool rCancelled; uint64 rAcceptDeadline; uint32 rSlaBlocks;

    rUser, rFeePaid, rBundler, rColl, rDeadline, rSettled, rRefunded
        = getCommitCore(idBefore);
    rQuoteId, rUserOpHash, rInclusionBlock,
        rAccepted, rCancelled, rAcceptDeadline, rSlaBlocks = getCommitState(idBefore);

    assert !revertedC => (
        rUser    == e.msg.sender &&
        rBundler == bundler &&
        rColl    == collateral &&
        rDeadline == 0 &&
        !rSettled && !rRefunded &&
        rQuoteId     == quoteId &&
        rUserOpHash  == userOpHash &&
        rInclusionBlock == 0 &&
        !rAccepted && !rCancelled &&
        to_mathint(rAcceptDeadline) == expectedAcceptDeadline &&
        rSlaBlocks == slaBlocks &&
        activeCommitForHash(userOpHash) == true &&
        to_mathint(rFeePaid) == to_mathint(e.msg.value) - feeBefore
    ),
    "A4: successful commit() must create a PROPOSED record with correct snapshotted fields";
}

// Rule: commit() never modifies lockedOf[bundler] on any path (success or revert).
// T25: collateral is only locked when BUNDLER explicitly calls accept().
// On revert, storage is rolled back trivially; on success, commit() code does not touch lockedOf.
rule A4_commit_does_not_modify_lockedOf(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    mathint lockedBefore = to_mathint(lockedOf(bundler));

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    mathint lockedAfter = to_mathint(lockedOf(bundler));

    assert lockedAfter == lockedBefore,
        "A4/T25: commit() must not modify lockedOf[bundler] on any code path";
}
