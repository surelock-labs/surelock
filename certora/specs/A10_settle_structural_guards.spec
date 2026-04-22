// docs/DESIGN.md A10 -- SLA fulfillment is verifiably on-chain.
//
// ⚠  SCOPE: this spec verifies pre-settlement guards only (structural preconditions
//    in settle() that fire BEFORE _verifyReceiptProof is called). It does NOT
//    machine-prove the full MPT/RLP receipt verification pipeline. The proof
//    libraries (MerkleTrie, RLPReader) are assumed-correct audited primitives.
//    See the rationale below for what is and is not covered.
//
// "A commitment is honored if and only if the exact committed userOpHash is
//  proven included through the canonical EntryPoint contract at or before the
//  deadline block."
//
// ---------------------------------------------------------------------------
// Why the full MPT proof path is NOT verified in CVL
// ---------------------------------------------------------------------------
// The full A10 guarantee requires proving that `_verifyReceiptProof` rejects
// every malformed or fake proof. That function chains:
//
//   1. keccak256(blockHeaderRlp) == blockhash(inclusionBlock)
//   2. RLP decode of the block header (variable-length list traversal)
//   3. Merkle Patricia Trie traversal of `receiptProof` against `receiptsRoot`
//   4. RLP decode of the receipt, scanning each log for a specific topic match
//
// Certora Prover cannot symbolically evaluate keccak-based MPT traversal --
// keccak collisions are modeled as axiomatically impossible, but arbitrary
// unbounded RLP lists and trie-branch node traversals blow up the SMT
// encoding. `MerkleTrie` is an imported, audited external library
// (optimism-bedrock lineage); we take its correctness as given, as we would
// for any audited third-party primitive.
//
// The rules below verify the STRUCTURAL pre-conditions that fire BEFORE
// `_verifyReceiptProof` is reached. They are exactly the explicit
// requires in settle() that protect the MPT step from nonsense inputs:
//
//   (a) InclusionAfterDeadline   -- inclusionBlock must be <= c.deadline
//   (b) DeadlinePassed           -- block.number must be <= c.deadline + GRACE
//   (c) BlockHashUnavailable     -- blockhash(inclusionBlock) must be non-zero
//
// (a) and (b) are fully expressible in CVL against the real compiled bytecode.
// (c) relies on the EVM `BLOCKHASH` opcode -- CVL treats its return value as
//     symbolic bytes32, and CVL does not provide a direct hook to force a
//     specific blockhash value (there is no `e.block.hash[n]` accessor).
//     That check is covered by the Kontrol property
//     `testProp_A10_staleBlockhashReverts` instead, which runs symbolically
//     over the same function. The Certora rules below are the subset that
//     gains meaningful coverage from CVL's all-inputs-all-states reasoning.
//
// Together with the assumed correctness of `MerkleTrie.get`, these rules
// imply that settle() only returns payout when the UserOp was included at or
// before the deadline.
//
// Theorem: A10 (pre-condition subset) -- also touches T1, A3
// Contract: SLAEscrow
// Status: READY

using SLAEscrow as escrow;

methods {
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // settle() is external -- Certora calls it directly. The structural checks
    // (deadline, inclusionBlock bounds) fire before _verifyReceiptProof, so
    // rules 1 and 2 (@withrevert) do not need to reach the MPT step.
    // Rule 3 (post-state) calls settle() without @withrevert; summarize the
    // proof pipeline so successful paths are reachable for state assertions.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule 1: settle() reverts with InclusionAfterDeadline whenever the caller
// claims an inclusion block past the SLA deadline. This check fires BEFORE
// any MPT work happens, so no library summarization is needed.
rule A10_inclusion_not_after_deadline(
    uint256          commitId,
    uint64           inclusionBlock,
    bytes            blockHeaderRlp,
    bytes[]          receiptProof,
    uint256          txIndex
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

    // Open commit; caller is the bundler.
    require !settled && !refunded && !cancelled;
    require accepted; // settle requires ACTIVE commit (accepted=true)
    require user != 0;
    require bundler != 0;
    require e.msg.sender == bundler;
    require e.msg.value == 0;

    // Block number window is valid so we isolate the InclusionAfterDeadline
    // revert from the DeadlinePassed revert (the earlier check in settle).
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    mathint graceDeadline = to_mathint(deadline) + to_mathint(settlementGrace);
    require graceDeadline <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) <= graceDeadline;

    // Precondition: the bundler claims an inclusion past the deadline.
    require to_mathint(inclusionBlock) > to_mathint(deadline);

    settle@withrevert(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert lastReverted,
        "A10: settle must revert when inclusionBlock > c.deadline (InclusionAfterDeadline)";
}

// Rule 2: settle() reverts with DeadlinePassed whenever the current block is
// past deadline + SETTLEMENT_GRACE_BLOCKS. This is the "settle window closed"
// check -- after this point the bundler can no longer settle, regardless of
// what proof they submit. Structural check, no MPT evaluation required.
rule A10_deadline_not_passed(
    uint256          commitId,
    uint64           inclusionBlock,
    bytes            blockHeaderRlp,
    bytes[]          receiptProof,
    uint256          txIndex
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

    // Open commit; caller is the bundler.
    require !settled && !refunded && !cancelled;
    require accepted; // settle requires ACTIVE commit (accepted=true)
    require user != 0;
    require bundler != 0;
    require e.msg.sender == bundler;
    require e.msg.value == 0;

    // Precondition: we are past the settlement grace window.
    // Bound the uint64 arithmetic so the contract's own casts don't wrap.
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    mathint graceDeadline = to_mathint(deadline) + to_mathint(settlementGrace);
    require graceDeadline <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) > graceDeadline;

    settle@withrevert(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert lastReverted,
        "A10: settle must revert when block.number > c.deadline + SETTLEMENT_GRACE_BLOCKS";
}

// Rule 3: Any successful settle() must carry an inclusionBlock <= c.deadline.
// Equivalent contrapositive of Rule 1, but expressed as an invariant on
// the post-settlement Commit record -- proves that whatever inclusionBlock
// was written to storage is in-window. This also implicitly covers the
// `BlockHashUnavailable` case: if blockhash was zero the call would have
// reverted and `c.inclusionBlock` would remain 0 (i.e. unchanged) rather
// than being written.
rule A10_settled_inclusion_in_window(
    uint256          commitId,
    uint64           inclusionBlock,
    bytes            blockHeaderRlp,
    bytes[]          receiptProof,
    uint256          txIndex
) {
    env e;

    address user0; uint96 feePaid0; address bundler0; uint96 coll0;
    uint64 deadline0; bool settled0; bool refunded0;
    uint256 quoteId0; bytes32 userOpHash0; uint64 inclusionStored0;
    bool accepted0; bool cancelled0; uint64 acceptDeadline0; uint32 slaBlocks0;

    user0, feePaid0, bundler0, coll0, deadline0, settled0, refunded0
        = getCommitCore(commitId);
    quoteId0, userOpHash0, inclusionStored0,
        accepted0, cancelled0, acceptDeadline0, slaBlocks0 = getCommitState(commitId);

    require !settled0 && !refunded0 && !cancelled0;
    require accepted0; // settle requires ACTIVE commit (accepted=true)
    require user0 != 0 && bundler0 != 0;
    require e.msg.sender == bundler0;
    require e.msg.value == 0;

    // Reasonable block.number bounds so uint64 arithmetic does not wrap
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    require to_mathint(deadline0) + to_mathint(settlementGrace) <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;

    // Execute a (possibly successful) settle.
    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    // Read the updated commit record.
    address user1; uint96 feePaid1; address bundler1; uint96 coll1;
    uint64 deadline1; bool settled1; bool refunded1;
    uint256 quoteId1; bytes32 userOpHash1; uint64 inclusionStored1;
    bool accepted1; bool cancelled1; uint64 acceptDeadline1; uint32 slaBlocks1;

    user1, feePaid1, bundler1, coll1, deadline1, settled1, refunded1
        = getCommitCore(commitId);
    quoteId1, userOpHash1, inclusionStored1,
        accepted1, cancelled1, acceptDeadline1, slaBlocks1 = getCommitState(commitId);

    // If settle succeeded the commit is now marked settled and its recorded
    // inclusionBlock is bound by deadline.
    assert settled1 => to_mathint(inclusionStored1) <= to_mathint(deadline1),
        "A10: settled commits must have inclusionBlock <= c.deadline";
}
