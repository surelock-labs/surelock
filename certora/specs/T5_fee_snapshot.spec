// docs/DESIGN.md T5 -- Fee exact-match and snapshot immutability.
//
// "T5: CLIENT never pays more or less than the exact fee quoted at commit time.
//  commit() requires msg.value == offer.feePerOp + protocolFeeWei exactly
//  (WrongFee revert if not). The snapshotted feePaid is immutable -- subsequent
//  changes to protocolFeeWei cannot alter existing commit economics."
//
// Three rules:
//   T5_feePaid_equals_msg_value_minus_protocol_fee
//       On success, feePaid == msg.value - protocolFeeWei (the arithmetic fact
//       that follows from the WrongFee check and the feePaid assignment).
//
//   T5_commit_wrong_fee_reverts
//       If msg.value is zero while protocolFeeWei > 0, commit() reverts.
//       Concrete "wrong fee" witness -- proves the WrongFee guard fires.
//
//   T5_setProtocolFee_does_not_change_feePaid
//       setProtocolFeeWei does not alter the feePaid stored in any existing commit.
//       "Snapshot immutability" -- CLIENT is bound to the fee at commit time only.
//       (Cross-references A6_admin_no_effect_on_open_commits which proves all 14
//        fields are frozen; this rule provides a focused single-field statement.)
//
// A4_commit_accounting.spec (A4_commit_creates_proposed_record) also proves
// feePaid == msg.value - protocolFeeWei as part of a larger snapshot rule.
// T5 isolates and labels that claim for theorem traceability.
//
// Theorem: T5
// Contract: SLAEscrow
// Status: READY (pending fix+run)

using SLAEscrow as escrow;

methods {
    function protocolFeeWei() external returns (uint256) envfree;
    function owner() external returns (address) envfree;
    function nextCommitId() external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: on successful commit(), feePaid == msg.value - protocolFeeWei.
// The WrongFee check enforces msg.value == offer.feePerOp + protocolFeeWei, and
// feePaid is assigned offer.feePerOp, so feePaid == msg.value - protocolFeeWei.
rule T5_feePaid_equals_msg_value_minus_protocol_fee(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    uint256 idBefore = nextCommitId();
    mathint protocolFee = to_mathint(protocolFeeWei());

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);
    bool reverted = lastReverted; // capture before envfree calls reset it

    address rUser; uint96 rFeePaid; address rBundler; uint96 rColl;
    uint64 rDeadline; bool rSettled; bool rRefunded;
    uint256 rQuoteId; bytes32 rUserOpHash; uint64 rInclusionBlock;
    bool rAccepted; bool rCancelled; uint64 rAcceptDeadline; uint32 rSlaBlocks;

    rUser, rFeePaid, rBundler, rColl, rDeadline, rSettled, rRefunded
        = getCommitCore(idBefore);
    rQuoteId, rUserOpHash, rInclusionBlock,
        rAccepted, rCancelled, rAcceptDeadline, rSlaBlocks = getCommitState(idBefore);

    assert !reverted =>
        to_mathint(rFeePaid) == to_mathint(e.msg.value) - protocolFee,
        "T5: feePaid must equal msg.value - protocolFeeWei on successful commit()";
}

// Rule: commit() reverts when msg.value is zero but protocolFeeWei > 0.
// This is a concrete wrong-fee witness: zero cannot equal offer.feePerOp + protocolFeeWei
// when protocolFeeWei > 0. Proves the WrongFee guard fires for a simple undercharge.
rule T5_commit_wrong_fee_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    require e.msg.value == 0;
    require protocolFeeWei() > 0; // fee > 0 ensures 0 is always wrong

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T5: commit() must revert when msg.value == 0 and protocolFeeWei > 0 (WrongFee)";
}

// Rule: setProtocolFeeWei does not alter feePaid in any existing commit.
// T5 snapshot immutability: CLIENT is bound to the economics at commit time only.
// (Cross-reference: A6_admin_no_effect_on_open_commits proves ALL 14 fields frozen.)
rule T5_setProtocolFee_does_not_change_feePaid(uint256 commitId, uint256 newFee) {
    env e;

    address rUser; uint96 rFeePaid; address rBundler; uint96 rColl;
    uint64 rDeadline; bool rSettled; bool rRefunded;

    rUser, rFeePaid, rBundler, rColl, rDeadline, rSettled, rRefunded
        = getCommitCore(commitId);

    require e.msg.sender == owner();
    require e.msg.value == 0;

    setProtocolFeeWei(e, newFee);

    address rUser2; uint96 rFeePaid2; address rBundler2; uint96 rColl2;
    uint64 rDeadline2; bool rSettled2; bool rRefunded2;

    rUser2, rFeePaid2, rBundler2, rColl2, rDeadline2, rSettled2, rRefunded2
        = getCommitCore(commitId);

    assert rFeePaid2 == rFeePaid,
        "T5: setProtocolFeeWei must not alter feePaid in existing commits";
}
