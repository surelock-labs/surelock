// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test helper: a contract whose receive() always reverts.
///      Includes a generic execute() so it can register offers on QuoteRegistry.
///      Used to test push-with-fallback bond recovery via claimBond().
contract ReverterReceiver {
    receive() external payable {
        revert("no ETH");
    }

    /// @dev Forward an arbitrary call with value. Only for testing.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "execute failed");
        return ret;
    }
}
