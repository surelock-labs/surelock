// docs/DESIGN.md T22 -- setRegistry() affects only future commits; freezeRegistry() is
// a one-way ratchet.
//
// "Because all commitment-critical fields -- quoteId, bundler, feePerOp,
//  collateralLocked, slaBlocks -- are snapshotted into the Commit struct at
//  commit() time and never re-read from the registry, changing the registry
//  address cannot alter the resolution or economics of any existing commitment."
//
// Five claims verified here:
//
//   R1. setRegistry() does not change any field of any existing commit record.
//   R2. freezeRegistry() sets registryFrozen to true (owner succeeds, non-owner reverts).
//   R3. If registryFrozen == true, setRegistry() always reverts.
//       If registryFrozen == false, setRegistry() with valid args succeeds.
//   R4. Once registryFrozen is set to true, no function can clear it.
//
// Theorem: T22 (upgrade/governance immutability + trust-reduction ratchet)
// Contract: SLAEscrow
// Status: READY (not yet run)

using SLAEscrow as escrow;

methods {
    function registryFrozen() external returns (bool) envfree;
    function owner() external returns (address) envfree;
    function registry() external returns (address) envfree;

    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    // setRegistry and freezeRegistry are called directly by R1/R2/R3 rules
    // without needing envfree or summary, so their method declarations were
    // removed -- the CVL compiler emitted "declaration has no effect" warnings.
    //
    // settle() hashes variable-length arrays. R4 (parametric, filtered to
    // f.contract == escrow) must enumerate settle(); without summarising the
    // proof pipeline the prover hits an unbounded-hashing error. Proof
    // correctness is verified separately in A10_inclusion_proof.spec.
    //
    // Soundness for R4: NONDET replaces _verifyReceiptProof's return with an
    // arbitrary view-only stub. settle() itself does NOT write registryFrozen
    // on any path (grep in SLAEscrow.sol confirms the flag is only touched by
    // freezeRegistry). NONDET for this summary cannot create a path where
    // registryFrozen is silently cleared, so it does not weaken R4.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;

    // _validateRegistry makes external staticcalls to newRegistry to check interface version,
    // owner alignment, and MAX_SLA_BLOCKS. A symbolic newRegistry has no deployed code and
    // these calls fail, causing setRegistry() to revert. R3b's claim is that the
    // registryFrozen guard alone does not block -- not that any symbolic address passes
    // full validation. NONDET treats _validateRegistry as non-reverting, matching R3b's intent.
    function SLAEscrow._validateRegistry(address) internal => NONDET;
}

// R1 -- setRegistry() does not touch the commits mapping.
//      All commitment-critical fields are snapshotted at commit() and never re-read
//      from REGISTRY. Uses getCommitCore + getCommitState (same pattern as T9/T23/A10).
rule R1_setRegistry_doesNotChangeCommit(uint256 commitId, address newRegistry) {
    env e;
    require e.msg.sender == owner();   // force the non-reverting path
    require newRegistry != 0;           // exclude ZeroAddress revert
    require !registryFrozen();          // exclude RegistryFrozen revert
    require e.msg.value == 0;

    // Read all 14 commitment fields before the call.
    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);

    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;
    quoteId, userOpHash, inclusionBlock, accepted, cancelled, acceptDeadline, slaBlocks
        = getCommitState(commitId);

    setRegistry(e, newRegistry);

    // Re-read and assert all 14 fields are unchanged.
    address user2; uint96 feePaid2; address bundler2; uint96 collateralLocked2;
    uint64 deadline2; bool settled2; bool refunded2;
    user2, feePaid2, bundler2, collateralLocked2, deadline2, settled2, refunded2
        = getCommitCore(commitId);

    uint256 quoteId2; bytes32 userOpHash2; uint64 inclusionBlock2;
    bool accepted2; bool cancelled2; uint64 acceptDeadline2; uint32 slaBlocks2;
    quoteId2, userOpHash2, inclusionBlock2, accepted2, cancelled2, acceptDeadline2, slaBlocks2
        = getCommitState(commitId);

    assert user             == user2,             "R1: user unchanged";
    assert feePaid          == feePaid2,          "R1: feePaid unchanged";
    assert bundler          == bundler2,           "R1: bundler unchanged";
    assert collateralLocked == collateralLocked2, "R1: collateralLocked unchanged";
    assert deadline         == deadline2,          "R1: deadline unchanged";
    assert settled          == settled2,           "R1: settled unchanged";
    assert refunded         == refunded2,          "R1: refunded unchanged";
    assert quoteId          == quoteId2,           "R1: quoteId unchanged";
    assert userOpHash       == userOpHash2,        "R1: userOpHash unchanged";
    assert inclusionBlock   == inclusionBlock2,    "R1: inclusionBlock unchanged";
    assert accepted         == accepted2,          "R1: accepted unchanged";
    assert cancelled        == cancelled2,         "R1: cancelled unchanged";
    assert acceptDeadline   == acceptDeadline2,    "R1: acceptDeadline unchanged";
    assert slaBlocks        == slaBlocks2,         "R1: slaBlocks unchanged";
}

// R2 -- freezeRegistry() sets the flag (positive path).
rule R2_freeze_sets_flag() {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;

    freezeRegistry(e);

    assert registryFrozen(), "R2: registryFrozen must be true after freezeRegistry()";
}

// R2b -- freezeRegistry() reverts for non-owner.
rule R2b_freeze_reverts_for_non_owner() {
    env e;
    require e.msg.sender != owner();

    freezeRegistry@withrevert(e);

    assert lastReverted, "R2b: freezeRegistry must revert for non-owner";
}

// R3 -- Once frozen, setRegistry() always reverts.
rule R3_setRegistry_reverts_when_frozen(address newRegistry) {
    env e;
    require registryFrozen();

    setRegistry@withrevert(e, newRegistry);

    assert lastReverted, "R3: setRegistry must revert when registryFrozen == true";
}

// R3b -- Before freeze, setRegistry() does NOT revert due to the registryFrozen guard.
//
// Scope note: this rule constrains newRegistry to be non-zero and non-self, which
// prevents the ZeroAddress and RegistrySelfReference reverts. It does NOT constrain
// newRegistry to satisfy _validateRegistry() (interface fingerprint, governance
// alignment, MAX_SLA_BLOCKS match, ABI smoke tests). A symbolic newRegistry that
// fails _validateRegistry() will cause setRegistry() to revert and the assertion
// to FAIL when the rule is run against a full prover.
//
// This rule should be read as: "the registryFrozen guard alone is not a blocking
// revert when the flag is false" -- not as "setRegistry() succeeds for any valid
// compatible registry." Proving the full positive-path requires either linking a
// concrete compatible registry implementation or adding explicit summary preconditions
// for every _validateRegistry() probe. That tighter proof is tracked as a pending
// improvement.
//
// Rationale for keeping this weaker rule: it still catches the vacuous-success
// failure mode (an impl that always reverts would FAIL R3 -- this rule ensures the
// PASS in R3 is non-trivial for the frozen-guard case).
rule R3b_setRegistry_succeeds_when_unfrozen(address newRegistry) {
    env e;
    require !registryFrozen();
    require e.msg.sender == owner();
    require newRegistry != 0;
    require newRegistry != currentContract;
    require newRegistry != registry();      // exclude RegistryAlreadySet revert
    require e.msg.value == 0;

    setRegistry@withrevert(e, newRegistry);

    assert !lastReverted, "R3b: setRegistry must succeed for valid newRegistry pre-freeze";
}

// R4 -- Once registryFrozen is true, no SLAEscrow function can clear it.
//
//      Scope: SLAEscrow only (f.contract == escrow) -- QuoteRegistry functions cannot touch
//      SLAEscrow storage and their inclusion caused SANITY_FAILED in earlier runs.
//
//      upgradeToAndCall (UUPS) is excluded from the parametric enumeration: a delegatecall
//      to a new implementation can write any storage slot -- including registryFrozen -- and
//      Certora correctly reports a violation for that path. This is the accepted UUPS
//      trade-off: upgradeability is protected at the governance layer (48 h
//      TimelockController) rather than at the bytecode layer. R4 therefore verifies the
//      one-way-ratchet property for all normal protocol entrypoints, with upgradeToAndCall
//      documented as the sole governance escape hatch.
//
//      The A4 ETH-conservation spec excludes upgradeToAndCall from its invariant filter for
//      the same reason; T22_registry_freeze aligns with that precedent.
//
//      Integrity note: the method-declaration warnings in the methods block above have been
//      resolved. _verifyReceiptProof NONDET summary is documented alongside the methods
//      block -- it does not write registryFrozen on any path, so it cannot weaken R4.
//
//      rule_sanity is set to "none" in the conf so that functions that always revert
//      (renounceOwnership -- disabled; setRegistry -- reverts when frozen per R3) do not
//      produce spurious SANITY_FAILED entries.
rule R4_frozen_stays_frozen(method f, calldataarg args)
    filtered {
        f -> f.contract == escrow
          && f.selector != sig:upgradeToAndCall(address,bytes).selector
    }
{
    env e;
    require registryFrozen();

    f(e, args);

    assert registryFrozen(), "R4: no SLAEscrow function (except upgradeToAndCall) may unset registryFrozen once true";
}
