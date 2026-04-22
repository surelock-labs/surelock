// docs/DESIGN.md T22 -- renounceOwnership() must always revert on QuoteRegistry.
//
// Same theorem as T22_renounce_disabled.spec but targeting QuoteRegistry.
// Both contracts must independently disable renounceOwnership().
//
// Theorem: T22
// Contract: QuoteRegistry
// Status: PASS (override is implemented)

using QuoteRegistry as registry;

methods {
    // renounceOwnership declaration removed 2026-04-15: no-op warning.
    // Rules call it via @withrevert and CVL resolves directly from bytecode.
    function owner() external returns (address) envfree;
}

// Rule: renounceOwnership always reverts for any caller on QuoteRegistry.
rule T22_registry_renounce_reverts_for_anyone() {
    env e;

    renounceOwnership@withrevert(e);

    assert lastReverted,
        "T22: renounceOwnership on QuoteRegistry must revert for any caller";
}
