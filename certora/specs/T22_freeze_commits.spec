// docs/DESIGN.md T22 -- freezeCommits() is a one-way ratchet; commit() reverts when frozen.
//
// "Governance calls freezeCommits() before queuing any layout-changing upgrade
//  so no new PROPOSED commits straddle the upgrade boundary. Irreversible once set."
//
// Five claims:
//   F1. Owner can set commitsFrozen from false to true (positive path).
//   F2. Non-owner cannot freeze commits (reverts with OwnableUnauthorizedAccount).
//   F3. Once commitsFrozen is true, no SLAEscrow function can clear it
//       (except upgradeToAndCall, the UUPS governance escape hatch).
//   F4. When commitsFrozen == true, commit() always reverts with CommitsFrozen.
//   F5. freezeCommits() reverts if already frozen (double-call blocked).
//
// Scope: SLAEscrow only (no QuoteRegistry interaction in any of these paths).
// rule_sanity: none -- F3 is parametric; with commitsFrozen=true, commit() always reverts
// (design intent), making the F3 assertion vacuously true for the commit() variant.
// This is expected and correct, not a proof weakness. Mirrors T22_registry_freeze.conf.
//
// Theorem: T22 (commitsFrozen variant; cf. T22_registry_freeze for registryFrozen)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function commitsFrozen() external returns (bool) envfree;
    function owner() external returns (address) envfree;

    // settle() hashes variable-length arrays. NONDET for _verifyReceiptProof so the
    // parametric F3 rule can enumerate settle() without hitting unbounded-hashing errors.
    // NONDET does NOT write commitsFrozen, so it cannot create a clearance path -- F3 is sound.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// F1 -- owner can freeze commits (positive path confirms the flag is reachable).
rule F1_owner_can_freeze_commits() {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;
    require !commitsFrozen();

    freezeCommits(e);

    assert commitsFrozen(),
        "F1: commitsFrozen must be true after owner calls freezeCommits()";
}

// F2 -- non-owner cannot freeze commits.
rule F2_non_owner_cannot_freeze_commits() {
    env e;
    require e.msg.sender != owner();

    freezeCommits@withrevert(e);

    assert lastReverted,
        "F2: freezeCommits must revert for any caller who is not owner";
}

// F3 -- once commitsFrozen is true, no SLAEscrow function can clear it.
//
//      upgradeToAndCall excluded: delegatecall executes arbitrary logic and can write
//      any storage slot. This is the governance escape hatch, protected at the protocol
//      layer (48h TimelockController) -- same rationale as R4_frozen_stays_frozen in
//      T22_registry_freeze.spec.
rule F3_commits_frozen_stays_frozen(method f, calldataarg args)
    filtered {
        f -> f.contract == escrow
          && f.selector != sig:upgradeToAndCall(address,bytes).selector
    }
{
    env e;
    require commitsFrozen();

    f(e, args);

    assert commitsFrozen(),
        "F3: no SLAEscrow function (except upgradeToAndCall) may unset commitsFrozen once true";
}

// F4 -- when commitsFrozen, commit() always reverts (CommitsFrozen check is first in commit()).
rule F4_frozen_blocks_all_commits(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;
    require commitsFrozen();

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "F4: commit() must always revert when commitsFrozen is true";
}

// F5 -- freezeCommits() reverts if already frozen (idempotency guard on-chain).
rule F5_freeze_commits_reverts_when_already_frozen() {
    env e;
    require commitsFrozen();

    freezeCommits@withrevert(e);

    assert lastReverted,
        "F5: freezeCommits must revert if commitsFrozen is already true";
}
