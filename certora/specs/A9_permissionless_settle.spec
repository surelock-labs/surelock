// docs/DESIGN.md A9 / T1 -- settle() is permissionless: any caller may submit the
// inclusion proof; the fee is always routed to the snapshotted c.bundler.
//
// "settle() has no caller restriction. A third party (relayer, altruist, automated
//  keeper) may call it. The payout destination is fixed at commit time: c.bundler.
//  The caller receives nothing -- msg.sender is irrelevant to economic outcomes."
//
// This spec proves the PAYOUT ROUTING side of permissionlessness:
// regardless of who calls settle(), the fee always routes to the snapshotted bundler.
// The LIVENESS side (that settle CAN succeed for a third-party) cannot be proved in
// Certora: settle() checks `blockhash(inclusionBlock) != 0` before _verifyReceiptProof,
// and Certora models BLOCKHASH as a fully symbolic bytes32 that can be zero (same
// limitation acknowledged in A10_settle_structural_guards). Liveness is covered by
// Kontrol (testProp_A10_staleBlockhashReverts) and by T19_liveness.
//
// One rule:
//   A9_settle_payout_goes_to_snapshotted_bundler
//       Regardless of caller, pendingWithdrawals[c.bundler] increases by feePaid
//       and pendingWithdrawals[caller] stays unchanged (caller != bundler).
//
// _verifyReceiptProof => NONDET: same rationale as A10. Proof pipeline correctness
// is verified separately; this spec tests the access-control + payout-routing layer.
//
// Theorem: A9 (permissionless settle subclaim), T1
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: a third-party caller (not bundler, not user) can successfully settle a valid
// ACTIVE commit inside the settlement window. Proves settle() has no caller restriction.
// Rule: regardless of who calls settle(), pendingWithdrawals[c.bundler] increases by
// exactly feePaid and the caller's pending (when caller != bundler) is unchanged.
// This is the payout-routing invariant -- bundler address is snapshotted at commit time.
rule A9_settle_payout_goes_to_snapshotted_bundler(
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

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender != bundler; // third-party caller
    require e.msg.value == 0;
    require to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS()) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS());
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(bundler)) + to_mathint(feePaid) <= max_uint256;

    mathint bundlerPendingBefore = to_mathint(pendingWithdrawals(bundler));
    mathint callerPendingBefore  = to_mathint(pendingWithdrawals(e.msg.sender));

    settle(e, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

    assert to_mathint(pendingWithdrawals(bundler)) == bundlerPendingBefore + to_mathint(feePaid),
        "A9: settle() must credit feePaid to c.bundler regardless of caller";
    assert to_mathint(pendingWithdrawals(e.msg.sender)) == callerPendingBefore,
        "A9: settle() must not credit anything to the caller when caller != bundler";
}
