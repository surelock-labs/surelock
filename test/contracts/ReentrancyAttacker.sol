// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/SLAEscrow.sol";

/// @dev Used only in tests to verify CEI prevents reentrancy.
contract ReentrancyAttacker {
    SLAEscrow      public immutable escrow;
    QuoteRegistry  public immutable registry;
    uint256        public attackCount;
    uint256        public targetCommitId;
    uint8          public attackMode; // 0=settle, 1=claimRefund, 2=claimPayout

    constructor(address escrow_, address registry_) {
        escrow   = SLAEscrow(escrow_);
        registry = QuoteRegistry(registry_);
    }

    // Register an offer so this contract is the bundler
    function doRegister(uint256 maxFee, uint32 slaBlocks, uint256 collateral)
        external payable returns (uint256)
    {
        return registry.register{value: msg.value}(maxFee, slaBlocks, collateral, 302_400);
    }

    // Deposit collateral into escrow
    function doDeposit() external payable {
        escrow.deposit{value: msg.value}();
    }

    function setTarget(uint256 commitId, uint8 mode) external {
        targetCommitId = commitId;
        attackMode     = mode;
    }

    // Attempt re-entry on receive
    receive() external payable {
        attackCount++;
        if (attackCount < 3) {
            if (attackMode == 0) {
                // Pass empty proof -- will revert with InvalidInclusionProof (or AlreadyFinalized
                // if settle already ran). CEI ensures state is committed before any ETH transfer.
                bytes[] memory emptyProof;
                try escrow.settle(targetCommitId, 0, new bytes(0), emptyProof, 0) {} catch {}
            } else if (attackMode == 1) {
                try escrow.claimRefund(targetCommitId) {} catch {}
            } else {
                try escrow.claimPayout() {} catch {}
            }
        }
    }

    function acceptCommit(uint256 commitId) external {
        escrow.accept(commitId);
    }

    function attackWithdraw(uint256 amount) external {
        escrow.withdraw(amount);
    }

    /// @dev Calls the 1-arg settle(uint256) overload on SLAEscrowTestable via low-level call.
    ///      Used in reentrancy tests -- avoids constructing a real MPT proof.
    function attackSettle(uint256 commitId) external {
        (bool ok,) = address(escrow).call(
            abi.encodeWithSelector(bytes4(keccak256("settle(uint256)")), commitId)
        );
        require(ok, "settle failed");
    }

    function attackSettleWithProof(
        uint256        commitId,
        uint64         inclBlock,
        bytes calldata blockHeaderRlp,
        bytes[] calldata proof,
        uint256        txIndex
    ) external {
        escrow.settle(commitId, inclBlock, blockHeaderRlp, proof, txIndex);
    }

    function attackClaimRefund(uint256 commitId) external {
        escrow.claimRefund(commitId);
    }

    function attackClaimPayout() external {
        escrow.claimPayout();
    }
}
