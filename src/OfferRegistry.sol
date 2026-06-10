// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.35;

contract OfferRegistry {
    uint256 public constant MIN_SLA_BLOCKS = 1;
    uint256 public constant MAX_SLA_BLOCKS = 1_000;
    uint256 public constant MIN_LIFETIME = 10_000;
    uint256 public constant MAX_LIFETIME = 1_000_000;
    uint256 public constant MAX_PAGE_SIZE = 100;

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

    mapping(uint256 => Offer) internal offers;
    uint256 public nextOfferId = 1;

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

    error OfferNotFound(uint256 offerId);
    error NotOfferOwner(uint256 offerId, address caller);
    error InvalidSlaBlocks(uint256 value, uint256 min, uint256 max);
    error InvalidFee(uint256 value);
    error InvalidCollateral(uint256 collateral, uint256 feePerOp);
    error InvalidLifetime(uint256 value, uint256 min, uint256 max);
    error InvalidOfferPage(uint256 startOfferId, uint256 count, uint256 maxPageSize);

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
        if (offer.provider == address(0)) revert OfferNotFound(offerId);
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

    function _isActive(Offer storage offer) internal view returns (bool) {
        return offer.provider != address(0) && !offer.disabled && block.number <= offer.expiresAt;
    }
}
