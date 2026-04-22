// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "./QuoteRegistry.sol";
import "./lib/RLPReader.sol";
import "./lib/MerkleTrie.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title SLAEscrow
/// @notice Two-phase SLA enforcement for ERC-4337 bundlers.
///
/// Lifecycle:
///   PROPOSED  -- commit() by CLIENT; fee paid, no collateral locked; accept window open.
///   ACTIVE    -- accept() by BUNDLER; collateral locked, SLA deadline set.
///   SETTLED   -- settle() with MPT proof; within deadline + SETTLEMENT_GRACE_BLOCKS.
///   REFUNDED  -- claimRefund(); after deadline + SETTLEMENT_GRACE + REFUND_GRACE.
///   CANCELLED -- cancel(); CLIENT during accept window; CLIENT/BUNDLER/feeRecipient after expiry.
///
/// @dev Pull-based payouts: settle(), claimRefund(), and cancel() make NO external calls --
///      all funds accumulate in pendingWithdrawals and are claimed via claimPayout(). This
///      eliminates reentrancy risk and prevents a reverting recipient from bricking the contract.
///
///      Two-phase design: commit() establishes CLIENT intent (fee paid, hash committed);
///      accept() is BUNDLER consent (collateral locked, SLA clock starts). Hash model:
///      CLIENT supplies the canonical ERC-4337 userOpHash (off-chain computed), which matches
///      topic[1] of the EntryPoint UserOperationEvent -- enabling direct settlement proof.
///
///      A10 execution proof: settle() requires a Merkle Patricia Trie receipt proof against
///      the block's receiptsRoot (extracted from the RLP block header, verified via blockhash).
///      The receipt must contain a UserOperationEvent log from entryPoint with
///      topic[1] == c.userOpHash AND success == true, proving the specific UserOp was
///      successfully executed on-chain. Inclusion alone (success == false) does not settle.
///
///      ETH invariant (A4 -- conservation of value):
///        address(this).balance == reservedBalance  (under normal operation;
///        force-sent ETH via selfdestruct can make balance > reservedBalance
///        until sweepExcess() is called -- see reservedBalance field comment)
contract SLAEscrow is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient {
    using RLPReader for RLPReader.RLPItem;
    using Address for address payable;

    // -- constants -------------------------------------------------------------

    /// @notice ERC-4337 EntryPoint event topic for UserOperationEvent.
    ///         keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
    ///         topic[0] = selector; topic[1] = userOpHash (indexed).
    bytes32 private constant USER_OP_EVENT_TOPIC =
        0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f;

    /// @notice Expected return value of QuoteRegistry.registryInterfaceVersion().
    ///         Bump the string in both contracts whenever the escrow-registry interface changes.
    bytes32 private constant REGISTRY_INTERFACE_VERSION = keccak256("SureLockQuoteRegistry:v1");

    /// @notice Extra blocks after the SLA deadline during which the bundler can still settle.
    ///         On Base (~2s blocks): 10 blocks ~= 20s, surviving typical reorg windows.
    ///         Creates a non-overlapping settle / refund window:
    ///           settle  : (acceptBlock, deadline + SETTLEMENT_GRACE_BLOCKS]
    ///           neither : (deadline + SETTLEMENT_GRACE_BLOCKS, deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS]
    ///           refund  : [deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1, inf)
    uint64 public constant SETTLEMENT_GRACE_BLOCKS = 10;

    /// @notice Blocks after the settlement window before the client can claim a refund.
    ///         On Base (~2s blocks): 5 blocks ~= 10s dead zone prevents settle/refund race.
    uint64 public constant REFUND_GRACE_BLOCKS = 5;

    /// @notice Blocks from commit() within which BUNDLER must call accept().
    ///         On Base (~2s blocks): 12 blocks ~= 24s.
    uint64 public constant ACCEPT_GRACE_BLOCKS = 12;

    /// @notice Maximum SLA window a bundler offer may specify.
    ///         On Base (~2s blocks): 1,000 blocks ~= 33 minutes.
    ///         Bounds fund-lock duration; satisfies T22 with large margin against any
    ///         realistic timelock delay.
    uint32 public constant MAX_SLA_BLOCKS = 1_000;

    /// @notice Maximum protocol fee per commit in wei.
    uint256 public constant MAX_PROTOCOL_FEE_WEI = 0.001 ether;

    /// @notice Minimum elapsed time after freezeCommits() before an upgrade may execute.
    ///         Derived from the worst-case T22 resolution window on Base (2 s/block):
    ///         (ACCEPT_GRACE_BLOCKS + MAX_SLA_BLOCKS + SETTLEMENT_GRACE_BLOCKS +
    ///          REFUND_GRACE_BLOCKS + 1) * 2 s = (12 + 1000 + 10 + 5 + 1) * 2 = 2,056 s.
    ///         Any commit created before freezeCommits() is guaranteed resolvable by the time
    ///         this window elapses, so no open commitment can straddle the upgrade boundary.
    uint64 public constant MAX_RESOLUTION_WINDOW_SECONDS = 2_056;

    // -- types -----------------------------------------------------------------

    /// @dev Packed into 6 storage slots:
    ///   slot 0: user(20) + feePaid(12)
    ///   slot 1: bundler(20) + collateralLocked(12)
    ///   slot 2: deadline(8) + settled(1) + refunded(1) + [22 padding]
    ///   slot 3: quoteId(32)
    ///   slot 4: userOpHash(32)
    ///   slot 5: inclusionBlock(8) + accepted(1) + cancelled(1) + acceptDeadline(8) + slaBlocks(4) + [10 padding]
    ///
    ///   uint96 max is ~79B ETH, safe for any realistic fee or collateral value.
    ///   Fields added in v0.6 are appended after inclusionBlock to preserve proxy storage layout.
    ///   Old entries (committed before v0.6) have zero-padded v0.6 fields; accepted=false is safe
    ///   provided the T22 timelock guarantee holds -- i.e. no new commits were created after the
    ///   upgrade was queued (Model A observation-only; see docs/DESIGN.md T22).
    struct Commit {
        address user;
        uint96  feePaid;           // feePerOp only (protocolFeeWei credited at commit time)
        address bundler;           // snapshotted at commit; immutable thereafter
        uint96  collateralLocked;  // agreed collateral (locked in lockedOf[] at accept())
        uint64  deadline;          // SLA deadline block (0 while PROPOSED; set at accept())
        bool    settled;
        bool    refunded;
        uint256 quoteId;
        bytes32 userOpHash;        // canonical ERC-4337 userOpHash; CLIENT-supplied (computed off-chain)
        uint64  inclusionBlock;    // block number of UserOp inclusion (set at settle())
        // -- v0.6 additions (appended; proxy-safe) -----------------------------
        bool    accepted;          // true once BUNDLER calls accept()
        bool    cancelled;         // true once commit is cancelled
        uint64  acceptDeadline;    // last block at which BUNDLER may call accept()
        uint32  slaBlocks;         // SLA window in blocks (snapshotted from offer at commit())
    }

    // -- immutables (baked into implementation bytecode, not proxy storage) -----

    /// @notice ERC-4337 EntryPoint address. All A10 execution proofs must show a
    ///         UserOperationEvent from this address.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable entryPoint;

    // -- state (order matters for proxy storage layout) ------------------------

    QuoteRegistry public registry;             // slot 0
    address public feeRecipient;               // slot 1
    mapping(uint256 => Commit) internal commits;            // slot 2 -- use getCommitCore/getCommitState for external reads
    mapping(address => uint256) public deposited;          // slot 3
    mapping(address => uint256) public lockedOf;           // slot 4
    mapping(address => uint256) public pendingWithdrawals; // slot 5
    uint256 public nextCommitId;                           // slot 6
    /// @notice Tracks every wei the contract legitimately holds on behalf of users.
    ///         Incremented on deposit() and commit(); decremented on withdraw() and claimPayout().
    ///         Under normal operation: reservedBalance == address(this).balance.
    ///         After force-sent ETH (e.g., selfdestruct): balance > reservedBalance.
    ///         The difference is untracked surplus sweepable by the owner via sweepExcess().
    uint256 public reservedBalance;                        // slot 7
    /// @notice Tracks which userOpHashes currently have an open (non-finalized) commit.
    ///         Prevents committing the same UserOp to two bundlers simultaneously.
    ///         Cleared on settle(), claimRefund(), or cancel().
    mapping(bytes32 => bool) public activeCommitForHash;  // slot 8
    /// @notice Flat ETH fee per commit credited to feeRecipient at commit time, unconditionally.
    ///         Non-refundable on cancel (spam deterrent). 0 at deploy; activated post-launch.
    uint256 public protocolFeeWei;                          // slot 9
    /// @notice Permanently records every userOpHash that has reached any terminal state
    ///         (settled, refunded, or cancelled). Never cleared. Prevents same-hash reuse --
    ///         retries must use a fresh UserOp / fresh hash (T23). Also blocks double-payment
    ///         via slot recycling (T1).
    mapping(bytes32 => bool) public retiredHashes;        // slot 10
    /// @notice One-way lock on registry under current implementation logic. Once set,
    ///         setRegistry() reverts in all current code paths. The flag persists in proxy
    ///         storage (slot 11) across implementation upgrades, but governance could deploy
    ///         new logic that ignores or clears it -- hard immutability requires Stage 3
    ///         (upgrade renounced). See docs/DESIGN.md Stage 2.
    bool public registryFrozen;                            // slot 11 byte 0 (packed)
    /// @notice One-way latch: once set, commit() reverts. Governance calls this before
    ///         queuing any layout-changing upgrade so no new PROPOSED commits straddle
    ///         the upgrade boundary (on-chain enforcement of docs/DESIGN.md T22 obs. rule).
    ///         Never cleared after being set.
    bool public commitsFrozen;                             // slot 11 byte 1 (packed)
    /// @notice Timestamp at which freezeCommits() was activated. Used by _authorizeUpgrade()
    ///         to enforce that MAX_RESOLUTION_WINDOW_SECONDS has elapsed before any upgrade
    ///         executes -- guaranteeing all pre-freeze commits are resolvable by upgrade time.
    uint64 public commitsFrozenAt;                         // slot 11 bytes 2-9 (packed with bools)
    uint256[45] private __gap;                             // slots 12-56

    // -- events ----------------------------------------------------------------

    event Deposited(address indexed bundler, uint256 indexed amount);
    event Withdrawn(address indexed bundler, uint256 indexed amount);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ExcessSwept(address indexed recipient, uint256 indexed amount);
    /// @notice Emitted when a CLIENT creates a PROPOSED commit.
    ///         acceptDeadline is the last block at which BUNDLER may call accept().
    event CommitCreated(
        uint256 indexed commitId,
        uint256 indexed quoteId,
        address indexed user,
        address         bundler,
        bytes32         userOpHash,
        uint64          acceptDeadline
    );
    /// @notice Emitted when BUNDLER accepts a PROPOSED commit, starting the SLA clock.
    event CommitAccepted(
        uint256 indexed commitId,
        address indexed bundler,
        uint64          deadline
    );
    event Settled(uint256 indexed commitId, uint256 bundlerNet);
    event Refunded(uint256 indexed commitId, uint256 userAmount);
    /// @notice Emitted when a PROPOSED commit is cancelled.
    event Cancelled(uint256 indexed commitId, address indexed triggeredBy);
    event PayoutClaimed(address indexed recipient, uint256 indexed amount);
    /// @notice Emitted once when freezeRegistry() is called. Irreversible -- no function emits this twice.
    event RegistryFreezeActivated();
    /// @notice Emitted once when freezeCommits() is called. Irreversible.
    event CommitsFreezeActivated();

    // -- errors ----------------------------------------------------------------

    error ZeroDeposit();
    error ZeroAddress(string param);
    error InvalidProtocolFee(uint256 fee);
    error InsufficientIdle(uint256 requested, uint256 available);
    error NothingToClaim();
    error OfferInactive(uint256 quoteId);
    error WrongFee(uint256 sent, uint256 required);
    error InsufficientCollateral(uint256 required, uint256 available);
    error NotBundler(uint256 commitId, address caller);
    error Unauthorized(uint256 commitId, address caller);
    error AlreadyFinalized(uint256 commitId);
    error DeadlinePassed(uint256 commitId, uint64 deadline, uint64 current);
    error NotExpired(uint256 commitId, uint64 unlocksAt, uint64 current);

    error InclusionAfterDeadline(uint256 commitId, uint64 inclusionBlock, uint64 deadline);
    error InclusionBeforeAccept(uint256 commitId, uint64 inclusionBlock, uint64 acceptBlock);
    error BlockHashUnavailable(uint256 commitId, uint64 inclusionBlock);
    error InvalidInclusionProof(uint256 commitId);
    error UserOpAlreadyCommitted(bytes32 userOpHash);
    error InvalidUserOpHash();                       // bytes32(0) is never a valid ERC-4337 hash
    error OfferMismatch(uint256 quoteId);
    error RenounceOwnershipDisabled();
    error CommitNotFound(uint256 commitId);        // commitId has never been created
    error AcceptWindowExpired(uint256 commitId);   // accept() called after window closed
    error CommitNotActive(uint256 commitId);       // settle/claimRefund on non-ACTIVE commit
    error CommitNotProposed(uint256 commitId);     // accept/cancel on already-accepted commit
    error InvalidSlaBlocks(uint256 slaBlocks);     // slaBlocks > MAX_SLA_BLOCKS
    error UserOpHashRetired(bytes32 userOpHash);    // T1/T23: hash permanently retired after any terminal state
    error SelfCommitForbidden(address bundler);    // A3/T8: bundler cannot commit to their own offer
    error RegistryFrozen();                        // setRegistry() called after freezeRegistry()
    error CommitsFrozen();                         // commit() called after freezeCommits()
    error InvalidRegistry(address addr);           // setRegistry() called with EOA (non-contract)
    error RegistrySelfReference();                 // newRegistry == address(this)
    error RegistryAlreadySet(address addr);        // newRegistry already equals current registry
    error RegistryGovernanceMismatch();            // registry.owner() != owner() (split governance)
    error RegistrySlaBoundsMismatch();             // registry.MAX_SLA_BLOCKS() != MAX_SLA_BLOCKS
    error UpgradeRequiresFrozenCommits();          // T22: must freeze commits before executing upgrade
    error UpgradeFreezeWindowActive(uint64 readyAt, uint64 currentTime); // T22: freeze window not yet elapsed

    // -- constructor (implementation only) -------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address entryPoint_) {
        require(entryPoint_ != address(0), "SLAEscrow: zero entryPoint");
        entryPoint = entryPoint_;
        _disableInitializers();
    }

    // -- initializer (called once via proxy) -----------------------------------

    /// @notice Deployment constraint: registry_ must be owned by msg.sender at init time
    ///         (owner() == msg.sender after __Ownable_init). Both contracts should start under
    ///         the deployer EOA and be transferred to the TimelockController together.
    function initialize(address registry_, address feeRecipient_) external initializer {
        if (feeRecipient_ == address(0) || feeRecipient_ == address(this))
            revert ZeroAddress("feeRecipient");

        // Must init owner before _validateRegistry so owner() is available for governance check.
        __Ownable_init(msg.sender);
        _validateRegistry(registry_);

        registry          = QuoteRegistry(registry_);
        feeRecipient      = feeRecipient_;
        protocolFeeWei    = 0;
        nextCommitId      = 0;
    }

    // -- UUPS upgrade authorization --------------------------------------------

    /// @dev T22 -- upgrade safety enforced at authorization time, not just by documentation.
    ///      Requires (1) commits are already frozen and (2) MAX_RESOLUTION_WINDOW_SECONDS has
    ///      elapsed since freeze, guaranteeing every pre-freeze commit is resolvable before the
    ///      upgrade executes. The TimelockController's own minDelay (>= 48 h on mainnet) provides
    ///      additional notice on top of this window. Together they ensure no open commitment can
    ///      straddle a layout-changing upgrade.
    function _authorizeUpgrade(address) internal view virtual override onlyOwner {
        if (!commitsFrozen) revert UpgradeRequiresFrozenCommits();
        uint64 readyAt = commitsFrozenAt + MAX_RESOLUTION_WINDOW_SECONDS;
        if (uint64(block.timestamp) < readyAt)
            revert UpgradeFreezeWindowActive(readyAt, uint64(block.timestamp));
    }

    // -- Ownership guard -------------------------------------------------------

    /// @notice Disabled -- renouncing ownership would permanently brick admin functions.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    // -- admin -----------------------------------------------------------------

    /// @notice Update the fee recipient address. Only callable by owner.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0) || newRecipient == address(this))
            revert ZeroAddress("feeRecipient");
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Update the flat protocol fee per commit. Only affects future commits.
    ///         T24: bounded by MAX_PROTOCOL_FEE_WEI -- no valid setting can reduce any actor's
    ///         in-protocol return to zero or below (A7). A6: open commitments are unaffected --
    ///         feePaid is snapshotted at commit time and is never re-read from storage.
    function setProtocolFeeWei(uint256 newFee) external onlyOwner {
        if (newFee > MAX_PROTOCOL_FEE_WEI) revert InvalidProtocolFee(newFee);
        emit ProtocolFeeUpdated(protocolFeeWei, newFee);
        protocolFeeWei = newFee;
    }

    /// @notice Update the QuoteRegistry address. Only affects future commits.
    ///         A6/T22: open commitments are safe -- every parameter (including quoteId, collateral,
    ///         feePerOp, slaBlocks) is snapshotted into the Commit struct at commit() time and
    ///         never re-read from the registry. Changing registry cannot retroactively alter any
    ///         unresolved commitment. A Certora rule (setRegistry_noAffectOpenCommits) verifies this.
    ///         Governance trust: existing commitments are fully protected; future commitments are
    ///         only as safe as the registry address governance points to (timelock/operator
    ///         until Stage 3 -- upgrade renounced). Reverts RegistryFrozen after freezeRegistry().
    function setRegistry(address newRegistry) external onlyOwner {
        if (registryFrozen)                      revert RegistryFrozen();
        if (newRegistry == address(registry))    revert RegistryAlreadySet(newRegistry);
        _validateRegistry(newRegistry);
        emit RegistryUpdated(address(registry), newRegistry);
        registry = QuoteRegistry(newRegistry);
    }

    /// @notice Lock the registry address under current implementation logic. The flag persists
    ///         in proxy storage (slot 11) so any future implementation will observe it, but
    ///         governance could deploy new logic that ignores or clears this flag -- hard
    ///         immutability requires Stage 3 (upgrade renounced). See docs/DESIGN.md Stage 2.
    ///         Call only after confirming the production registry address is stable.
    function freezeRegistry() external onlyOwner {
        if (registryFrozen) revert RegistryFrozen();
        registryFrozen = true;
        emit RegistryFreezeActivated();
    }

    /// @notice Permanently disable commit(). Call this before queuing any layout-changing
    ///         upgrade so no new PROPOSED commits can be created while the upgrade is pending
    ///         (on-chain enforcement of docs/DESIGN.md T22 upgrade-window observation rule).
    ///         Irreversible -- once set, new commitments must wait for the new implementation.
    function freezeCommits() external onlyOwner {
        if (commitsFrozen) revert CommitsFrozen();
        commitsFrozen   = true;
        commitsFrozenAt = uint64(block.timestamp);
        emit CommitsFreezeActivated();
    }

    // -- bundler: deposit / withdraw -------------------------------------------

    /// @notice Bundler deposits ETH collateral pool. Additive -- call multiple times.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposited[msg.sender] += msg.value;
        reservedBalance       += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Bundler withdraws idle (unlocked) collateral to an explicit recipient.
    ///         Use this when msg.sender is a smart contract that cannot receive ETH directly.
    ///         T2: idle collateral is always accessible -- BUNDLER is never locked in against their will.
    function withdrawTo(address payable to, uint256 amount) public nonReentrant {
        if (to == address(0)) revert ZeroAddress("to");
        uint256 idle = deposited[msg.sender] - lockedOf[msg.sender]; // T2: idle = deposited - locked
        if (amount > idle) revert InsufficientIdle(amount, idle);
        // CEI: state updated before transfer
        deposited[msg.sender] -= amount;
        reservedBalance       -= amount;
        emit Withdrawn(msg.sender, amount);
        to.sendValue(amount);
    }

    /// @notice Bundler withdraws idle collateral to msg.sender. Convenience wrapper for withdrawTo.
    function withdraw(uint256 amount) external {
        withdrawTo(payable(msg.sender), amount);
    }

    // -- client: commit --------------------------------------------------------

    /// @notice CLIENT commits a UserOp to a bundler offer, paying the service fee upfront.
    ///         Creates a PROPOSED commit; no collateral is locked yet.
    ///         BUNDLER has ACCEPT_GRACE_BLOCKS to call accept(); if not, the commit expires
    ///         and CLIENT may cancel() to recover feePerOp (protocolFeeWei is non-refundable).
    ///         Reverts SelfCommitForbidden if msg.sender == bundler (A3/T8).
    ///
    ///         Hash model: CLIENT supplies the canonical ERC-4337 userOpHash (computed off-chain
    ///         as keccak256(abi.encode(userOp.hash(), entryPoint, chainid))). This is the exact
    ///         hash the EntryPoint will emit as topic[1] of UserOperationEvent, so the on-chain
    ///         settlement proof can verify it directly without re-encoding the full UserOp.
    ///
    /// @dev    Offer validation (registry call) is done BEFORE recording effects so that
    ///         feePaid = offer.feePerOp directly -- no subtraction, no underflow risk from
    ///         protocolFeeWei. registry.getOffer() is a view call to the current configured
    ///         registry; open commitments snapshot all critical fields and never re-read them.
    ///
    /// @param quoteId     Offer ID from QuoteRegistry (must be active).
    /// @param userOpHash  Canonical ERC-4337 userOpHash (client-computed off-chain).
    /// @param bundler     Bundler address from the offer (verified against registry).
    /// @param collateral  Collateral amount from the offer in wei (verified against registry).
    /// @param slaBlocks   SLA window in blocks from the offer (verified; <= MAX_SLA_BLOCKS).
    /// @return commitId   Unique ID for this commitment.
    function commit(
        uint256 quoteId,
        bytes32 userOpHash,
        address bundler,
        uint96  collateral,
        uint32  slaBlocks
    ) external payable returns (uint256 commitId) {
        // CHECKS
        if (commitsFrozen)                   revert CommitsFrozen();                     // T22: upgrade-window fence; set by governance before any layout-changing upgrade
        if (userOpHash == bytes32(0))        revert InvalidUserOpHash();                 // bytes32(0) is never a valid ERC-4337 hash; blocks bundler-griefing
        if (bundler == address(0))           revert ZeroAddress("bundler");              // defense-in-depth: non-standard registry could otherwise snapshot a zero bundler, permanently locking feePaid
        if (msg.sender == bundler)           revert SelfCommitForbidden(bundler);        // A3/T8: prevents Sybil SLA via self-commit
        if (activeCommitForHash[userOpHash]) revert UserOpAlreadyCommitted(userOpHash); // T23: one active commit per hash
        if (retiredHashes[userOpHash])        revert UserOpHashRetired(userOpHash);      // T1/T23: hash permanently retired; fresh retry requires new UserOp + new hash
        if (slaBlocks < 1 || slaBlocks > MAX_SLA_BLOCKS) revert InvalidSlaBlocks(slaBlocks); // T24: slaBlocks in [1, MAX_SLA_BLOCKS]

        // INTERACTION -- validate offer before recording effects so feePaid = offer.feePerOp directly.
        // registry is governance-controlled but this is a view call; open commits snapshot all fields.
        QuoteRegistry.Offer memory offer = registry.getOffer(quoteId);
        if (!registry.isActive(quoteId))                  revert OfferInactive(quoteId);
        if (offer.bundler       != bundler)                revert OfferMismatch(quoteId); // T9: bait-and-switch proof -- CLIENT-supplied fields verified against live registry snapshot
        if (offer.collateralWei != collateral)             revert OfferMismatch(quoteId); // T9: collateral term cannot be substituted post-commit
        if (offer.slaBlocks     != slaBlocks)              revert OfferMismatch(quoteId); // T9: SLA term cannot be substituted post-commit
        // Safety invariants re-validated locally regardless of registry implementation.
        // QuoteRegistry.register() enforces all three, but setRegistry() accepts any contract
        // with code, so a non-standard registry could return offers that violate them.
        if (offer.feePerOp < 1)                            revert OfferMismatch(quoteId); // T1: payout must be positive
        if (uint256(offer.feePerOp) > type(uint96).max)    revert OfferMismatch(quoteId); // safe uint96 cast; QuoteRegistry caps at uint96.max
        if (offer.collateralWei <= offer.feePerOp)         revert OfferMismatch(quoteId); // T8: slash must be strictly net-negative for BUNDLER
        uint256 required = uint256(offer.feePerOp) + protocolFeeWei;
        if (msg.value != required)                         revert WrongFee(msg.value, required); // T5: exact-match -- CLIENT never silently bound to a changed fee

        // EFFECTS
        activeCommitForHash[userOpHash] = true;
        reservedBalance    += msg.value;
        commitId            = nextCommitId++;
        uint64 acceptDeadline = uint64(block.number) + ACCEPT_GRACE_BLOCKS;

        commits[commitId] = Commit({
            user:             msg.sender,
            feePaid:          uint96(offer.feePerOp),  // A1: stored directly; protocolFeeWei credited below
            bundler:          bundler,
            collateralLocked: collateral,
            deadline:         0,
            settled:          false,
            refunded:         false,
            quoteId:          quoteId,
            userOpHash:       userOpHash,
            inclusionBlock:   0,
            accepted:         false,
            cancelled:        false,
            acceptDeadline:   acceptDeadline,
            slaBlocks:        slaBlocks
        });

        // A1/T6: protocol fee credited unconditionally at commit time (non-refundable; revenue tied to volume, not performance).
        // T4: protocolFeeWei is the only non-refundable CLIENT cost; feePerOp is always recoverable via cancel() or claimRefund().
        if (protocolFeeWei > 0) pendingWithdrawals[feeRecipient] += protocolFeeWei;

        emit CommitCreated(commitId, quoteId, msg.sender, bundler, userOpHash, acceptDeadline);
    }

    // -- bundler: accept -------------------------------------------------------

    /// @notice BUNDLER accepts a PROPOSED commit: locks collateral and starts the SLA clock.
    ///         Transitions the commit from PROPOSED to ACTIVE.
    ///         Must be called within ACCEPT_GRACE_BLOCKS of the commit block.
    ///         BUNDLER consent act per T25: only the named bundler may accept.
    ///
    /// @param commitId  Commitment to accept.
    function accept(uint256 commitId) external {
        Commit storage c = commits[commitId];

        if (c.user == address(0))                                     revert CommitNotFound(commitId);
        if (c.accepted || c.cancelled || c.settled || c.refunded)     revert CommitNotProposed(commitId);
        if (c.bundler != msg.sender)                                  revert NotBundler(commitId, msg.sender); // T25: bundler consent required
        if (block.number > c.acceptDeadline)                          revert AcceptWindowExpired(commitId);    // A9: bounded accept window

        uint256 idle = deposited[c.bundler] - lockedOf[c.bundler];
        if (idle < c.collateralLocked) revert InsufficientCollateral(c.collateralLocked, idle); // T8: collateral > feePerOp enforced at registration

        // EFFECTS
        c.accepted = true;
        c.deadline = uint64(block.number) + uint64(c.slaBlocks);
        lockedOf[c.bundler] += c.collateralLocked;

        emit CommitAccepted(commitId, c.bundler, c.deadline);
    }

    // -- client / cleanup: cancel ----------------------------------------------

    /// @notice Cancel a PROPOSED commit and return feePerOp to CLIENT.
    ///         protocolFeeWei is non-refundable (spam deterrent).
    ///
    ///         During accept window  : only CLIENT may cancel.
    ///         After accept window   : CLIENT, BUNDLER, or feeRecipient may cancel.
    ///         ACTIVE commits (accepted == true) cannot be cancelled; they settle or refund.
    ///
    /// @param commitId  PROPOSED commitment to cancel.
    function cancel(uint256 commitId) external {
        Commit storage c = commits[commitId];

        if (c.user == address(0))                   revert CommitNotFound(commitId);
        if (c.settled || c.refunded || c.cancelled) revert AlreadyFinalized(commitId);
        if (c.accepted)                             revert CommitNotProposed(commitId);

        bool windowOpen = block.number <= c.acceptDeadline;
        if (windowOpen) {
            // During accept window: only CLIENT may cancel
            if (msg.sender != c.user) revert Unauthorized(commitId, msg.sender);
        } else {
            // After accept window: CLIENT, BUNDLER, or feeRecipient (PROTOCOL cleanup)
            if (msg.sender != c.user && msg.sender != c.bundler && msg.sender != feeRecipient)
                revert Unauthorized(commitId, msg.sender);
        }

        // EFFECTS
        c.cancelled = true;
        retiredHashes[c.userOpHash]       = true;  // T23: hash retired -- fresh retry requires new UserOp
        activeCommitForHash[c.userOpHash] = false;
        pendingWithdrawals[c.user] += uint256(c.feePaid); // T11: feePaid returned; protocolFeeWei non-refundable -- T11 cost floor holds on every terminal path

        emit Cancelled(commitId, msg.sender);
    }

    // -- bundler: settle --------------------------------------------------------

    /// @notice Settle by submitting a cryptographic on-chain execution proof (A10).
    ///         Permissionless: any caller may submit the proof; fee is always paid to c.bundler.
    ///         Commit must be in ACTIVE state (accept() already called).
    ///
    /// @dev    Proof verification sequence:
    ///           1. keccak256(blockHeaderRlp) == blockhash(inclusionBlock)
    ///           2. Extract receiptsRoot from blockHeaderRlp field [5].
    ///           3. MerkleTrie.get(rlp(txIndex), receiptProof, receiptsRoot)
    ///           4. Parse receipt logs; verify entryPoint emitted UserOperationEvent
    ///              with topic[1] == c.userOpHash.
    ///
    ///         Constraint: settle() must be called within 256 blocks of inclusionBlock
    ///         (blockhash is only available for the last 256 blocks). With SLA windows up to
    ///         MAX_SLA_BLOCKS (1,000 blocks ~= 33 min), bundlers should settle promptly.
    ///
    /// @param commitId       ACTIVE commitment to settle.
    /// @param inclusionBlock Block number where inclusion occurred (<= deadline, within 256 blocks).
    /// @param blockHeaderRlp RLP-encoded block header for inclusionBlock.
    /// @param receiptProof   Ordered MPT proof nodes (root -> leaf) for the receipt trie.
    /// @param txIndex        Transaction index of the EntryPoint bundle within the block.
    function settle(
        uint256          commitId,
        uint64           inclusionBlock,
        bytes   calldata blockHeaderRlp,
        bytes[] calldata receiptProof,
        uint256          txIndex
    ) external virtual {
        Commit storage c = commits[commitId];

        if (c.user == address(0))               revert CommitNotFound(commitId);
        if (!c.accepted)                        revert CommitNotActive(commitId);
        if (c.settled || c.refunded || c.cancelled) revert AlreadyFinalized(commitId);
        if (block.number > c.deadline + SETTLEMENT_GRACE_BLOCKS)
            revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        if (inclusionBlock > c.deadline)
            revert InclusionAfterDeadline(commitId, inclusionBlock, c.deadline);
        // acceptBlock = deadline - slaBlocks; inclusion must be strictly after accept() block
        // to avoid same-block ordering ambiguity (accept and inclusion in the same block would
        // mean inclusion could precede the consent act at the intra-block level).
        uint64 acceptBlock = c.deadline - uint64(c.slaBlocks);
        if (inclusionBlock <= acceptBlock)
            revert InclusionBeforeAccept(commitId, inclusionBlock, acceptBlock);
        // blockhash() returns 0 for the current block, any future block, and blocks > 256 old.
        // Consequence: settlement for the block in which inclusion occurred cannot be proved
        // until the NEXT block (earliest). Same-block settle() always reverts here.
        if (blockhash(inclusionBlock) == bytes32(0))
            revert BlockHashUnavailable(commitId, inclusionBlock);

        // A10: cryptographically prove the UserOp was successfully executed through EntryPoint in inclusionBlock
        _verifyReceiptProof(commitId, c.userOpHash, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);

        c.inclusionBlock = inclusionBlock;
        _settle(commitId);
    }

    // -- client: claimRefund ---------------------------------------------------

    /// @notice Claim refund after SLA deadline + grace window (SLA miss).
    ///         Commit must be ACTIVE; slashes 100% of bundler collateral to CLIENT.
    ///
    ///         Access: CLIENT, BUNDLER, or feeRecipient (T12/A9).
    ///         BUNDLER can self-trigger to free locked collateral; CLIENT inaction
    ///         cannot trap BUNDLER's capital forever.
    ///
    /// @param commitId  Expired ACTIVE commitment.
    function claimRefund(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.user == address(0))                   revert CommitNotFound(commitId);
        if (c.settled || c.refunded || c.cancelled) revert AlreadyFinalized(commitId);
        if (!c.accepted)                            revert CommitNotActive(commitId);
        // T12/A9: only CLIENT, BUNDLER, or feeRecipient (PROTOCOL) may trigger resolution; CLIENT inaction cannot trap funds
        if (msg.sender != c.user && msg.sender != c.bundler && msg.sender != feeRecipient)
            revert Unauthorized(commitId, msg.sender);
        uint64 unlocksAt = c.deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1; // A9: non-overlapping settle/refund windows
        if (uint64(block.number) < unlocksAt) revert NotExpired(commitId, unlocksAt, uint64(block.number));

        c.refunded = true;
        retiredHashes[c.userOpHash]       = true;  // T23: hash retired -- fresh retry requires new UserOp
        activeCommitForHash[c.userOpHash] = false;
        lockedOf[c.bundler]  -= c.collateralLocked;
        deposited[c.bundler] -= c.collateralLocked; // T8: slash -- deliberate SLA miss is net-negative for BUNDLER

        // A2: client receives full feePerOp + full collateral.
        uint256 userTotal = uint256(c.feePaid) + uint256(c.collateralLocked);
        pendingWithdrawals[c.user] += userTotal;

        emit Refunded(commitId, userTotal);
    }

    // -- pull: claim payout ----------------------------------------------------

    /// @notice Withdraw any ETH owed to msg.sender, sending to an explicit recipient.
    ///         Use this when msg.sender is a smart contract that cannot receive ETH directly.
    ///         T7/T13/T14/T19: pull pattern -- PROTOCOL cannot block payouts; every terminal
    ///         commit state has a claimable path.
    function claimPayoutTo(address payable to) public nonReentrant {
        if (to == address(0)) revert ZeroAddress("to");
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount < 1) revert NothingToClaim();
        // CEI: clear before transfer
        pendingWithdrawals[msg.sender] = 0;
        reservedBalance -= amount;
        emit PayoutClaimed(msg.sender, amount);
        to.sendValue(amount);
    }

    /// @notice Withdraw any ETH owed to msg.sender. Convenience wrapper for claimPayoutTo.
    function claimPayout() external {
        claimPayoutTo(payable(msg.sender));
    }

    /// @notice Sweep any ETH sent outside the normal deposit/fee flow (e.g., selfdestruct).
    ///         Uses the pull model: queues excess into feeRecipient's pendingWithdrawals.
    function sweepExcess() external onlyOwner {
        if (address(this).balance <= reservedBalance) return;
        uint256 excess = address(this).balance - reservedBalance;
        reservedBalance += excess;
        pendingWithdrawals[feeRecipient] += excess;
        emit ExcessSwept(feeRecipient, excess);
    }

    // -- view ------------------------------------------------------------------

    /// @notice Returns how much collateral a bundler can lock or withdraw right now.
    function idleBalance(address bundler) public view returns (uint256) {
        return deposited[bundler] - lockedOf[bundler];
    }

    /// @notice Batch idle-balance query for off-chain callers (e.g. QuoteRegistry.listRoutable).
    function idleBalanceBatch(address[] calldata bundlers)
        external view returns (uint256[] memory balances)
    {
        balances = new uint256[](bundlers.length);
        for (uint256 i = 0; i < bundlers.length; ++i) {
            balances[i] = idleBalance(bundlers[i]);
        }
    }

    /// @notice Returns the implementation version. Bumped on each upgrade.
    function version() external pure returns (string memory) {
        return "0.8";
    }

    /// @notice Read core identity/financial fields of a commit.
    ///         Split from the full struct to avoid a 14-tuple ABI encoder stack overflow
    ///         when the compiler generates the auto-getter for the commits mapping.
    function getCommitCore(uint256 id) external view returns (
        address user,
        uint96  feePaid,
        address bundler,
        uint96  collateralLocked,
        uint64  deadline,
        bool    settled,
        bool    refunded
    ) {
        Commit storage c = commits[id];
        return (c.user, c.feePaid, c.bundler, c.collateralLocked, c.deadline, c.settled, c.refunded);
    }

    /// @notice Read lifecycle/state fields of a commit.
    ///         Pair this with getCommitCore() to read the full Commit struct.
    function getCommitState(uint256 id) external view returns (
        uint256 quoteId,
        bytes32 userOpHash,
        uint64  inclusionBlock,
        bool    accepted,
        bool    cancelled,
        uint64  acceptDeadline,
        uint32  slaBlocks
    ) {
        Commit storage c = commits[id];
        return (c.quoteId, c.userOpHash, c.inclusionBlock, c.accepted, c.cancelled, c.acceptDeadline, c.slaBlocks);
    }

    /// @notice Read the full Commit struct as a memory value.
    ///         Returns all 14 fields without stack overflow because the compiler copies the
    ///         struct to memory first rather than placing all fields on the stack individually.
    ///         Use this in off-chain tooling and tests; use getCommitCore / getCommitState in
    ///         CVL specs where tuple-arity limits apply.
    function getCommit(uint256 id) external view returns (Commit memory) {
        return commits[id];
    }

    // -- internal --------------------------------------------------------------

    /// @dev Validate a candidate registry address before assigning it.
    ///      Goal: prevent accidental mis-wiring and split-governance configurations.
    ///      Goal is NOT trustlessness -- a governance-approved registry can still return
    ///      dishonest offers; the owner() check only ensures both contracts share the same
    ///      TimelockController.
    ///
    ///      Deployment constraint: at initialize() time, owner() == msg.sender, so the registry
    ///      must also be owned by msg.sender. Both contracts are typically deployed under the
    ///      deployer EOA and transferred to the TimelockController together.
    ///
    ///      Called from initialize() (after __Ownable_init) and setRegistry().
    function _validateRegistry(address newRegistry) internal view {
        if (newRegistry == address(0))    revert ZeroAddress("registry");
        if (newRegistry == address(this)) revert RegistrySelfReference();
        if (newRegistry.code.length == 0) revert InvalidRegistry(newRegistry);

        // Interface fingerprint: rejects any contract not explicitly declaring compatibility.
        (bool okVer, bytes memory retVer) =
            newRegistry.staticcall(abi.encodeWithSignature("registryInterfaceVersion()"));
        if (!okVer || retVer.length < 32 || abi.decode(retVer, (bytes32)) != REGISTRY_INTERFACE_VERSION)
            revert InvalidRegistry(newRegistry);

        // Governance alignment: both contracts must share the same owner (TimelockController).
        // Separates ABI failure (InvalidRegistry) from value mismatch (RegistryGovernanceMismatch).
        (bool okOwner, bytes memory retOwner) =
            newRegistry.staticcall(abi.encodeWithSignature("owner()"));
        if (!okOwner || retOwner.length < 32)               revert InvalidRegistry(newRegistry);
        if (abi.decode(retOwner, (address)) != owner())     revert RegistryGovernanceMismatch();

        // SLA bounds: registry cap must match the escrow constant used in commit().
        (bool okSla, bytes memory retSla) =
            newRegistry.staticcall(abi.encodeWithSignature("MAX_SLA_BLOCKS()"));
        if (!okSla || retSla.length < 32)                   revert InvalidRegistry(newRegistry);
        if (abi.decode(retSla, (uint32)) != MAX_SLA_BLOCKS) revert RegistrySlaBoundsMismatch();

        // ABI smoke tests: confirm the interface commit() depends on is present and
        // returns a correctly shaped Offer tuple. QuoteRegistry.Offer has 8 fields,
        // so the ABI-encoded return must be at least 256 bytes (8 × 32). A registry
        // that returns the right selector but a truncated or malformed blob would
        // pass the non-revert check but break abi.decode inside commit().
        (bool okOffer, bytes memory retOffer) =
            newRegistry.staticcall(abi.encodeWithSignature("getOffer(uint256)", 0));
        if (!okOffer || retOffer.length < 256) revert InvalidRegistry(newRegistry);

        (bool okActive, bytes memory retActive) =
            newRegistry.staticcall(abi.encodeWithSignature("isActive(uint256)", 0));
        if (!okActive || retActive.length < 32) revert InvalidRegistry(newRegistry);
    }

    /// @dev Full A10 execution proof verification pipeline. Reverts with InvalidInclusionProof
    ///      for explicit verification failures; malformed proof data may also bubble
    ///      library decoding errors from RLPReader / MerkleTrie.
    function _verifyReceiptProof(
        uint256          commitId,
        bytes32          userOpHash,
        uint64           inclusionBlock,
        bytes   calldata blockHeaderRlp,
        bytes[] calldata receiptProof,
        uint256          txIndex
    ) private view {
        // Step 1: block header must hash to the known on-chain blockhash.
        if (keccak256(blockHeaderRlp) != blockhash(inclusionBlock))
            revert InvalidInclusionProof(commitId);

        // Step 2: extract receiptsRoot from block header field index 5.
        //         Block header RLP list fields (post-merge, all networks including Base):
        //         [0] parentHash  [1] ommersHash  [2] coinbase  [3] stateRoot
        //         [4] txsRoot     [5] receiptsRoot  [6] logsBloom  ...
        RLPReader.RLPItem[] memory hf = RLPReader.toRlpItem(bytes(blockHeaderRlp)).toList();
        if (hf.length < 6) revert InvalidInclusionProof(commitId);
        bytes32 receiptsRoot = hf[5].toBytes32();

        // Step 3: MPT proof -- key = RLP(txIndex), value = receipt RLP bytes.
        bytes memory receiptRlp = MerkleTrie.get(
            _rlpUint(txIndex),
            _toMemory(receiptProof),
            receiptsRoot
        );

        // Step 4: scan receipt logs for UserOperationEvent from entryPoint.
        if (!_hasUserOpEvent(userOpHash, receiptRlp))
            revert InvalidInclusionProof(commitId);
    }

    /// @dev Parse `receiptRlp` (EIP-2718 typed or legacy) and return true if it contains
    ///      a UserOperationEvent log from entryPoint with topic[1] == userOpHash.
    function _hasUserOpEvent(bytes32 userOpHash, bytes memory receiptRlp)
        private
        view
        returns (bool)
    {
        if (receiptRlp.length == 0) return false;

        // EIP-2718 typed receipts: first byte is the type (0x01 or 0x02), not an RLP prefix.
        // Legacy receipts start with an RLP list prefix (0xc0-0xff).
        uint256 startAt = uint8(receiptRlp[0]) < 0x80 ? 1 : 0;

        bytes memory rlp;
        if (startAt == 0) {
            rlp = receiptRlp;
        } else {
            uint256 remaining = receiptRlp.length - 1;
            rlp = new bytes(remaining);
            assembly { mcopy(add(rlp, 0x20), add(add(receiptRlp, 0x20), 1), remaining) }
        }

        // Receipt RLP: [status, cumulativeGasUsed, logsBloom, logs[]]
        RLPReader.RLPItem[] memory fields = RLPReader.toRlpItem(rlp).toList();
        if (fields.length < 4) return false;

        // Iterate logs: each log is [emitterAddress, topics[], data]
        RLPReader.RLPItem[] memory logs = fields[3].toList();
        for (uint256 i; i < logs.length; i++) {
            RLPReader.RLPItem[] memory log = logs[i].toList();
            if (log.length < 2) continue;
            if (log[0].toAddress() != entryPoint) continue;

            RLPReader.RLPItem[] memory topics = log[1].toList();
            if (topics.length < 2) continue;
            if (topics[0].toBytes32() != USER_OP_EVENT_TOPIC) continue;
            if (topics[1].toBytes32() == userOpHash) {
                // A1: UserOperationEvent.success must be true -- a reverted op
                //     cannot be settled. handleOps() does not revert on callData
                //     failure; it emits success=false and still charges gas.
                // ABI layout (non-indexed data): nonce=data[0:32], success=data[32:64]
                if (log.length < 3) continue;
                bytes memory logData = log[2].toBytes();
                if (logData.length < 64) continue;
                uint256 successWord;
                assembly { successWord := mload(add(logData, 0x40)) }
                if (successWord == 0) continue;
                return true;
            }
        }
        return false;
    }

    /// @dev RLP-encode a uint256 as compact big-endian bytes (no leading zeros).
    ///      Used to build the MPT key for the receipt trie: key = rlp(txIndex).
    function _rlpUint(uint256 v) private pure returns (bytes memory) {
        if (v == 0)    return hex"80";
        if (v < 0x80)  return abi.encodePacked(uint8(v));

        uint256 byteLen = 0;
        uint256 tmp = v;
        while (tmp > 0) { tmp >>= 8; byteLen++; }

        bytes memory out = new bytes(1 + byteLen);
        out[0] = bytes1(uint8(0x80 + byteLen));
        tmp = v;
        for (uint256 i = byteLen; i > 0; i--) {
            out[i] = bytes1(uint8(tmp & 0xff));
            tmp >>= 8;
        }
        return out;
    }

    /// @dev Copy a calldata bytes[] into memory so it can be passed to the library.
    function _toMemory(bytes[] calldata arr) private pure returns (bytes[] memory mem) {
        mem = new bytes[](arr.length);
        for (uint256 i; i < arr.length; i++) mem[i] = arr[i];
    }

    /// @dev Internal settle logic. Called from the 5-arg settle() (after proof) and from
    ///      SLAEscrowTestable.settle(uint256) (proof-free, test only).
    ///      Permissionless: fee always goes to c.bundler (the snapshotted address).
    function _settle(uint256 commitId) internal {
        Commit storage c = commits[commitId];
        if (c.user == address(0))               revert CommitNotFound(commitId);
        if (!c.accepted)                        revert CommitNotActive(commitId);
        if (c.settled || c.refunded || c.cancelled) revert AlreadyFinalized(commitId);
        if (block.number > c.deadline + SETTLEMENT_GRACE_BLOCKS)
            revert DeadlinePassed(commitId, c.deadline, uint64(block.number));
        // T1/T23: retire hash permanently -- prevents double-payment and forces fresh hash on retry.
        if (retiredHashes[c.userOpHash]) revert UserOpHashRetired(c.userOpHash);
        retiredHashes[c.userOpHash] = true;

        c.settled = true;
        activeCommitForHash[c.userOpHash] = false;
        lockedOf[c.bundler] -= c.collateralLocked;

        // T1/A4: bundler receives full feePerOp; protocol fee was already taken at commit time; no ETH created or destroyed.
        pendingWithdrawals[c.bundler] += uint256(c.feePaid);

        emit Settled(commitId, uint256(c.feePaid));
    }

}
