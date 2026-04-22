// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ERC-4337 v0.6 UserOperation struct -- must match EP selector exactly.
struct UserOperation {
    address  sender;
    uint256  nonce;
    bytes    initCode;
    bytes    callData;
    uint256  callGasLimit;
    uint256  verificationGasLimit;
    uint256  preVerificationGas;
    uint256  maxFeePerGas;
    uint256  maxPriorityFeePerGas;
    bytes    paymasterAndData;
    bytes    signature;
}

/// @notice Simulates an ERC-4337 v0.6 smart contract wallet for testnet demos.
///         Stands in for a real dapp account (e.g. Safe, Kernel) -- the bundler calls
///         handleOps() with this as the sender, the EntryPoint emits UserOperationEvent,
///         and SLAEscrow.settle() verifies inclusion against that event via MPT proof.
///         Always validates (no signature check). Pre-fund via depositTo() on the
///         EntryPoint before calling handleOps -- missingAccountFunds will be 0.
contract MinimalAccount {
    address public immutable entryPoint;

    constructor(address _entryPoint) {
        entryPoint = _entryPoint;
    }

    receive() external payable {}

    function validateUserOp(
        UserOperation calldata,
        bytes32,
        uint256 missingAccountFunds
    ) external returns (uint256) {
        if (missingAccountFunds > 0) {
            // Send missing prefund directly to the EntryPoint deposit slot.
            (bool ok,) = payable(entryPoint).call{value: missingAccountFunds}(
                abi.encodeWithSignature("depositTo(address)", address(this))
            );
            require(ok, "prefund");
        }
        return 0; // SIG_VALIDATION_SUCCESS
    }
}
