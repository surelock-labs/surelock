// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal EntryPoint stub that emits the ERC-4337 UserOperationEvent.
///         Used in settle() integration tests to produce real on-chain receipts.
///         topic0 = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
///                = 0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f
contract MockEntryPoint {
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool    success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );

    /// @notice Emit a UserOperationEvent for `userOpHash`. Call this inside a
    ///         transaction so the receipt ends up in a real mined block.
    function handleOp(bytes32 userOpHash) external {
        emit UserOperationEvent(
            userOpHash,
            address(0), // sender  (not checked by SLAEscrow)
            address(0), // paymaster (not checked by SLAEscrow)
            0,          // nonce
            true,       // success
            0,          // actualGasCost
            0           // actualGasUsed
        );
    }

    /// @notice Emit a failed UserOperationEvent (success=false). Used to test A1:
    ///         SLAEscrow must reject settle() proofs for reverted UserOps.
    function handleFailedOp(bytes32 userOpHash) external {
        emit UserOperationEvent(
            userOpHash,
            address(0), // sender
            address(0), // paymaster
            0,          // nonce
            false,      // success -- reverted
            0,          // actualGasCost
            0           // actualGasUsed
        );
    }
}
