// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";

interface IIdleBalanceBatch {
    function idleBalanceBatch(address[] calldata bundlers) external view returns (uint256[] memory);
}

/// @title QuoteRegistry
/// @notice Bundlers post service offers with a registration bond and TTL.
///         Offers expire after `lifetime` blocks and can be renewed by the bundler.
///         States are derived from (bond, registeredAt, lifetime, block.number) -- no stored boolean.
/// @dev    State model:
///           NOT_EXIST:    registeredAt == 0
///           ACTIVE:       bond > 0 && block.number <= registeredAt + lifetime
///           EXPIRED:      bond > 0 && block.number > registeredAt + lifetime
///           DEREGISTERED: registeredAt > 0 && bond == 0 (terminal)
contract QuoteRegistry is Ownable, ReentrancyGuard {
    using Address for address payable;

    // ---------------------------- Struct -------------------------------------

    /// @notice External Offer struct returned by view functions. Includes quoteId
    ///         (not stored in contract storage -- injected at read time, OPT-2).
    struct Offer {
        uint256 quoteId;        // injected by view functions (not stored)
        address bundler;        // 20 bytes -- slot 0
        uint32  slaBlocks;      //  4 bytes -- slot 0
        uint32  lifetime;       //  4 bytes -- slot 0 (uint32 safe: MAX_LIFETIME < uint32.max)
        uint128 feePerOp;       // 16 bytes -- slot 1
        uint128 collateralWei;  // 16 bytes -- slot 1
        uint64  registeredAt;   //  8 bytes -- slot 2
        uint96  bond;           // 12 bytes -- slot 2
    }

    /// @dev Internal storage struct -- same layout minus quoteId (OPT-2).
    ///      feePerOp and collateralWei are stored as uint128 for packing efficiency,
    ///      but register() enforces <= uint96.max on both to stay compatible with
    ///      SLAEscrow.Commit.feePaid / collateralLocked (uint96 fields).
    struct StoredOffer {
        // slot 0: 20 + 4 + 4 = 28 bytes (4 bytes free)
        address bundler;
        uint32  slaBlocks;
        uint32  lifetime;
        // slot 1: 16 + 16 = 32 bytes (values capped at uint96.max by register())
        uint128 feePerOp;
        uint128 collateralWei;
        // slot 2: 8 + 12 = 20 bytes (12 bytes free)
        uint64  registeredAt;
        uint96  bond;
    }

    // ---------------------------- Constants ----------------------------------

    /// @notice Minimum registration bond. setBond() cannot go below this.
    uint256 public constant MIN_BOND = 0.0001 ether;

    /// @notice Maximum registration bond -- stored as uint96 in Offer.bond.
    ///         Capped at 10 ETH: a realistic signal-of-intent ceiling. Prevents the registry
    ///         from being used as a parking vault and keeps honest bundler entry costs bounded.
    ///         See docs/DESIGN.md T24.
    uint256 public constant MAX_BOND = 10 ether;

    /// @notice Maximum SLA window: 1 000 blocks (~33 min on Base at 2s/block).
    ///         Matches SLAEscrow.MAX_SLA_BLOCKS -- keeps offer registration and commit
    ///         in sync so registered offers are always committable.
    uint32 public constant MAX_SLA_BLOCKS = 1_000;

    /// @notice Minimum offer lifetime: 302 400 blocks (~7 days on Base at 2s/block).
    uint32 public constant MIN_LIFETIME = 302_400;

    /// @notice Maximum offer lifetime: 3 888 000 blocks (~90 days on Base at 2s/block).
    uint32 public constant MAX_LIFETIME = 3_888_000;

    // ---------------------------- State --------------------------------------

    /// @notice Core registry. quoteId is the mapping key (not stored in struct).
    mapping(uint256 => StoredOffer) internal _offers;

    /// @notice Pull-based bond payout; all bond returns flow through this mapping.
    mapping(address => uint256) public pendingBonds;

    /// @notice Current ETH required to register an offer.
    uint256 public registrationBond;

    /// @notice Monotonically increasing quote counter. Starts at 1 (0 is reserved sentinel).
    uint256 public nextQuoteId;

    /// @notice Running sum of ETH owed to bundlers (offer bonds + pendingBonds).
    ///         Invariant: address(this).balance >= totalTracked at all times.
    uint256 public totalTracked;

    // ---------------------------- Events -------------------------------------

    /// @notice Emitted when a new offer is registered.
    /// @param expiry registeredAt + lifetime -- indexers track TTL from events.
    event OfferRegistered(uint256 indexed quoteId, address indexed bundler, uint64 expiry);

    /// @notice Emitted when an offer is deregistered (voluntary or expired).
    /// @param reason 0 = voluntary (deregister), 1 = expired (deregisterExpired).
    event OfferDeactivated(uint256 indexed quoteId, address indexed bundler, uint8 reason);

    /// @notice Emitted when an offer's TTL is renewed.
    /// @param newExpiry new registeredAt + lifetime.
    event OfferRenewed(uint256 indexed quoteId, address indexed bundler, uint64 newExpiry);

    /// @notice Emitted when the registration bond is changed by the owner.
    event BondUpdated(uint256 oldBond, uint256 newBond);

    /// @notice Emitted when a bundler successfully claims their pending bond.
    event BondClaimed(address indexed bundler, uint256 amount);

    // ---------------------------- Errors -------------------------------------

    error IncorrectBond(uint256 required, uint256 sent);
    error OfferNotFound(uint256 quoteId);
    error NotOfferOwner(uint256 quoteId, address caller);
    error AlreadyDeregistered(uint256 quoteId);
    error NotExpired(uint256 quoteId);
    error AlreadyExpired(uint256 quoteId);

    error ValueTooLarge(string param, uint256 value);
    error NoBondPending();
    error ZeroAddress(string param);
    error RenounceOwnershipDisabled();
    error InvalidEscrow(address escrow);

    // ---------------------------- Constructor --------------------------------

    /// @param owner_       Initial owner address (deployer EOA at deploy time; must be transferred to
    ///                     TimelockController before mainnet handover -- see DESIGN.md T22).
    /// @param _initialBond Initial registration bond in wei. Must be in [MIN_BOND, MAX_BOND].
    constructor(address owner_, uint256 _initialBond) Ownable(owner_) {
        require(_initialBond >= MIN_BOND, "initialBond < MIN_BOND");
        require(_initialBond <= MAX_BOND, "initialBond > MAX_BOND");
        registrationBond = _initialBond;
        nextQuoteId = 1; // 0 is reserved as "no offer" sentinel
    }

    // ---------------------------- Ownership guard -----------------------------

    /// @notice Disabled -- renouncing ownership would permanently brick admin functions.
    ///         docs/DESIGN.md T22 requires owner to remain non-zero on both contracts.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    // ---------------------------- Admin --------------------------------------

    /// @notice Update the registration bond for future registrations. Does not affect existing offers.
    /// @param newBond New bond amount in wei. Must be in [MIN_BOND, MAX_BOND].
    function setBond(uint256 newBond) external onlyOwner {
        require(newBond >= MIN_BOND, "newBond < MIN_BOND");
        require(newBond <= MAX_BOND, "newBond > MAX_BOND");
        emit BondUpdated(registrationBond, newBond);
        registrationBond = newBond;
    }

    /// @notice Recover ETH sent outside the normal register() path (e.g. selfdestruct).
    ///         Sends excess (balance - totalTracked) to the owner. No-op if nothing to sweep.
    function sweepExcess() external onlyOwner {
        if (address(this).balance <= totalTracked) return;
        uint256 excess = address(this).balance - totalTracked;
        payable(owner()).sendValue(excess);
    }

    // ---------------------------- Register -----------------------------------

    /// @notice Register a new bundler offer. Caller becomes the offer's bundler.
    /// @param feePerOp      Max fee per UserOp in wei. Must be > 0 and <= uint96.max.
    /// @param slaBlocks     SLA window in blocks. Must be > 0 and <= MAX_SLA_BLOCKS.
    /// @param collateralWei Operational bond per commit in wei. Must be > feePerOp and <= uint96.max.
    /// @param lifetime      TTL in blocks. Must be in [MIN_LIFETIME, MAX_LIFETIME].
    /// @return quoteId      The assigned offer ID.
    function register(
        uint256 feePerOp,
        uint32  slaBlocks,
        uint256 collateralWei,
        uint32  lifetime
    ) external payable returns (uint256 quoteId) {
        if (msg.value != registrationBond) revert IncorrectBond(registrationBond, msg.value);
        require(slaBlocks > 0,              "slaBlocks must be > 0");
        require(slaBlocks <= MAX_SLA_BLOCKS, "slaBlocks exceeds MAX_SLA_BLOCKS");
        require(feePerOp > 0,            "feePerOp must be > 0");
        if (feePerOp  > type(uint96).max) revert ValueTooLarge("feePerOp",  feePerOp);
        if (collateralWei > type(uint96).max) revert ValueTooLarge("collateralWei", collateralWei);
        require(collateralWei > feePerOp,  "collateralWei must be > feePerOp");  // T8: self-slash must be strictly net-negative
        require(lifetime >= MIN_LIFETIME,    "lifetime < MIN_LIFETIME");
        require(lifetime <= MAX_LIFETIME,    "lifetime > MAX_LIFETIME");

        quoteId = nextQuoteId++;
        _offers[quoteId] = StoredOffer({
            bundler:       msg.sender,
            slaBlocks:     slaBlocks,
            lifetime:      lifetime,
            feePerOp:      uint128(feePerOp),
            collateralWei: uint128(collateralWei),
            registeredAt:  uint64(block.number),
            bond:          uint96(msg.value)
        });

        totalTracked += msg.value;

        emit OfferRegistered(quoteId, msg.sender, uint64(block.number) + uint64(lifetime));
    }

    // ---------------------------- Deregister ---------------------------------

    /// @notice Voluntarily deregister an offer. Bundler only. Valid from ACTIVE or EXPIRED state.
    ///         Bond is moved to pendingBonds; withdraw via claimBond().
    /// @param quoteId The offer to deregister.
    function deregister(uint256 quoteId) external nonReentrant {
        StoredOffer storage o = _offers[quoteId];
        if (o.registeredAt == 0)        revert OfferNotFound(quoteId);
        if (o.bond == 0)                revert AlreadyDeregistered(quoteId);
        if (o.bundler != msg.sender)    revert NotOfferOwner(quoteId, msg.sender);

        // Pull-only: move bond to pending, no external call (CEI-compliant)
        uint256 bondAmount = uint256(o.bond);
        o.bond = 0;
        pendingBonds[msg.sender] += bondAmount;

        emit OfferDeactivated(quoteId, msg.sender, 0);
    }

    // ---------------------------- Deregister expired -------------------------

    /// @notice Permissionless cleanup of an expired offer. Bond is moved to pendingBonds;
    ///         bundler withdraws via claimBond(). Anyone can call this for EXPIRED offers.
    /// @param quoteId The expired offer to deregister.
    function deregisterExpired(uint256 quoteId) external nonReentrant {
        StoredOffer storage o = _offers[quoteId];
        if (o.registeredAt == 0)        revert OfferNotFound(quoteId);
        if (o.bond == 0)                revert AlreadyDeregistered(quoteId);
        if (block.number <= uint256(o.registeredAt) + uint256(o.lifetime))
            revert NotExpired(quoteId);

        address bundler = o.bundler;
        if (bundler == address(0))      revert OfferNotFound(quoteId); // H-1: defensive guard

        // Pull-only: move bond to pending, no external call (CEI-compliant)
        uint256 bondAmount = uint256(o.bond);
        o.bond = 0;
        pendingBonds[bundler] += bondAmount;

        emit OfferDeactivated(quoteId, bundler, 1);
    }

    // ---------------------------- Renew --------------------------------------

    /// @notice Renew an ACTIVE offer's TTL. Bundler only. Resets registeredAt to block.number.
    ///         EXPIRED offers cannot be renewed (one-way door).
    /// @param quoteId The offer to renew.
    function renew(uint256 quoteId) external {
        StoredOffer storage o = _offers[quoteId];
        if (o.registeredAt == 0)        revert OfferNotFound(quoteId);
        if (o.bond == 0)                revert AlreadyDeregistered(quoteId);
        if (o.bundler != msg.sender)    revert NotOfferOwner(quoteId, msg.sender);
        if (block.number > uint256(o.registeredAt) + uint256(o.lifetime))
            revert AlreadyExpired(quoteId);

        o.registeredAt = uint64(block.number);

        emit OfferRenewed(quoteId, msg.sender, uint64(block.number) + uint64(o.lifetime));
    }

    // ---------------------------- Claim bond ---------------------------------

    /// @notice Pull-based bond recovery, sending to an explicit recipient.
    ///         Use this when msg.sender is a smart contract that cannot receive ETH directly.
    function claimBondTo(address payable to) public nonReentrant {
        if (to == address(0)) revert ZeroAddress("to");
        uint256 amount = pendingBonds[msg.sender];
        if (amount == 0) revert NoBondPending();

        // CEI: zero state and decrement totalTracked before transfer
        pendingBonds[msg.sender] = 0;
        totalTracked -= amount;

        emit BondClaimed(msg.sender, amount);
        to.sendValue(amount);
    }

    /// @notice Pull-based bond recovery to msg.sender. Convenience wrapper for claimBondTo.
    function claimBond() external {
        claimBondTo(payable(msg.sender));
    }

    // ---------------------------- View functions -----------------------------

    /// @notice Interface fingerprint used by SLAEscrow._validateRegistry() to confirm the
    ///         target is a compatible QuoteRegistry implementation before accepting it.
    ///         Bump the version string on any breaking interface change.
    function registryInterfaceVersion() external pure returns (bytes32) {
        return keccak256("SureLockQuoteRegistry:v1");
    }

    /// @notice Returns true iff the offer is ACTIVE: bond > 0 and not expired.
    ///         Used by SLAEscrow.commit() to verify an offer before accepting a commitment.
    /// @param quoteId The offer to check.
    /// @return True if the offer is currently active.
    function isActive(uint256 quoteId) external view returns (bool) {
        StoredOffer storage o = _offers[quoteId];
        return o.bond > 0 && block.number <= uint256(o.registeredAt) + uint256(o.lifetime);
    }

    /// @notice Returns a single offer by quoteId (including inactive/deregistered).
    ///         Returns zero-initialized struct for non-existent quoteIds.
    /// @param quoteId The offer to retrieve.
    /// @return offer The offer with quoteId injected.
    function getOffer(uint256 quoteId) external view returns (Offer memory offer) {
        StoredOffer storage o = _offers[quoteId];
        offer = Offer({
            quoteId:       quoteId,
            bundler:       o.bundler,
            slaBlocks:     o.slaBlocks,
            lifetime:      o.lifetime,
            feePerOp:      o.feePerOp,
            collateralWei: o.collateralWei,
            registeredAt:  o.registeredAt,
            bond:          o.bond
        });
    }

    /// @notice Returns all currently ACTIVE offers (bond > 0, not expired).
    /// @dev    O(n) over all registered offers. For large registries, use listActivePage().
    function list() external view returns (Offer[] memory active) {
        uint256 total = nextQuoteId;
        uint256 count = 0;
        for (uint256 i = 1; i < total; ++i) {
            if (_isActiveInternal(i)) ++count;
        }
        active = new Offer[](count);
        uint256 j = 0;
        for (uint256 i = 1; i < total; ++i) {
            if (_isActiveInternal(i)) {
                active[j++] = _toOffer(i);
            }
        }
    }

    /// @notice Paginated view of ACTIVE offers only, by quoteId range.
    ///         May return fewer than `limit` results if some quoteIds in range are not active.
    ///         End-of-data: use `offset >= nextQuoteId`, not returned length.
    /// @param offset First quoteId to include (inclusive). Use >= 1 (0 is sentinel).
    /// @param limit  Maximum number of offers to scan.
    /// @return page  Active offers in [offset, offset+limit) range.
    function listActivePage(uint256 offset, uint256 limit) external view returns (Offer[] memory page) {
        uint256 total = nextQuoteId;
        if (offset >= total || offset == 0) return new Offer[](0);
        uint256 end = (limit > total - offset) ? total : offset + limit;

        // Count active in range
        uint256 count = 0;
        for (uint256 i = offset; i < end; ++i) {
            if (_isActiveInternal(i)) ++count;
        }
        page = new Offer[](count);
        uint256 j = 0;
        for (uint256 i = offset; i < end; ++i) {
            if (_isActiveInternal(i)) {
                page[j++] = _toOffer(i);
            }
        }
    }

    /// @notice Paginated view over ALL offers (active + expired + deregistered) by quoteId range.
    ///         Callers can filter by state off-chain using registeredAt, lifetime, and bond.
    /// @param offset First quoteId to include (inclusive). Use >= 1 (0 is sentinel).
    /// @param limit  Maximum number of offers to return. Capped to remaining offers.
    /// @return page  Slice of offers in [offset, offset+limit) range.
    function listPage(uint256 offset, uint256 limit) external view returns (Offer[] memory page) {
        uint256 total = nextQuoteId;
        if (offset >= total || offset == 0) return new Offer[](0);
        uint256 end = (limit > total - offset) ? total : offset + limit;
        page = new Offer[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _toOffer(i);
        }
    }

    /// @notice Returns ACTIVE offers that also have sufficient idle collateral in the escrow.
    /// @dev    O(n) over all registered offers -- intended for off-chain use via eth_call only.
    ///         Will revert on-chain with large registries due to gas limits. For paginated
    ///         access use list() + listActivePage() and filter idle balances client-side.
    ///         Per-offer point-in-time filter only: if a bundler has multiple offers each
    ///         requiring X collateral and idle balance == X, all of them will be returned,
    ///         even though only one can be accepted at a time. Routers should collapse
    ///         offers by bundler or apply their own capacity accounting.
    /// @param escrow Address of SLAEscrow contract.
    /// @return routable Active offers where escrow.idleBalance(bundler) >= collateralWei.
    function listRoutable(address escrow) external view returns (Offer[] memory routable) {
        require(escrow != address(0), "escrow is zero address");
        uint256 total = nextQuoteId;

        // Pass 1: collect bundlers for all slots (no external calls)
        address[] memory bundlers = new address[](total > 1 ? total - 1 : 0);
        bool[]    memory active   = new bool[](bundlers.length);
        for (uint256 i = 1; i < total; ++i) {
            active[i - 1]   = _isActiveInternal(i);
            bundlers[i - 1] = _offers[i].bundler;
        }

        // Single external call -- fetch all balances at once
        uint256[] memory balances = _batchIdleBalance(escrow, bundlers);

        // Pass 2: count + build result (no external calls)
        uint256 count = 0;
        for (uint256 i = 0; i < bundlers.length; ++i) {
            if (active[i] && balances[i] >= uint256(_offers[i + 1].collateralWei)) ++count;
        }
        routable = new Offer[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < bundlers.length; ++i) {
            if (active[i] && balances[i] >= uint256(_offers[i + 1].collateralWei)) {
                routable[j++] = _toOffer(i + 1);
            }
        }
    }

    /// @notice Count of ACTIVE offers. Gas-efficient alternative to list().length.
    function activeCount() external view returns (uint256 count) {
        uint256 total = nextQuoteId;
        for (uint256 i = 1; i < total; ++i) {
            if (_isActiveInternal(i)) ++count;
        }
    }

    // ---------------------------- Internal helpers ---------------------------

    /// @dev Checks if offer at quoteId is ACTIVE. Same logic as isActive() but internal.
    function _isActiveInternal(uint256 quoteId) internal view returns (bool) {
        StoredOffer storage o = _offers[quoteId];
        return o.bond > 0 && block.number <= uint256(o.registeredAt) + uint256(o.lifetime);
    }

    /// @dev Converts a stored offer to the external Offer struct with quoteId injected.
    function _toOffer(uint256 quoteId) internal view returns (Offer memory) {
        StoredOffer storage o = _offers[quoteId];
        return Offer({
            quoteId:       quoteId,
            bundler:       o.bundler,
            slaBlocks:     o.slaBlocks,
            lifetime:      o.lifetime,
            feePerOp:      o.feePerOp,
            collateralWei: o.collateralWei,
            registeredAt:  o.registeredAt,
            bond:          o.bond
        });
    }

    /// @dev Calls SLAEscrow.idleBalanceBatch(bundlers) via typed interface -- single round-trip.
    ///      Short-circuits for empty input. Reverts InvalidEscrow if escrow has no code,
    ///      the call fails, or it returns an unexpected array length.
    function _batchIdleBalance(address escrow, address[] memory bundlers)
        internal view returns (uint256[] memory)
    {
        if (bundlers.length < 1) return new uint256[](0);
        // Code-size check prevents ABI-decode bypass: STATICCALL to an EOA returns ok=true
        // with empty data, which would propagate past catch as a bare revert.
        if (escrow.code.length == 0) revert InvalidEscrow(escrow);
        try IIdleBalanceBatch(escrow).idleBalanceBatch(bundlers) returns (uint256[] memory out) {
            if (out.length != bundlers.length) revert InvalidEscrow(escrow);
            return out;
        } catch {
            revert InvalidEscrow(escrow);
        }
    }
}
