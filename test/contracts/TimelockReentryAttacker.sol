// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Test helper: re-enters TimelockController.execute() from a target callback.
contract TimelockReentryAttacker {
    TimelockController public immutable timelock;
    address public target;
    uint256 public value;
    bytes   public payload;
    bytes32 public predecessor;
    bytes32 public salt;
    uint256 public reentryCount;
    bool    public reentryAttempted;

    constructor(address _timelock) {
        timelock = TimelockController(payable(_timelock));
    }

    function setParams(
        address newTarget,
        uint256 newValue,
        bytes calldata newPayload,
        bytes32 newPredecessor,
        bytes32 newSalt
    ) external {
        target      = newTarget;
        value       = newValue;
        payload     = newPayload;
        predecessor = newPredecessor;
        salt        = newSalt;
    }

    /// @notice Called by timelock.execute() as the target. Re-enters execute().
    function trigger() external {
        reentryCount++;
        if (reentryCount < 2) {
            reentryAttempted = true;
            // Try to re-enter timelock.execute with the same operation
            try timelock.execute(target, value, payload, predecessor, salt) {
                // Should not succeed -- operation state should prevent it
            } catch {
                // Expected: revert due to operation state
            }
        }
    }
}
