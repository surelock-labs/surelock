// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.35;

contract OfferRegistry {
    uint256 public constant MIN_SLA_BLOCKS = 1;
    uint256 public constant MAX_SLA_BLOCKS = 1_000;
    uint256 public constant MIN_LIFETIME = 10_000;
    uint256 public constant MAX_LIFETIME = 1_000_000;

    struct Offer {
        address provider;
        uint256 feePerOp;
        uint256 collateral;
        uint256 slaBlocks;
        uint256 expiresAt;
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
            feePerOp: feePerOp,
            collateral: collateral,
            slaBlocks: slaBlocks,
            expiresAt: block.number + lifetime
        });

        emit OfferRegistered(offerId, msg.sender, feePerOp, collateral, slaBlocks, block.number + lifetime);
    }

    function deregister(uint256 offerId) external {
        Offer storage offer = offers[offerId];
        if (offer.provider == address(0)) revert OfferNotFound(offerId);
        if (offer.provider != msg.sender) revert NotOfferOwner(offerId, msg.sender);

        delete offers[offerId];

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

        emit OfferRenewed(offerId, msg.sender, offer.expiresAt);
    }

    function isActive(uint256 offerId) external view returns (bool) {
        Offer storage offer = offers[offerId];
        return offer.provider != address(0) && block.number <= offer.expiresAt;
    }

    function exists(uint256 offerId) external view returns (bool) {
        return offers[offerId].provider != address(0);
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        Offer storage offer = offers[offerId];
        if (offer.provider == address(0)) revert OfferNotFound(offerId);

        return offer;
    }
}
