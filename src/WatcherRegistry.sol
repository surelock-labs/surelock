// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ISureLock} from "./ISureLock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract WatcherRegistry is Ownable2Step {
    enum AddressParam {
        FeeRecipient,
        Watcher,
        SureLock
    }

    address public feeRecipient;
    mapping(address => bool) public isWatcher;

    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event WatcherUpdated(address indexed watcher, bool allowed);

    error ZeroAddress(AddressParam param);
    error NotWatcher(address caller);

    constructor(address owner_, address feeRecipient_, address initialWatcher_) Ownable(owner_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress(AddressParam.FeeRecipient);
        if (initialWatcher_ == address(0)) revert ZeroAddress(AddressParam.Watcher);

        feeRecipient = feeRecipient_;
        isWatcher[initialWatcher_] = true;

        emit WatcherUpdated(initialWatcher_, true);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress(AddressParam.FeeRecipient);

        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;

        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    function setWatcher(address watcher, bool allowed) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress(AddressParam.Watcher);

        isWatcher[watcher] = allowed;

        emit WatcherUpdated(watcher, allowed);
    }

    function cancel(ISureLock surelock, uint256 commitId) external onlyWatcher {
        _requireSureLock(address(surelock));
        surelock.cancel(commitId);
    }

    function settle(ISureLock surelock, uint256 commitId, uint256 inclusionBlock) external onlyWatcher {
        _requireSureLock(address(surelock));
        surelock.settle(commitId, inclusionBlock);
    }

    function refund(ISureLock surelock, uint256 commitId) external onlyWatcher {
        _requireSureLock(address(surelock));
        surelock.refund(commitId);
    }

    modifier onlyWatcher() {
        if (!isWatcher[msg.sender]) revert NotWatcher(msg.sender);
        _;
    }

    function _requireSureLock(address surelock) private pure {
        if (surelock == address(0)) revert ZeroAddress(AddressParam.SureLock);
    }
}
