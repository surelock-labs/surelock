// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test helper: always returns a uint256[] whose length != input length.
///         Used to test QuoteRegistry._batchIdleBalance's length-mismatch guard.
contract BadIdleBalanceBatch {
    function idleBalanceBatch(address[] calldata) external pure returns (uint256[] memory) {
        uint256[] memory result = new uint256[](2); // always 2, regardless of input
        return result;
    }
}
