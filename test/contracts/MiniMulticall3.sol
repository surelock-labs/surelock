// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Multicall3-compatible stub for Hardhat tests; not for mainnet.
contract MiniMulticall3 {
    struct Call3  { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (!ok && !calls[i].allowFailure) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
            returnData[i] = Result({ success: ok, returnData: ret });
        }
    }
}
