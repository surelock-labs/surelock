// docs/DESIGN.md T23 -- BUNDLER collateral exposure is bounded by posted amount.
//
// "Uniqueness is enforced per UserOp hash: at most one active commitment per
//  userOpHash exists at any time."
//
// The relevant SLAEscrow state is `activeCommitForHash[bytes32]`:
//   - set true  in commit()    (before all effects)
//   - set false in claimRefund() and _settle()  (when a commit is finalized)
//
// This spec verifies the full lifecycle invariant:
//
// 1. commit() on a userOpHash whose flag is already true must revert
//    (UserOpAlreadyCommitted).
// 2. A successful commit() sets activeCommitForHash[userOpHash] = true.
// 3. settle() on a commit clears activeCommitForHash[c.userOpHash] = false.
// 4. claimRefund() on a commit clears activeCommitForHash[c.userOpHash] = false.
//
// Taken together these rules guarantee: at any block, for any userOpHash, at
// most one commit is simultaneously non-finalized. A BUNDLER's collateral
// exposure per userOpHash is therefore bounded to a single collateralLocked
// amount.
//
// Note: we do not need an explicit ghost -- `activeCommitForHash` is a
// contract-level mapping and Certora can reason over it directly. The
// ghost-variable approach would be a restatement of the same state.
//
// Theorem: T23 (also touches A4)
// Contract: SLAEscrow
// Status: PASS

using SLAEscrow as escrow;

methods {
    function activeCommitForHash(bytes32) external returns (bool) envfree;
    function nextCommitId() external returns (uint256) envfree;
    function protocolFeeWei() external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // Summarize the MPT/blockhash proof pipeline as NONDET so the prover can
    // explore successful settle() paths. Proof correctness is verified separately
    // in A10_inclusion_proof.spec; here we only care about activeCommitForHash.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: calling commit() a second time with the same userOpHash must revert.
// (First commit sets activeCommitForHash[userOpHash] = true; second hits the
//  UserOpAlreadyCommitted guard.)
rule T23_second_commit_same_hash_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    // Precondition: the flag is already set (simulating "some earlier commit
    // against this userOpHash is still open").
    require activeCommitForHash(userOpHash) == true;

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T23: commit with an active userOpHash must revert";
}

// Rule: a successful commit() sets activeCommitForHash[userOpHash] = true.
rule T23_commit_sets_active_flag(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    // Pre: flag must be false for commit to even attempt (checked above); we
    // require it here so we reason only about successful-commit cases.
    require activeCommitForHash(userOpHash) == false;

    commit(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert activeCommitForHash(userOpHash) == true,
        "T23: successful commit must set activeCommitForHash[userOpHash] to true";
}

// Rule: a successful settle() clears activeCommitForHash[c.userOpHash].
rule T23_settle_clears_active_flag(
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

    // Pre: commit is ACTIVE and flagged in activeCommitForHash.
    require !settled && !refunded && !cancelled;
    require accepted; // settle requires ACTIVE commit (accepted=true)
    require activeCommitForHash(userOpHash) == true;

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert activeCommitForHash(userOpHash) == false,
        "T23: successful settle must clear activeCommitForHash[c.userOpHash]";
}

// Rule: a successful claimRefund() clears activeCommitForHash[c.userOpHash].
rule T23_claimRefund_clears_active_flag(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    // Pre: commit is ACTIVE and flagged in activeCommitForHash.
    require !settled && !refunded && !cancelled;
    require accepted; // claimRefund requires ACTIVE commit (accepted=true)
    require activeCommitForHash(userOpHash) == true;

    claimRefund(e, commitId);

    assert activeCommitForHash(userOpHash) == false,
        "T23: successful claimRefund must clear activeCommitForHash[c.userOpHash]";
}
