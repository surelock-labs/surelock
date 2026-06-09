// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";

contract OfferRegistryTest is Test {
    OfferRegistry reg;
    address provider = address(0xCAFE);

    event OfferRegistered(
        uint256 indexed offerId,
        address indexed provider,
        uint256 feePerOp,
        uint256 collateral,
        uint256 slaBlocks,
        uint256 expiresAt
    );

    function setUp() public {
        reg = new OfferRegistry();
    }

    function testInitialNextOfferIdIsOne() public view {
        assertEq(reg.nextOfferId(), 1);
    }

    function testRegisterStoresOffer() public {
        uint256 lifetime = reg.MIN_LIFETIME();

        vm.expectEmit(true, true, false, true, address(reg));
        emit OfferRegistered(1, provider, 0.01 ether, 0.03 ether, 20, block.number + lifetime);

        vm.prank(provider);
        uint256 offerId = reg.register(0.01 ether, 20, 0.03 ether, lifetime);

        OfferRegistry.Offer memory offer = reg.getOffer(offerId);
        assertEq(offer.provider, provider);
        assertEq(offer.slaBlocks, 20);
        assertEq(offer.feePerOp, 0.01 ether);
        assertEq(offer.collateral, 0.03 ether);
        assertEq(offer.expiresAt, block.number + lifetime);
        assertTrue(reg.exists(offerId));
        assertTrue(reg.isActive(offerId));
        assertEq(reg.nextOfferId(), 2);
    }

    function testDeregisterDeletesOffer() public {
        uint256 lifetime = reg.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = reg.register(0.01 ether, 20, 0.03 ether, lifetime);
        reg.deregister(offerId);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(OfferRegistry.OfferNotFound.selector, offerId));
        reg.getOffer(offerId);

        assertFalse(reg.exists(offerId));
        assertFalse(reg.isActive(offerId));
    }

    function testGetOfferRevertsWhenMissing() public {
        vm.expectRevert(abi.encodeWithSelector(OfferRegistry.OfferNotFound.selector, 42));
        reg.getOffer(42);
    }

    function testRenewExtendsOffer() public {
        uint256 minLifetime = reg.MIN_LIFETIME();
        uint256 maxLifetime = reg.MAX_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = reg.register(0.01 ether, 20, 0.03 ether, minLifetime);
        vm.roll(100);
        reg.renew(offerId, maxLifetime);
        vm.stopPrank();

        OfferRegistry.Offer memory offer = reg.getOffer(offerId);
        assertEq(offer.expiresAt, block.number + maxLifetime);
        assertTrue(reg.isActive(offerId));
    }
}
