// docs/DESIGN.md A6 -- Admin actions cannot mutate open commit records.
//
// "A6/T22: open commitments are safe -- every parameter is snapshotted into the
//  Commit struct at commit() time and never re-read. Admin functions cannot alter
//  the terms or state of any existing commitment."
//
// SLAEscrow admin functions: setProtocolFeeWei, setFeeRecipient, setRegistry,
// freezeRegistry, freezeCommits. This spec covers four of the five:
// setProtocolFeeWei, setFeeRecipient, freezeRegistry, freezeCommits.
// setRegistry is covered by T22_registry_freeze (R1_setRegistry_doesNotChangeCommit)
// and NOT duplicated here. Together the two specs close A6 completely.
//
// Each rule: given an arbitrary commitId, the named admin call does not change
// any of the 14 fields of commits[commitId].
//
// Pattern follows T22_registry_freeze R1 (same 14-field before/after comparison).
//
// Theorem: A6 (also T22)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function owner() external returns (address) envfree;
    function registryFrozen() external returns (bool) envfree;
    function commitsFrozen() external returns (bool) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;
}

// Rule: setProtocolFeeWei does not change any field of any existing commit.
// A6: feePaid in open commits is snapshotted at commit() and never re-read.
rule A6_setProtocolFeeWei_doesNotChangeCommit(uint256 commitId, uint256 newFee) {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;
    quoteId, userOpHash, inclusionBlock, accepted, cancelled, acceptDeadline, slaBlocks
        = getCommitState(commitId);

    setProtocolFeeWei(e, newFee);

    address user2; uint96 feePaid2; address bundler2; uint96 collateralLocked2;
    uint64 deadline2; bool settled2; bool refunded2;
    user2, feePaid2, bundler2, collateralLocked2, deadline2, settled2, refunded2
        = getCommitCore(commitId);
    uint256 quoteId2; bytes32 userOpHash2; uint64 inclusionBlock2;
    bool accepted2; bool cancelled2; uint64 acceptDeadline2; uint32 slaBlocks2;
    quoteId2, userOpHash2, inclusionBlock2, accepted2, cancelled2, acceptDeadline2, slaBlocks2
        = getCommitState(commitId);

    assert user             == user2,             "A6: setProtocolFeeWei must not change user";
    assert feePaid          == feePaid2,          "A6: setProtocolFeeWei must not change feePaid";
    assert bundler          == bundler2,          "A6: setProtocolFeeWei must not change bundler";
    assert collateralLocked == collateralLocked2, "A6: setProtocolFeeWei must not change collateralLocked";
    assert deadline         == deadline2,         "A6: setProtocolFeeWei must not change deadline";
    assert settled          == settled2,          "A6: setProtocolFeeWei must not change settled";
    assert refunded         == refunded2,         "A6: setProtocolFeeWei must not change refunded";
    assert quoteId          == quoteId2,          "A6: setProtocolFeeWei must not change quoteId";
    assert userOpHash       == userOpHash2,       "A6: setProtocolFeeWei must not change userOpHash";
    assert inclusionBlock   == inclusionBlock2,   "A6: setProtocolFeeWei must not change inclusionBlock";
    assert accepted         == accepted2,         "A6: setProtocolFeeWei must not change accepted";
    assert cancelled        == cancelled2,        "A6: setProtocolFeeWei must not change cancelled";
    assert acceptDeadline   == acceptDeadline2,   "A6: setProtocolFeeWei must not change acceptDeadline";
    assert slaBlocks        == slaBlocks2,        "A6: setProtocolFeeWei must not change slaBlocks";
}

// Rule: setFeeRecipient does not change any field of any existing commit.
rule A6_setFeeRecipient_doesNotChangeCommit(uint256 commitId, address newRecipient) {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;
    require newRecipient != 0;
    require newRecipient != escrow;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;
    quoteId, userOpHash, inclusionBlock, accepted, cancelled, acceptDeadline, slaBlocks
        = getCommitState(commitId);

    setFeeRecipient(e, newRecipient);

    address user2; uint96 feePaid2; address bundler2; uint96 collateralLocked2;
    uint64 deadline2; bool settled2; bool refunded2;
    user2, feePaid2, bundler2, collateralLocked2, deadline2, settled2, refunded2
        = getCommitCore(commitId);
    uint256 quoteId2; bytes32 userOpHash2; uint64 inclusionBlock2;
    bool accepted2; bool cancelled2; uint64 acceptDeadline2; uint32 slaBlocks2;
    quoteId2, userOpHash2, inclusionBlock2, accepted2, cancelled2, acceptDeadline2, slaBlocks2
        = getCommitState(commitId);

    assert user             == user2,             "A6: setFeeRecipient must not change user";
    assert feePaid          == feePaid2,          "A6: setFeeRecipient must not change feePaid";
    assert bundler          == bundler2,          "A6: setFeeRecipient must not change bundler";
    assert collateralLocked == collateralLocked2, "A6: setFeeRecipient must not change collateralLocked";
    assert deadline         == deadline2,         "A6: setFeeRecipient must not change deadline";
    assert settled          == settled2,          "A6: setFeeRecipient must not change settled";
    assert refunded         == refunded2,         "A6: setFeeRecipient must not change refunded";
    assert quoteId          == quoteId2,          "A6: setFeeRecipient must not change quoteId";
    assert userOpHash       == userOpHash2,       "A6: setFeeRecipient must not change userOpHash";
    assert inclusionBlock   == inclusionBlock2,   "A6: setFeeRecipient must not change inclusionBlock";
    assert accepted         == accepted2,         "A6: setFeeRecipient must not change accepted";
    assert cancelled        == cancelled2,        "A6: setFeeRecipient must not change cancelled";
    assert acceptDeadline   == acceptDeadline2,   "A6: setFeeRecipient must not change acceptDeadline";
    assert slaBlocks        == slaBlocks2,        "A6: setFeeRecipient must not change slaBlocks";
}

// Rule: freezeRegistry() does not change any field of any existing commit.
rule A6_freezeRegistry_doesNotChangeCommit(uint256 commitId) {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;
    require !registryFrozen(); // avoid RegistryFrozen revert (already frozen case)

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;
    quoteId, userOpHash, inclusionBlock, accepted, cancelled, acceptDeadline, slaBlocks
        = getCommitState(commitId);

    freezeRegistry(e);

    address user2; uint96 feePaid2; address bundler2; uint96 collateralLocked2;
    uint64 deadline2; bool settled2; bool refunded2;
    user2, feePaid2, bundler2, collateralLocked2, deadline2, settled2, refunded2
        = getCommitCore(commitId);
    uint256 quoteId2; bytes32 userOpHash2; uint64 inclusionBlock2;
    bool accepted2; bool cancelled2; uint64 acceptDeadline2; uint32 slaBlocks2;
    quoteId2, userOpHash2, inclusionBlock2, accepted2, cancelled2, acceptDeadline2, slaBlocks2
        = getCommitState(commitId);

    assert user             == user2,             "A6: freezeRegistry must not change user";
    assert feePaid          == feePaid2,          "A6: freezeRegistry must not change feePaid";
    assert bundler          == bundler2,          "A6: freezeRegistry must not change bundler";
    assert collateralLocked == collateralLocked2, "A6: freezeRegistry must not change collateralLocked";
    assert deadline         == deadline2,         "A6: freezeRegistry must not change deadline";
    assert settled          == settled2,          "A6: freezeRegistry must not change settled";
    assert refunded         == refunded2,         "A6: freezeRegistry must not change refunded";
    assert quoteId          == quoteId2,          "A6: freezeRegistry must not change quoteId";
    assert userOpHash       == userOpHash2,       "A6: freezeRegistry must not change userOpHash";
    assert inclusionBlock   == inclusionBlock2,   "A6: freezeRegistry must not change inclusionBlock";
    assert accepted         == accepted2,         "A6: freezeRegistry must not change accepted";
    assert cancelled        == cancelled2,        "A6: freezeRegistry must not change cancelled";
    assert acceptDeadline   == acceptDeadline2,   "A6: freezeRegistry must not change acceptDeadline";
    assert slaBlocks        == slaBlocks2,        "A6: freezeRegistry must not change slaBlocks";
}

// Rule: freezeCommits() does not change any field of any existing commit.
rule A6_freezeCommits_doesNotChangeCommit(uint256 commitId) {
    env e;
    require e.msg.sender == owner();
    require e.msg.value == 0;
    require !commitsFrozen(); // avoid CommitsFrozen revert (already frozen case)

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;
    quoteId, userOpHash, inclusionBlock, accepted, cancelled, acceptDeadline, slaBlocks
        = getCommitState(commitId);

    freezeCommits(e);

    address user2; uint96 feePaid2; address bundler2; uint96 collateralLocked2;
    uint64 deadline2; bool settled2; bool refunded2;
    user2, feePaid2, bundler2, collateralLocked2, deadline2, settled2, refunded2
        = getCommitCore(commitId);
    uint256 quoteId2; bytes32 userOpHash2; uint64 inclusionBlock2;
    bool accepted2; bool cancelled2; uint64 acceptDeadline2; uint32 slaBlocks2;
    quoteId2, userOpHash2, inclusionBlock2, accepted2, cancelled2, acceptDeadline2, slaBlocks2
        = getCommitState(commitId);

    assert user             == user2,             "A6: freezeCommits must not change user";
    assert feePaid          == feePaid2,          "A6: freezeCommits must not change feePaid";
    assert bundler          == bundler2,          "A6: freezeCommits must not change bundler";
    assert collateralLocked == collateralLocked2, "A6: freezeCommits must not change collateralLocked";
    assert deadline         == deadline2,         "A6: freezeCommits must not change deadline";
    assert settled          == settled2,          "A6: freezeCommits must not change settled";
    assert refunded         == refunded2,         "A6: freezeCommits must not change refunded";
    assert quoteId          == quoteId2,          "A6: freezeCommits must not change quoteId";
    assert userOpHash       == userOpHash2,       "A6: freezeCommits must not change userOpHash";
    assert inclusionBlock   == inclusionBlock2,   "A6: freezeCommits must not change inclusionBlock";
    assert accepted         == accepted2,         "A6: freezeCommits must not change accepted";
    assert cancelled        == cancelled2,        "A6: freezeCommits must not change cancelled";
    assert acceptDeadline   == acceptDeadline2,   "A6: freezeCommits must not change acceptDeadline";
    assert slaBlocks        == slaBlocks2,        "A6: freezeCommits must not change slaBlocks";
}
