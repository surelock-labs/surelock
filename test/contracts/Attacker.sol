// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test helper: a contract that can toggle whether its receive() reverts.
contract Attacker {
    bool public shouldRevert;
    address public immutable escrow;

    constructor(address _escrow) { escrow = _escrow; }

    function setRevert(bool shouldRevert_) external { shouldRevert = shouldRevert_; }

    receive() external payable {
        if (shouldRevert) revert("Attacker: revert on receive");
    }

    // Proxy functions to interact with escrow as this contract
    function depositToEscrow() external payable {
        (bool ok,) = escrow.call{value: msg.value}(abi.encodeWithSignature("deposit()"));
        require(ok, "deposit failed");
    }

    function withdrawFromEscrow(uint256 amount) external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        require(ok, "withdraw failed");
    }

    function claimPayoutFromEscrow() external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("claimPayout()"));
        require(ok, "claimPayout failed");
    }

    function commitToEscrow(uint256 quoteId, bytes32 userOpHash, uint256 /* _fee */, address bundler, uint96 collateral, uint32 slaBlocks) external payable {
        (bool ok,) = escrow.call{value: msg.value}(abi.encodeWithSignature("commit(uint256,bytes32,address,uint96,uint32)", quoteId, userOpHash, bundler, collateral, slaBlocks));
        require(ok, "commit failed");
    }

    function acceptCommit(uint256 commitId) external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("accept(uint256)", commitId));
        require(ok, "accept failed");
    }

    function settleEscrow(uint256 commitId) external {
        // Use 1-arg settle(uint256) overload on SLAEscrowTestable (no proof required in tests)
        (bool ok,) = escrow.call(abi.encodeWithSelector(
            bytes4(keccak256("settle(uint256)")),
            commitId
        ));
        require(ok, "settle failed");
    }

    function claimRefundFromEscrow(uint256 commitId) external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("claimRefund(uint256)", commitId));
        require(ok, "claimRefund failed");
    }

    function registerOffer(address registry, uint256 maxFee, uint32 slaBlocks, uint256 collateral) external payable returns (uint256) {
        (bool ok, bytes memory data) = registry.call{value: msg.value}(abi.encodeWithSignature("register(uint256,uint32,uint256,uint32)", maxFee, slaBlocks, collateral, uint32(302400)));
        require(ok, "register failed");
        return abi.decode(data, (uint256));
    }
}

/// @notice Test helper: re-enters claimPayout() on receive() to test CEI protection.
contract ReentrantClaimer {
    address public immutable escrow;
    uint256 public reentryCount;

    constructor(address _escrow) { escrow = _escrow; }

    receive() external payable {
        reentryCount++;
        if (reentryCount < 3) {
            // Try to re-enter claimPayout
            (bool ok,) = escrow.call(abi.encodeWithSignature("claimPayout()"));
            // ok is intentionally unused: reentry is expected to fail due to CEI protection.
            // Solidity 0.8 has no way to discard a call return without triggering either
            // "unused local variable" (this) or "return value not used" -- both are unavoidable.
        }
    }

    function depositToEscrow() external payable {
        (bool ok,) = escrow.call{value: msg.value}(abi.encodeWithSignature("deposit()"));
        require(ok, "deposit failed");
    }

    function claimPayoutFromEscrow() external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("claimPayout()"));
        // ok intentionally unused: failure is expected when reentry protection triggers.
        // Solidity 0.8 has no clean way to discard a call return without a compiler warning.
    }

    function settleEscrow(uint256 commitId) external {
        // Use 1-arg settle(uint256) overload on SLAEscrowTestable (no proof required in tests)
        (bool ok,) = escrow.call(abi.encodeWithSelector(
            bytes4(keccak256("settle(uint256)")),
            commitId
        ));
        require(ok, "settle failed");
    }

    function registerOffer(address registry, uint256 maxFee, uint32 slaBlocks, uint256 collateral) external payable returns (uint256) {
        (bool ok, bytes memory data) = registry.call{value: msg.value}(abi.encodeWithSignature("register(uint256,uint32,uint256,uint32)", maxFee, slaBlocks, collateral, uint32(302400)));
        require(ok, "register failed");
        return abi.decode(data, (uint256));
    }

    function commitToEscrow(uint256 quoteId, bytes32 userOpHash, uint256 /* _fee */, address bundler, uint96 collateral, uint32 slaBlocks) external payable {
        (bool ok,) = escrow.call{value: msg.value}(abi.encodeWithSignature("commit(uint256,bytes32,address,uint96,uint32)", quoteId, userOpHash, bundler, collateral, slaBlocks));
        require(ok, "commit failed");
    }

    function acceptCommit(uint256 commitId) external {
        (bool ok,) = escrow.call(abi.encodeWithSignature("accept(uint256)", commitId));
        require(ok, "accept failed");
    }
}

/// @notice Test helper: re-enters withdraw() on receive() to test CEI protection.
contract ReentrantWithdrawer {
    address public immutable escrow;
    uint256 public reentryCount;
    uint256 public withdrawAmount;

    constructor(address _escrow) { escrow = _escrow; }

    receive() external payable {
        reentryCount++;
        if (reentryCount < 3) {
            // Try to re-enter withdraw
            (bool ok,) = escrow.call(abi.encodeWithSignature("withdraw(uint256)", withdrawAmount));
            // ok intentionally unused: reentry is expected to fail due to CEI protection.
            // Solidity 0.8 has no clean way to discard a call return without a compiler warning.
        }
    }

    function depositToEscrow() external payable {
        (bool ok,) = escrow.call{value: msg.value}(abi.encodeWithSignature("deposit()"));
        require(ok, "deposit failed");
    }

    function withdrawFromEscrow(uint256 amount) external {
        withdrawAmount = amount;
        (bool ok,) = escrow.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        // ok intentionally unused: failure is expected when reentry protection triggers.
        // Solidity 0.8 has no clean way to discard a call return without a compiler warning.
    }
}
