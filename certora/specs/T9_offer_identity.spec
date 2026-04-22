// docs/DESIGN.md T9 -- Bait-and-switch is impossible.
//
// "A BUNDLER who changes offer terms after CLIENT's read causes the commit to
//  revert. A BUNDLER who changes terms after CLIENT's commit cannot alter the
//  snapshotted record. A BUNDLER cannot front-run CLIENT's pending commit by
//  substituting a new offer -- the commit references a specific offer identity
//  (quoteId), and any mismatch causes revert."
//
// This spec verifies the atomic check SLAEscrow.commit() performs against
// QuoteRegistry.getOffer(quoteId) at the end of the function:
//
//   if (offer.bundler       != bundler)       revert OfferMismatch
//   if (offer.collateralWei != collateral)    revert OfferMismatch
//   if (offer.slaBlocks     != slaBlocks)     revert OfferMismatch
//   if (msg.value != offer.feePerOp + PROTOCOL_FEE_WEI) revert WrongFee
//
// Together these ensure that if any of (bundler, collateralWei, slaBlocks,
// feePerOp) differ between what the caller passed and the live on-chain offer,
// the commit reverts. CLIENT can never be silently bound to terms they did not
// read.
//
// We also verify the snapshot property (A6 clause of T9): after a successful
// commit(), the recorded feePaid, bundler, and collateralLocked are the
// caller-supplied values (which by the checks above equal the offer values at
// commit time). Subsequent offer changes cannot alter these stored fields --
// they live in the Commit struct, not the Offer struct.
//
// Theorem: T9 (also touches A6)
// Contract: SLAEscrow + QuoteRegistry
// Status: PASS

using SLAEscrow as escrow;
using QuoteRegistry as registry;

methods {
    // SLAEscrow state
    function nextCommitId() external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function activeCommitForHash(bytes32) external returns (bool) envfree;
    function protocolFeeWei() external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // QuoteRegistry view used inside commit()
    function registry.getOffer(uint256) external returns (QuoteRegistry.Offer) envfree;
    // isActive() depends on block.number (lifetime check) so cannot be envfree;
    // it is not called in any T9 rule -- commit() calls it internally.
    function registry.isActive(uint256) external returns (bool);
}

// Rule: commit() reverts whenever the caller-supplied bundler does not match
// the live offer bundler, regardless of all other parameters.
rule T9_bundler_mismatch_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    QuoteRegistry.Offer offer = registry.getOffer(quoteId);

    // Precondition: supplied bundler differs from on-chain offer bundler.
    require offer.bundler != bundler;

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T9: commit must revert when offer.bundler does not match supplied bundler";
}

// Rule: commit() reverts whenever the caller-supplied collateral does not
// match the live offer collateralWei.
rule T9_collateral_mismatch_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    QuoteRegistry.Offer offer = registry.getOffer(quoteId);

    // Precondition: collateral supplied differs from offer collateralWei.
    require to_mathint(offer.collateralWei) != to_mathint(collateral);

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T9: commit must revert when offer.collateralWei does not match supplied collateral";
}

// Rule: commit() reverts whenever the caller-supplied slaBlocks does not
// match the live offer slaBlocks.
rule T9_slaBlocks_mismatch_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    QuoteRegistry.Offer offer = registry.getOffer(quoteId);

    // Precondition: slaBlocks supplied differs from offer slaBlocks.
    require to_mathint(offer.slaBlocks) != to_mathint(slaBlocks);

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T9: commit must revert when offer.slaBlocks does not match supplied slaBlocks";
}

// Rule: commit() reverts whenever msg.value does not equal
// offer.feePerOp + PROTOCOL_FEE_WEI, regardless of all other parameters.
rule T9_feePerOp_mismatch_reverts(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;

    QuoteRegistry.Offer offer = registry.getOffer(quoteId);
    uint256 protocolFee = protocolFeeWei();

    // Precondition: msg.value does NOT equal the exact required sum.
    require to_mathint(e.msg.value)
          != to_mathint(offer.feePerOp) + to_mathint(protocolFee);

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T9: commit must revert when msg.value != offer.feePerOp + PROTOCOL_FEE_WEI";
}

// Rule: A6 snapshot -- after a successful commit(), the stored feePaid and
// collateralLocked exactly reflect the values supplied at commit time, which
// (by the mismatch rules above) equal the live offer values at commit time.
// This is the snap-at-commit property that makes subsequent offer changes
// powerless to alter an already-recorded commit.
rule T9_commit_snapshots_offer_terms(
    uint256 quoteId,
    bytes32 userOpHash,
    address suppliedBundler,
    uint96  suppliedCollateral,
    uint32  slaBlocks
) {
    env e;

    uint256 cid = nextCommitId();

    // Preconditions for a valid commit() call:
    // 1. Caller must not be the bundler (SelfCommitForbidden guard)
    require e.msg.sender != suppliedBundler;
    // 2. feePerOp must fit in uint96 (QuoteRegistry.register enforces this at offer time;
    //    Certora havoces registry state so we need it explicitly to avoid spurious CEX)
    QuoteRegistry.Offer offer = registry.getOffer(quoteId);
    require to_mathint(offer.feePerOp) <= max_uint96;

    // Call commit (no @withrevert -- we only reason about the success case).
    commit(e, quoteId, userOpHash, suppliedBundler, suppliedCollateral, slaBlocks);

    // Read back the snapshotted commit.
    address user; uint96 storedFeePaid; address storedBundler;
    uint96 storedCollateral; uint64 deadline; bool settled; bool refunded;
    uint256 storedQuoteId; bytes32 storedUserOpHash; uint64 inclusionBlock;
    bool storedAccepted; bool storedCancelled; uint64 storedAcceptDeadline; uint32 storedSlaBlocks;

    user, storedFeePaid, storedBundler, storedCollateral, deadline, settled, refunded
        = getCommitCore(cid);
    storedQuoteId, storedUserOpHash, inclusionBlock,
        storedAccepted, storedCancelled, storedAcceptDeadline, storedSlaBlocks = getCommitState(cid);

    // Stored bundler = supplied bundler (which equals offer.bundler via the check above).
    assert storedBundler == suppliedBundler,
        "T9: Commit.bundler must snapshot the supplied (and verified) bundler";

    // Stored collateral = supplied collateral (which equals offer.collateralWei).
    assert to_mathint(storedCollateral) == to_mathint(suppliedCollateral),
        "T9: Commit.collateralLocked must snapshot the supplied (and verified) collateral";

    // Stored quoteId = supplied quoteId.
    assert storedQuoteId == quoteId,
        "T9: Commit.quoteId must snapshot the supplied quoteId";

    // Stored userOpHash = supplied userOpHash.
    assert storedUserOpHash == userOpHash,
        "T9: Commit.userOpHash must snapshot the supplied userOpHash";

    // feePaid = msg.value - PROTOCOL_FEE_WEI, which (by WrongFee check) equals offer.feePerOp.
    assert to_mathint(storedFeePaid)
         == to_mathint(e.msg.value) - to_mathint(protocolFeeWei()),
        "T9: Commit.feePaid must snapshot msg.value - PROTOCOL_FEE_WEI (== offer.feePerOp)";
}
