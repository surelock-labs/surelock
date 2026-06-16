// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ISureLock} from "./ISureLock.sol";
import {WatcherRegistry} from "./WatcherRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract SureLock is ISureLock, Ownable2Step, ReentrancyGuardTransient {
    using Address for address payable;

    uint256 public constant MIN_SLA_BLOCKS = 1;
    uint256 public constant MAX_SLA_BLOCKS = 1_000;
    uint256 public constant MIN_LIFETIME = 1e4;
    uint256 public constant MAX_LIFETIME = 1e6;
    uint256 public constant MAX_PAGE_SIZE = 100;

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
        WatcherRegistry,
        To
    }

    struct Offer {
        address provider;
        bool disabled;
        uint256 feePerOp;
        uint256 collateral;
        uint256 slaBlocks;
        uint256 expiresAt;
    }

    struct OfferView {
        uint256 offerId;
        address provider;
        uint256 feePerOp;
        uint256 collateral;
        uint256 slaBlocks;
        uint256 expiresAt;
        bool exists;
        bool disabled;
        bool active;
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

    uint256 public nextOfferId = 1;
    uint256 public protocolFee;
    uint256 public nextCommitId = 1;

    WatcherRegistry public watcherRegistry;

    mapping(uint256 => Offer) internal offers;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockedOf;
    mapping(uint256 => Commit) internal commits;
    mapping(bytes32 => UserOpHashStatus) public userOpHashStatus;

    event Deposited(address indexed account, uint256 amount);
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
    event OfferRegistered(
        uint256 indexed offerId,
        address indexed provider,
        uint256 feePerOp,
        uint256 collateral,
        uint256 slaBlocks,
        uint256 expiresAt
    );
    event OfferDeactivated(uint256 indexed offerId, address indexed provider);
    event OfferRenewed(uint256 indexed offerId, address indexed provider, uint256 expiresAt);

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
    error OfferNotFound(uint256 offerId);
    error NotOfferOwner(uint256 offerId, address caller);
    error InvalidSlaBlocks(uint256 value, uint256 min, uint256 max);
    error InvalidFee(uint256 value);
    error InvalidCollateral(uint256 collateral, uint256 feePerOp);
    error InvalidLifetime(uint256 value, uint256 min, uint256 max);
    error InvalidOfferPage(uint256 startOfferId, uint256 count, uint256 maxPageSize);

    constructor(address watcherRegistry_, address owner_) Ownable(owner_) {
        if (watcherRegistry_ == address(0) || watcherRegistry_ == address(this)) {
            revert ZeroAddress(AddressParam.WatcherRegistry);
        }

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

    function register(uint256 feePerOp, uint256 slaBlocks, uint256 collateral, uint256 lifetime)
        external
        returns (uint256 offerId)
    {
        if (slaBlocks < MIN_SLA_BLOCKS || slaBlocks > MAX_SLA_BLOCKS) {
            revert InvalidSlaBlocks(slaBlocks, MIN_SLA_BLOCKS, MAX_SLA_BLOCKS);
        }
        if (feePerOp == 0) revert InvalidFee(feePerOp);
        if (collateral <= feePerOp) revert InvalidCollateral(collateral, feePerOp);
        if (lifetime < MIN_LIFETIME || lifetime > MAX_LIFETIME) {
            revert InvalidLifetime(lifetime, MIN_LIFETIME, MAX_LIFETIME);
        }

        offerId = nextOfferId++;

        offers[offerId] = Offer({
            provider: msg.sender,
            disabled: false,
            feePerOp: feePerOp,
            collateral: collateral,
            slaBlocks: slaBlocks,
            expiresAt: block.number + lifetime
        });

        emit OfferRegistered(offerId, msg.sender, feePerOp, collateral, slaBlocks, block.number + lifetime);
    }

    function deactivate(uint256 offerId) external {
        Offer storage offer = offers[offerId];
        if (offer.provider == address(0)) revert OfferNotFound(offerId);
        if (offer.provider != msg.sender) revert NotOfferOwner(offerId, msg.sender);

        offer.disabled = true;

        emit OfferDeactivated(offerId, msg.sender);
    }

    function renew(uint256 offerId, uint256 lifetime) external {
        Offer storage offer = offers[offerId];
        if (offer.provider != msg.sender) revert NotOfferOwner(offerId, msg.sender);
        if (lifetime < MIN_LIFETIME || lifetime > MAX_LIFETIME) {
            revert InvalidLifetime(lifetime, MIN_LIFETIME, MAX_LIFETIME);
        }

        offer.expiresAt = block.number + lifetime;
        offer.disabled = false;

        emit OfferRenewed(offerId, msg.sender, offer.expiresAt);
    }

    function isActive(uint256 offerId) external view returns (bool) {
        return _isActive(offers[offerId]);
    }

    function exists(uint256 offerId) external view returns (bool) {
        return offers[offerId].provider != address(0);
    }

    function offerCount() external view returns (uint256) {
        return nextOfferId - 1;
    }

    function getOfferPage(uint256 startOfferId, uint256 count) external view returns (OfferView[] memory page) {
        if (startOfferId == 0 || count > MAX_PAGE_SIZE) {
            revert InvalidOfferPage(startOfferId, count, MAX_PAGE_SIZE);
        }

        uint256 endExclusive = startOfferId + count;
        if (endExclusive > nextOfferId) endExclusive = nextOfferId;
        if (startOfferId >= endExclusive) return new OfferView[](0);

        page = new OfferView[](endExclusive - startOfferId);
        for (uint256 i = 0; i < page.length; i++) {
            uint256 offerId = startOfferId + i;
            Offer storage offer = offers[offerId];
            bool offerExists = offer.provider != address(0);
            page[i] = OfferView({
                offerId: offerId,
                provider: offer.provider,
                feePerOp: offer.feePerOp,
                collateral: offer.collateral,
                slaBlocks: offer.slaBlocks,
                expiresAt: offer.expiresAt,
                exists: offerExists,
                disabled: offer.disabled,
                active: _isActive(offer)
            });
        }
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        Offer storage offer = offers[offerId];
        if (offer.provider == address(0)) revert OfferNotFound(offerId);

        return offer;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();

        balanceOf[msg.sender] += msg.value;

        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _withdrawTo(payable(msg.sender), amount);
    }

    function withdrawTo(address payable to, uint256 amount) external nonReentrant {
        _withdrawTo(to, amount);
    }

    function _withdrawTo(address payable to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress(AddressParam.To);
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

        Offer storage offer = offers[offerId];
        if (offer.provider == address(0)) revert OfferNotFound(offerId);
        if (!_isActive(offer)) revert OfferInactive(offerId);
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

    function idleBalance(address provider) external view returns (uint256) {
        return balanceOf[provider] - lockedOf[provider];
    }

    function getCommit(uint256 commitId) external view returns (Commit memory) {
        return commits[commitId];
    }

    function _isActive(Offer storage offer) internal view returns (bool) {
        return offer.provider != address(0) && !offer.disabled && block.number <= offer.expiresAt;
    }
}
