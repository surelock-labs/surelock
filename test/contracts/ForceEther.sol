// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Force-sends ETH to any address via selfdestruct, bypassing receive().
///      Used in tests to simulate unexpected ETH sent to SLAEscrow.
///      Post-Dencun, selfdestruct no longer deletes code, but ETH transfer still works
///      when the contract is deployed and selfdestructed in the same transaction.
contract ForceEther {
    constructor() payable {}

    function destroy(address payable target) external {
        selfdestruct(target);
    }
}
