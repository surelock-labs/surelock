// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.35;

import "./OfferRegistry.sol";
import "./WatcherRegistry.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract SLAEscrow is Ownable2Step, ReentrancyGuardTransient {
    using Address for address payable;

    uint256 public constant MAX_PROTOCOL_FEE = 0.001 ether;
    uint256 public constant MAX_ACCEPT_WINDOW_BLOCKS = 1_000;

    enum CommitStatus {
        Proposed,
        Active,
        Settled,
        Refunded,
        Cancelled
    }

    enum UserOpHashStatus {
        None,
        Active,
        Consumed
    }

    enum AddressParam {
        Registry,
        WatcherRegistry,
        To
    }

    struct Commit {
        address user;
        address provider;
        uint256 offerId;
        bytes32 userOpHash;
        uint256 feePaid;
        uint256 collateral;
        uint256 acceptedBlock;
        uint256 acceptDeadline;
        uint256 deadline;
        uint256 slaBlocks;
        CommitStatus status;
    }

    uint256 public protocolFee;
    uint256 public nextCommitId = 1;
    OfferRegistry public immutable registry;
    WatcherRegistry public watcherRegistry;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockedOf;
    mapping(uint256 => Commit) internal commits;
    mapping(bytes32 => UserOpHashStatus) public userOpHashStatus;

    event Deposited(address indexed provider, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event WatcherRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event CommitCreated(
        uint256 indexed commitId,
        uint256 indexed offerId,
        address indexed user,
        address provider,
        bytes32 userOpHash,
        uint256 feePaid,
        uint256 collateral,
        uint256 slaBlocks,
        uint256 acceptDeadline,
        uint256 protocolFee
    );
    event CommitAccepted(uint256 indexed commitId, address indexed provider, uint256 deadline);
    event Settled(uint256 indexed commitId, uint256 inclusionBlock, uint256 providerAmount);
    event Refunded(uint256 indexed commitId, uint256 userAmount);
    event Cancelled(uint256 indexed commitId, address indexed caller);

    error ZeroDeposit();
    error ZeroAmount();
    error ZeroAddress(AddressParam param);
    error InvalidProtocolFee(uint256 fee);
    error InsufficientIdle(uint256 requested, uint256 available);
    error OfferInactive(uint256 offerId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotProvider(uint256 commitId, address caller);
    error NotWatcherRegistry(address caller);
    error Unauthorized(uint256 commitId, address caller);
    error InvalidCommitStatus(uint256 commitId, CommitStatus status);
    error InclusionBeforeAccept(uint256 commitId, uint256 acceptedBlock, uint256 inclusionBlock);
    error InclusionAfterDeadline(uint256 commitId, uint256 deadline, uint256 inclusionBlock);
    error InclusionInFuture(uint256 commitId, uint256 currentBlock, uint256 inclusionBlock);
    error DeadlineNotReached(uint256 commitId, uint256 deadline, uint256 current);
    error UserOpUnavailable(bytes32 userOpHash, UserOpHashStatus status);
    error InvalidUserOpHash();
    error InvalidAcceptWindow(uint256 value, uint256 min, uint256 max);
    error SelfCommitForbidden(address provider);
    error CommitNotFound(uint256 commitId);
    error AcceptDeadlineReached(uint256 commitId, uint256 acceptDeadline, uint256 current);

    constructor(address registry_, address watcherRegistry_, address owner_) Ownable(owner_) {
        if (registry_ == address(0)) revert ZeroAddress(AddressParam.Registry);
        if (watcherRegistry_ == address(0) || watcherRegistry_ == address(this)) {
            revert ZeroAddress(AddressParam.WatcherRegistry);
        }

        registry = OfferRegistry(registry_);
        watcherRegistry = WatcherRegistry(watcherRegistry_);
    }

    function setProtocolFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_PROTOCOL_FEE) revert InvalidProtocolFee(newFee);

        uint256 oldFee = protocolFee;
        protocolFee = newFee;

        emit ProtocolFeeUpdated(oldFee, newFee);
    }

    function setWatcherRegistry(address newWatcherRegistry) external onlyOwner {
        if (newWatcherRegistry == address(0) || newWatcherRegistry == address(this)) {
            revert ZeroAddress(AddressParam.WatcherRegistry);
        }

        address oldRegistry = address(watcherRegistry);
        watcherRegistry = WatcherRegistry(newWatcherRegistry);

        emit WatcherRegistryUpdated(oldRegistry, newWatcherRegistry);
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();

        balanceOf[msg.sender] += msg.value;

        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _withdrawTo(payable(msg.sender), amount);
    }

    function withdrawTo(address payable to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress(AddressParam.To);
        _withdrawTo(to, amount);
    }

    function _withdrawTo(address payable to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();

        uint256 idle = balanceOf[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);

        balanceOf[msg.sender] -= amount;

        emit Withdrawn(msg.sender, to, amount);
        to.sendValue(amount);
    }

    function commit(uint256 offerId, bytes32 userOpHash, uint256 acceptWindowBlocks)
        external
        payable
        returns (uint256 commitId)
    {
        if (userOpHash == bytes32(0)) revert InvalidUserOpHash();
        UserOpHashStatus status = userOpHashStatus[userOpHash];
        if (status != UserOpHashStatus.None) revert UserOpUnavailable(userOpHash, status);

        OfferRegistry.Offer memory offer = registry.getOffer(offerId);
        if (!registry.isActive(offerId)) revert OfferInactive(offerId);
        if (msg.sender == offer.provider) revert SelfCommitForbidden(offer.provider);
        if (acceptWindowBlocks == 0 || acceptWindowBlocks > MAX_ACCEPT_WINDOW_BLOCKS) {
            revert InvalidAcceptWindow(acceptWindowBlocks, 1, MAX_ACCEPT_WINDOW_BLOCKS);
        }

        uint256 required = offer.feePerOp + protocolFee;
        if (msg.value != required) revert WrongFee(msg.value, required);

        userOpHashStatus[userOpHash] = UserOpHashStatus.Active;
        commitId = nextCommitId++;

        uint256 acceptDeadline = block.number + acceptWindowBlocks;
        commits[commitId] = Commit({
            user: msg.sender,
            provider: offer.provider,
            offerId: offerId,
            userOpHash: userOpHash,
            feePaid: offer.feePerOp,
            collateral: offer.collateral,
            acceptedBlock: 0,
            acceptDeadline: acceptDeadline,
            deadline: 0,
            slaBlocks: offer.slaBlocks,
            status: CommitStatus.Proposed
        });

        balanceOf[watcherRegistry.feeRecipient()] += protocolFee;

        emit CommitCreated(
            commitId,
            offerId,
            msg.sender,
            offer.provider,
            userOpHash,
            offer.feePerOp,
            offer.collateral,
            offer.slaBlocks,
            acceptDeadline,
            protocolFee
        );
    }

    function accept(uint256 commitId) external {
        Commit storage c = commits[commitId];

        if (c.user == address(0)) revert CommitNotFound(commitId);
        if (c.status != CommitStatus.Proposed) revert InvalidCommitStatus(commitId, c.status);
        if (msg.sender != c.provider) revert NotProvider(commitId, msg.sender);
        if (block.number > c.acceptDeadline) {
            revert AcceptDeadlineReached(commitId, c.acceptDeadline, block.number);
        }

        uint256 idle = balanceOf[msg.sender] - lockedOf[msg.sender];
        if (idle < c.collateral) revert InsufficientCollateral(c.collateral, idle);

        c.status = CommitStatus.Active;
        c.acceptedBlock = block.number;
        c.deadline = block.number + c.slaBlocks;
        lockedOf[msg.sender] += c.collateral;

        emit CommitAccepted(commitId, msg.sender, c.deadline);
    }

    function cancel(uint256 commitId) external {
        Commit storage c = commits[commitId];

        if (c.user == address(0)) revert CommitNotFound(commitId);
        if (c.status != CommitStatus.Proposed) revert InvalidCommitStatus(commitId, c.status);

        bool acceptWindowOpen = block.number <= c.acceptDeadline;
        if (acceptWindowOpen && msg.sender != c.user) revert Unauthorized(commitId, msg.sender);
        if (
            !acceptWindowOpen && msg.sender != c.user && msg.sender != c.provider
                && msg.sender != address(watcherRegistry)
        ) {
            revert Unauthorized(commitId, msg.sender);
        }

        c.status = CommitStatus.Cancelled;
        userOpHashStatus[c.userOpHash] = UserOpHashStatus.None;
        balanceOf[c.user] += c.feePaid;

        emit Cancelled(commitId, msg.sender);
    }

    function settle(uint256 commitId, uint256 inclusionBlock) external {
        if (msg.sender != address(watcherRegistry)) revert NotWatcherRegistry(msg.sender);

        Commit storage c = commits[commitId];

        if (c.user == address(0)) revert CommitNotFound(commitId);
        if (c.status != CommitStatus.Active) revert InvalidCommitStatus(commitId, c.status);
        if (inclusionBlock <= c.acceptedBlock) revert InclusionBeforeAccept(commitId, c.acceptedBlock, inclusionBlock);
        if (inclusionBlock > c.deadline) revert InclusionAfterDeadline(commitId, c.deadline, inclusionBlock);
        if (inclusionBlock > block.number) revert InclusionInFuture(commitId, block.number, inclusionBlock);

        c.status = CommitStatus.Settled;
        userOpHashStatus[c.userOpHash] = UserOpHashStatus.Consumed;
        lockedOf[c.provider] -= c.collateral;
        balanceOf[c.provider] += c.feePaid;

        emit Settled(commitId, inclusionBlock, c.feePaid);
    }

    function refund(uint256 commitId) external {
        if (msg.sender != address(watcherRegistry)) revert NotWatcherRegistry(msg.sender);

        Commit storage c = commits[commitId];

        if (c.user == address(0)) revert CommitNotFound(commitId);
        if (c.status != CommitStatus.Active) revert InvalidCommitStatus(commitId, c.status);
        if (block.number <= c.deadline) revert DeadlineNotReached(commitId, c.deadline, block.number);

        c.status = CommitStatus.Refunded;
        userOpHashStatus[c.userOpHash] = UserOpHashStatus.Consumed;
        lockedOf[c.provider] -= c.collateral;
        balanceOf[c.provider] -= c.collateral;

        uint256 userAmount = c.feePaid + c.collateral;
        balanceOf[c.user] += userAmount;

        emit Refunded(commitId, userAmount);
    }

    function idleBalance(address provider) public view returns (uint256) {
        return balanceOf[provider] - lockedOf[provider];
    }

    function getCommit(uint256 commitId) external view returns (Commit memory) {
        return commits[commitId];
    }
}
