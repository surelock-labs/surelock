// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test helper: a contract whose receive() always reverts.
///      Used to verify that sweepExcess() (pull model) does not revert
///      even when feeRecipient is a reverting contract.
contract RevertingReceiver {
    receive() external payable {
        revert("RevertingReceiver: always reverts");
    }
}
