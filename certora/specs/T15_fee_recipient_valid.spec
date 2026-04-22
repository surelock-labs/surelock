// docs/DESIGN.md T15 -- OWNER cannot block settlement.
//
// setFeeRecipient(address(this)) would trap all platform fees inside the
// escrow's own pendingWithdrawals mapping, making them permanently
// unclaimable (no one can call claimPayout as the escrow contract).
// setFeeRecipient(address(0)) would revert on every payout attempt.
// Both must be rejected.
//
// Theorem: T15 (also touches A8)
// Contract: SLAEscrow
// Status: PASS (both guards are implemented)

using SLAEscrow as escrow;

methods {
    // setFeeRecipient declaration removed 2026-04-15: no envfree/optional/summary
    // makes it a no-op warning. Rules call it directly via @withrevert / direct call.
    function feeRecipient() external returns (address) envfree;
    function owner() external returns (address) envfree;
}

// Rule: setFeeRecipient(address(this)) must revert.
rule T15_fee_recipient_cannot_be_self() {
    env e;
    require e.msg.sender == owner();

    setFeeRecipient@withrevert(e, currentContract);

    assert lastReverted,
        "T15: setFeeRecipient(address(this)) must revert";
}

// Rule: setFeeRecipient(address(0)) must revert.
rule T15_fee_recipient_cannot_be_zero() {
    env e;
    require e.msg.sender == owner();

    setFeeRecipient@withrevert(e, 0);

    assert lastReverted,
        "T15: setFeeRecipient(address(0)) must revert";
}

// Rule: setFeeRecipient with a valid address succeeds and updates state.
rule T15_fee_recipient_valid_address_succeeds(address newRecipient) {
    env e;
    require e.msg.sender == owner();
    require newRecipient != 0;
    require newRecipient != currentContract;

    setFeeRecipient(e, newRecipient);

    assert feeRecipient() == newRecipient,
        "T15: feeRecipient must update to valid address";
}
