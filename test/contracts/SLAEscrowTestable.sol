// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/SLAEscrow.sol";

/// @dev Test-only variant of SLAEscrow. Production logic is unchanged -- this
///      contract exists only to:
///        1. Allow deployment without a real EntryPoint address.
///        2. Expose settle(uint256 commitId) -- a 1-arg overload that skips the MPT
///           proof check, so business-logic tests don't need to construct real proofs.
///      The production settle(commitId, inclusionBlock, ...) is still available and
///      fully functional via the proof integration tests.
///      NEVER deploy on mainnet.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract SLAEscrowTestable is SLAEscrow {
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor() SLAEscrow(address(1)) {}

    /// @dev Test convenience: settle without building an MPT proof.
    ///      Calls _settle() directly, bypassing _verifyReceiptProof().
    function settle(uint256 commitId) external {
        _settle(commitId);
    }

    /// @dev Skip the T22 upgrade-precondition check in tests so that upgrade
    ///      functional tests (state preservation, anti-rug, etc.) don't need the
    ///      full freeze + elapsed-window ceremony. Dedicated precondition tests in
    ///      proxy-upgrade.test.ts exercise the production path directly.
    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
