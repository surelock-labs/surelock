// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/QuoteRegistry.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @dev V2 with an extra state variable appended AFTER __gap (storage-safe upgrade).
///      V1 layout: slots 0-7 + activeCommitForHash(slot8) + protocolFeeWei(slot9) + retiredHashes(slot10) + registryFrozen+commitsFrozen(slot11,packed) + __gap[45](slots12-56).
///      V2Safe:    same slot-11 + __gap[44](slots12-55) + extraField(slot56).
contract SLAEscrowV2Safe is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
        bool    accepted;
        bool    cancelled;
        uint64  acceptDeadline;
        uint32  slaBlocks;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    uint256 public reservedBalance;                        // slot 7 -- matches V1
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8 -- matches V1
    uint256 public protocolFeeWei;                          // slot 9 -- matches V1
    mapping(bytes32 => bool) public retiredHashes;        // slot 10 -- matches V1
    bool    public registryFrozen;                         // slot 11 byte 0 -- matches V1
    bool    public commitsFrozen;                          // slot 11 byte 1 -- matches V1
    uint256[44] private __gap; // slots 12-55
    uint256 public extraField; // slot 56 -- new storage variable

    event Deposited(address indexed bundler, uint256 amount);
    event Withdrawn(address indexed bundler, uint256 amount);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event CommitCreated(uint256 indexed commitId, uint256 indexed quoteId, address indexed user, address bundler, bytes32 userOpHash, uint64 deadline);
    event Settled(uint256 indexed commitId, uint256 bundlerNet);
    event Refunded(uint256 indexed commitId, uint256 userAmount);
    event PayoutClaimed(address indexed recipient, uint256 amount);

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);
    error UserOpAlreadyCommitted(bytes32 userOpHash);
    error OfferMismatch(uint256 quoteId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress("feeRecipient");
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function setExtraField(uint256 val) external onlyOwner {
        extraField = val;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function commit(
        uint256 quoteId,
        bytes32 userOpHash,
        address bundler,
        uint96  collateral,
        uint32  slaBlocks
    ) external payable returns (uint256 commitId) {
        // CHECKS
        if (activeCommitForHash[userOpHash]) revert UserOpAlreadyCommitted(userOpHash);
        uint256 idle = deposited[bundler] - lockedOf[bundler];
        if (idle < collateral)               revert InsufficientCollateral(collateral, idle);
        // EFFECTS
        activeCommitForHash[userOpHash] = true;
        lockedOf[bundler]  += collateral;
        reservedBalance    += msg.value;
        commitId            = nextCommitId++;
        uint64 deadline     = uint64(block.number) + uint64(slaBlocks);
        commits[commitId]   = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: bundler, collateralLocked: collateral,
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0, accepted: false, cancelled: false,
            acceptDeadline: 0, slaBlocks: 0
        });
        emit CommitCreated(commitId, quoteId, msg.sender, bundler, userOpHash, deadline);
        // INTERACTION
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))        revert OfferInactive(quoteId);
        if (offer.bundler        != bundler)   revert OfferMismatch(quoteId);
        if (offer.feePerOp    != msg.value) revert WrongFee(msg.value, offer.feePerOp);
        if (offer.collateralWei  != collateral) revert OfferMismatch(quoteId);
        if (offer.slaBlocks      != slaBlocks) revert OfferMismatch(quoteId);
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        activeCommitForHash[c.userOpHash] = false;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
        emit Settled(commitId, bundlerNet);
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        activeCommitForHash[c.userOpHash] = false;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
        emit Refunded(commitId, userTotal);
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        reservedBalance -= amount;
        emit PayoutClaimed(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }

    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}

/// @dev V2 variant that writes into the __gap area (storage collision attack).
///      Inserts collisionVar at slot 7 (overwriting V1's reservedBalance) without shrinking __gap.
///      Uses unsafe-allow to bypass OZ plugin checks.
/// @custom:oz-upgrades-unsafe-allow-reachable delegatecall
contract SLAEscrowV2GapCollision is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    // Collision: collisionVar at slot 7 overwrites V1's reservedBalance!
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public collisionVar;
    uint256[50] private __gap; // intentionally not shrunk -- pushes __gap[0] over proofRequired

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setCollisionVar(uint256 val) external {
        collisionVar = val;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function commit(uint256 quoteId, bytes32 userOpHash) external payable returns (uint256 commitId) {
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))    revert OfferInactive(quoteId);
        if (msg.value != offer.feePerOp) revert WrongFee(msg.value, offer.feePerOp);
        uint256 idle = deposited[offer.bundler] - lockedOf[offer.bundler];
        if (idle < offer.collateralWei)     revert InsufficientCollateral(offer.collateralWei, idle);
        lockedOf[offer.bundler] += offer.collateralWei;
        commitId = nextCommitId++;
        uint64 deadline = uint64(block.number) + offer.slaBlocks;
        commits[commitId] = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: offer.bundler, collateralLocked: uint96(offer.collateralWei),
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0
        });
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }
}

/// @dev V2 with a different REFUND_GRACE_BLOCKS constant.
contract SLAEscrowV2DifferentGrace is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 20; // Changed from 5 to 20

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
        bool    accepted;
        bool    cancelled;
        uint64  acceptDeadline;
        uint32  slaBlocks;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    uint256 public reservedBalance;                        // slot 7 -- matches V1
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8 -- matches V1
    uint256 public protocolFeeWei;                          // slot 9 -- matches V1
    mapping(bytes32 => bool) public retiredHashes;        // slot 10 -- matches V1
    bool    public registryFrozen;                         // slot 11 byte 0 -- matches V1
    bool    public commitsFrozen;                          // slot 11 byte 1 -- matches V1
    uint256[45] private __gap;                             // slots 12-56

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress("feeRecipient");
        feeRecipient = newRecipient;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function commit(uint256 quoteId, bytes32 userOpHash) external payable returns (uint256 commitId) {
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))    revert OfferInactive(quoteId);
        if (msg.value != offer.feePerOp) revert WrongFee(msg.value, offer.feePerOp);
        uint256 idle = deposited[offer.bundler] - lockedOf[offer.bundler];
        if (idle < offer.collateralWei)     revert InsufficientCollateral(offer.collateralWei, idle);
        lockedOf[offer.bundler] += offer.collateralWei;
        commitId = nextCommitId++;
        uint64 deadline = uint64(block.number) + offer.slaBlocks;
        commits[commitId] = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: offer.bundler, collateralLocked: uint96(offer.collateralWei),
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0, accepted: false, cancelled: false,
            acceptDeadline: 0, slaBlocks: 0
        });
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }

}

/// @dev Non-UUPS contract -- upgrade target that should fail.
contract NotUUPSContract {
    uint256 public value;
    function setValue(uint256 v) external { value = v; }
}

/// @dev V2 with a reinitializer(2) function.
contract SLAEscrowV2Reinit is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
        bool    accepted;
        bool    cancelled;
        uint64  acceptDeadline;
        uint32  slaBlocks;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    uint256 public reservedBalance;                        // slot 7 -- matches V1
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8 -- matches V1
    uint256 public protocolFeeWei;                          // slot 9 -- matches V1
    mapping(bytes32 => bool) public retiredHashes;        // slot 10 -- matches V1
    bool    public registryFrozen;                         // slot 11 byte 0 -- matches V1
    bool    public commitsFrozen;                          // slot 11 byte 1 -- matches V1
    uint256[44] private __gap;                             // slots 12-55
    uint256 public v2Marker;                               // slot 56

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(uint256 marker) external reinitializer(2) {
        v2Marker = marker;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress("feeRecipient");
        feeRecipient = newRecipient;
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function commit(uint256 quoteId, bytes32 userOpHash) external payable returns (uint256 commitId) {
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))    revert OfferInactive(quoteId);
        if (msg.value != offer.feePerOp) revert WrongFee(msg.value, offer.feePerOp);
        uint256 idle = deposited[offer.bundler] - lockedOf[offer.bundler];
        if (idle < offer.collateralWei)     revert InsufficientCollateral(offer.collateralWei, idle);
        lockedOf[offer.bundler] += offer.collateralWei;
        commitId = nextCommitId++;
        uint64 deadline = uint64(block.number) + offer.slaBlocks;
        commits[commitId] = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: offer.bundler, collateralLocked: uint96(offer.collateralWei),
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0, accepted: false, cancelled: false,
            acceptDeadline: 0, slaBlocks: 0
        });
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }

    function version() external pure returns (string memory) {
        return "2.0.0-reinit";
    }
}

/// @dev V2 that allows unauthorized upgrade (open _authorizeUpgrade).
///      This tests what happens if a V2 has a broken auth gate.
contract SLAEscrowV2OpenAuth is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
        bool    accepted;
        bool    cancelled;
        uint64  acceptDeadline;
        uint32  slaBlocks;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    uint256 public reservedBalance;                        // slot 7 -- matches V1
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8 -- matches V1
    uint256 public protocolFeeWei;                          // slot 9 -- matches V1
    mapping(bytes32 => bool) public retiredHashes;        // slot 10 -- matches V1
    bool    public registryFrozen;                         // slot 11 byte 0 -- matches V1
    bool    public commitsFrozen;                          // slot 11 byte 1 -- matches V1
    uint256[45] private __gap;                             // slots 12-56

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    // VULNERABILITY: no auth check!
    function _authorizeUpgrade(address) internal override {}

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress("feeRecipient");
        feeRecipient = newRecipient;
    }

    function commit(uint256 quoteId, bytes32 userOpHash) external payable returns (uint256 commitId) {
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))    revert OfferInactive(quoteId);
        if (msg.value != offer.feePerOp) revert WrongFee(msg.value, offer.feePerOp);
        uint256 idle = deposited[offer.bundler] - lockedOf[offer.bundler];
        if (idle < offer.collateralWei)     revert InsufficientCollateral(offer.collateralWei, idle);
        lockedOf[offer.bundler] += offer.collateralWei;
        commitId = nextCommitId++;
        uint64 deadline = uint64(block.number) + offer.slaBlocks;
        commits[commitId] = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: offer.bundler, collateralLocked: uint96(offer.collateralWei),
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0, accepted: false, cancelled: false,
            acceptDeadline: 0, slaBlocks: 0
        });
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }
}

/// @dev Selfdestructing implementation -- tests proxy survival.
contract SLAEscrowV2Selfdestruct is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    struct Commit {
        address user;
        uint96  feePaid;
        address bundler;
        uint96  collateralLocked;
        uint64  deadline;
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;
        uint64  inclusionBlock;
        bool    accepted;
        bool    cancelled;
        uint64  acceptDeadline;
        uint32  slaBlocks;
    }

    QuoteRegistry public registry;
    address public feeRecipient;
    mapping(uint256 => Commit)  public commits;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextCommitId;
    uint256 public reservedBalance;                        // slot 7 -- matches V1
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8 -- matches V1
    uint256 public protocolFeeWei;                          // slot 9 -- matches V1
    mapping(bytes32 => bool) public retiredHashes;        // slot 10 -- matches V1
    bool    public registryFrozen;                         // slot 11 byte 0 -- matches V1
    bool    public commitsFrozen;                          // slot 11 byte 1 -- matches V1
    uint256[45] private __gap;                             // slots 12-56

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidFeeBps(uint16 feeBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error NotUser(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);
    error TransferFailed(address recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address registry_, address feeRecipient_) external initializer {
        if (registry_     == address(0)) revert ZeroAddress("registry");
        if (feeRecipient_ == address(0)) revert ZeroAddress("feeRecipient");
        __Ownable_init(msg.sender);
        registry     = QuoteRegistry(registry_);
        feeRecipient = feeRecipient_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender];
        if (amount > idle) revert InsufficientIdle(amount, idle);
        deposited[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress("feeRecipient");
        feeRecipient = newRecipient;
    }

    function commit(uint256 quoteId, bytes32 userOpHash) external payable returns (uint256 commitId) {
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))    revert OfferInactive(quoteId);
        if (msg.value != offer.feePerOp) revert WrongFee(msg.value, offer.feePerOp);
        uint256 idle = deposited[offer.bundler] - lockedOf[offer.bundler];
        if (idle < offer.collateralWei)     revert InsufficientCollateral(offer.collateralWei, idle);
        lockedOf[offer.bundler] += offer.collateralWei;
        commitId = nextCommitId++;
        uint64 deadline = uint64(block.number) + offer.slaBlocks;
        commits[commitId] = Commit({
            user: msg.sender, feePaid: uint96(msg.value),
            bundler: offer.bundler, collateralLocked: uint96(offer.collateralWei),
            deadline: deadline, settled: false, refunded: false,
            quoteId: quoteId, userOpHash: userOpHash,
            inclusionBlock: 0, accepted: false, cancelled: false,
            acceptDeadline: 0, slaBlocks: 0
        });
    }

    function settle(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.bundler != msg.sender)   revert NotBundler(commitId, msg.sender);
        if (c.settled || c.refunded)   revert AlreadyFinalized(commitId);
        if (block.number > c.deadline) revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        c.settled = true;
        lockedOf[c.bundler] -= c.collateralLocked;
        uint256 bundlerNet = uint256(c.feePaid);
        pendingWithdrawals[c.bundler] += bundlerNet;
    }

    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user != msg.sender)     revert NotUser(commitId, msg.sender);
        if (c.settled || c.refunded)  revert AlreadyFinalized(commitId);
        uint64 unlocksAt = c.deadline + REFUND_GRACE_BLOCKS + 1;
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));
        c.refunded = true;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked;
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;
    }

    function claimPayout() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);
    }

    function idleBalance(address bundler) external view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }

    /// @dev Dangerous function that attempts selfdestruct (deprecated post-Dencun but still compiles on 0.8.24)
    function nuke() external onlyOwner {
        // selfdestruct is deprecated but still compiles -- tests should verify proxy handles it
        selfdestruct(payable(msg.sender));
    }
}

/// @dev Minimal UUPS that brinks the proxy by making _authorizeUpgrade always revert.
contract SLAEscrowBricked is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize() external initializer {
        __Ownable_init(msg.sender);
    }

    function _authorizeUpgrade(address) internal pure override {
        revert("BRICKED");
    }

    // Minimal stubs so it compiles as a valid upgrade target
    function deposit() external payable {}
    receive() external payable {}
}
