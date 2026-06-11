// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.35;

interface ISLAEscrow {
    function cancel(uint256 commitId) external;
    function settle(uint256 commitId, uint256 inclusionBlock) external;
    function refund(uint256 commitId) external;
}
