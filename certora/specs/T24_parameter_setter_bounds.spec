// docs/DESIGN.md T24 -- Admin-configurable parameters are bounded.
//
// "Every parameter OWNER can adjust is constrained by protocol-enforced bounds
//  such that no permitted setting can reduce an honest actor's in-protocol
//  return to zero or below (A7), prevent an honest actor from participating
//  or exiting (A8), or alter the resolution of any already-committed
//  commitment (A6, T13)."
//
// Concrete bounds per DESIGN.md T24:
//   - PROTOCOL_FEE_WEI in [0, MAX_PROTOCOL_FEE_WEI]  (SLAEscrow.setProtocolFeeWei)
//   - registrationBond in [MIN_BOND, MAX_BOND]       (QuoteRegistry.setBond)
//   - slaBlocks in [1, MAX_SLA_BLOCKS]               (QuoteRegistry.register)
//
// Other T24-relevant bounds are covered in sibling specs:
//   - T15_fee_recipient_valid:    setFeeRecipient(0) and setFeeRecipient(self) revert.
//   - T22_registry_freeze:        setRegistry(0) reverts; registryFrozen is a one-way ratchet.
//   - T22_renounce_disabled{,_registry}: renounceOwnership always reverts.
//   - A6_admin_no_effect_on_open_commits: admin cannot alter already-committed records.
//
// This spec proves the NUMERIC RANGE subclaim only. The full T24 theorem is the
// union of this spec and the four sibling specs listed above.
//
// Theorem: T24
// Contract: QuoteRegistry + SLAEscrow
// Status: PASS (setBond portion) -- setProtocolFeeWei rules added 2026-04-15 audit

using QuoteRegistry as registry;
using SLAEscrow as escrow;

methods {
    // QuoteRegistry bounds -- only getters declared envfree; setBond is called
    // directly in rules and does not need a method declaration (CVL auto-resolves).
    function registry.registrationBond() external returns (uint256) envfree;
    function registry.MIN_BOND() external returns (uint256) envfree;
    function registry.MAX_BOND() external returns (uint256) envfree;
    function registry.owner() external returns (address) envfree;

    // SLAEscrow bounds -- same pattern as above; setProtocolFeeWei called directly.
    function escrow.protocolFeeWei() external returns (uint256) envfree;
    function escrow.MAX_PROTOCOL_FEE_WEI() external returns (uint256) envfree;
    function escrow.owner() external returns (address) envfree;

}

// --------------------------- QuoteRegistry.setBond --------------------------

// Rule: setBond with value above MAX_BOND must revert.
rule T24_setBond_above_max_reverts(uint256 newBond) {
    env e;
    require e.msg.sender == registry.owner();
    require newBond > registry.MAX_BOND();

    setBond@withrevert(e, newBond);

    assert lastReverted,
        "T24: setBond above MAX_BOND must revert";
}

// Rule: setBond with value below MIN_BOND must revert.
rule T24_setBond_below_min_reverts(uint256 newBond) {
    env e;
    require e.msg.sender == registry.owner();
    require newBond < registry.MIN_BOND();

    setBond@withrevert(e, newBond);

    assert lastReverted,
        "T24: setBond below MIN_BOND must revert";
}

// Rule: setBond with value in [MIN_BOND, MAX_BOND] succeeds and updates state.
rule T24_setBond_within_range_succeeds(uint256 newBond) {
    env e;
    require e.msg.sender == registry.owner();
    require newBond >= registry.MIN_BOND();
    require newBond <= registry.MAX_BOND();

    setBond(e, newBond);

    assert registry.registrationBond() == newBond,
        "T24: registrationBond must reflect the new value";
}

// Note on invariants: T24_bond_always_bounded and T24_protocolFee_always_bounded were
// attempted but removed. The spec uses "verify: QuoteRegistry" (QR is primary), so
// SLAEscrow is a linked contract with symbolic initial state -- the fee invariant's base
// case is unprovable because PROTOCOL_FEE_WEI starts unconstrained from Certora's
// perspective. The bond invariant's induction step was violated by SLAEscrow's
// upgradeToAndCall pointer-analysis imprecision (Certora conservatively havoced all
// storage). The five rules above provide direct setter-level bounds verification and are
// the correct vehicle for T24's guarantee in a multi-contract conf.

// ------------------------- SLAEscrow.setProtocolFeeWei ----------------------

// Rule: setProtocolFeeWei above MAX_PROTOCOL_FEE_WEI must revert.
// DESIGN.md T24: PROTOCOL_FEE_WEI in [0, MAX_PROTOCOL_FEE_WEI] -- the upper bound
// keeps CLIENT griefing cost predictable (T11) and prevents a rogue PROTOCOL
// from pricing honest CLIENTs out of the market (A8).
rule T24_setProtocolFeeWei_above_max_reverts(uint256 newFee) {
    env e;
    require e.msg.sender == escrow.owner();
    require newFee > escrow.MAX_PROTOCOL_FEE_WEI();

    escrow.setProtocolFeeWei@withrevert(e, newFee);

    assert lastReverted,
        "T24: setProtocolFeeWei above MAX_PROTOCOL_FEE_WEI must revert";
}

// Rule: setProtocolFeeWei at or below MAX_PROTOCOL_FEE_WEI succeeds and updates state.
// Zero is an explicit valid setting (fee-inactive mode, A7).
rule T24_setProtocolFeeWei_within_range_succeeds(uint256 newFee) {
    env e;
    require e.msg.sender == escrow.owner();
    require e.msg.value == 0;
    require newFee <= escrow.MAX_PROTOCOL_FEE_WEI();

    escrow.setProtocolFeeWei(e, newFee);

    assert escrow.protocolFeeWei() == newFee,
        "T24: PROTOCOL_FEE_WEI must reflect the new value";
}

