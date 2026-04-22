// docs/DESIGN.md T22 -- renounceOwnership() must always revert.
//
// "renounceOwnership() must be disabled on both QuoteRegistry and SLAEscrow;
//  calling it would permanently brick all admin functions with no recovery
//  path, which is equivalent to a protocol capture (A8)."
//
// Both contracts override renounceOwnership() to revert with
// RenounceOwnershipDisabled(). This rule verifies the call always reverts
// regardless of caller.
//
// Theorem: T22
// Contract: SLAEscrow (QuoteRegistry verified in a separate conf file)
// Status: PASS (override is implemented)

using SLAEscrow as escrow;

methods {
    // renounceOwnership declaration removed 2026-04-15: no-op warning.
    // Rules call it via @withrevert and CVL resolves directly from bytecode.
    function owner() external returns (address) envfree;
}

// Rule: renounceOwnership always reverts when called by the owner.
rule T22_renounce_reverts_for_owner() {
    env e;
    require e.msg.sender == owner();
    require owner() != 0; // owner exists

    renounceOwnership@withrevert(e);

    assert lastReverted,
        "T22: renounceOwnership must revert even when called by owner";
}

// Rule: renounceOwnership reverts for any caller (non-owner gets
// OwnableUnauthorizedAccount, owner gets RenounceOwnershipDisabled).
rule T22_renounce_reverts_for_anyone() {
    env e;

    renounceOwnership@withrevert(e);

    assert lastReverted,
        "T22: renounceOwnership must revert for any caller";
}
