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
        assertFalse(offer.disabled);
        assertEq(offer.slaBlocks, 20);
        assertEq(offer.feePerOp, 0.01 ether);
        assertEq(offer.collateral, 0.03 ether);
        assertEq(offer.expiresAt, block.number + lifetime);
        assertTrue(reg.exists(offerId));
        assertTrue(reg.isActive(offerId));
        assertEq(reg.nextOfferId(), 2);
        assertEq(reg.offerCount(), 1);
    }

    function testRegisterRejectsSlaBelowMinimum() public {
        uint256 lifetime = reg.MIN_LIFETIME();
        uint256 minSlaBlocks = reg.MIN_SLA_BLOCKS();

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferRegistry.InvalidSlaBlocks.selector, minSlaBlocks - 1, minSlaBlocks, reg.MAX_SLA_BLOCKS()
            )
        );
        reg.register(0.01 ether, minSlaBlocks - 1, 0.03 ether, lifetime);
    }

    function testDeactivateDisablesOffer() public {
        uint256 lifetime = reg.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = reg.register(0.01 ether, 20, 0.03 ether, lifetime);
        reg.deactivate(offerId);
        vm.stopPrank();

        OfferRegistry.Offer memory offer = reg.getOffer(offerId);

        assertEq(offer.provider, provider);
        assertEq(offer.feePerOp, 0.01 ether);
        assertEq(offer.collateral, 0.03 ether);
        assertEq(offer.slaBlocks, 20);
        assertTrue(offer.disabled);
        assertTrue(reg.exists(offerId));
        assertFalse(reg.isActive(offerId));
        assertEq(reg.offerCount(), 1);
    }

    function testGetOfferPageListsCreatedOffers() public {
        uint256 lifetime = reg.MIN_LIFETIME();
        address secondProvider = address(0xBEEF);

        vm.prank(provider);
        reg.register(0.01 ether, 20, 0.03 ether, lifetime);

        vm.prank(secondProvider);
        reg.register(0.02 ether, 30, 0.05 ether, lifetime);

        OfferRegistry.OfferView[] memory page = reg.getOfferPage(1, 10);

        assertEq(page.length, 2);
        assertEq(page[0].offerId, 1);
        assertEq(page[0].provider, provider);
        assertEq(page[0].feePerOp, 0.01 ether);
        assertEq(page[0].collateral, 0.03 ether);
        assertEq(page[0].slaBlocks, 20);
        assertEq(page[0].expiresAt, block.number + lifetime);
        assertTrue(page[0].exists);
        assertFalse(page[0].disabled);
        assertTrue(page[0].active);

        assertEq(page[1].offerId, 2);
        assertEq(page[1].provider, secondProvider);
        assertEq(page[1].feePerOp, 0.02 ether);
        assertEq(page[1].collateral, 0.05 ether);
        assertEq(page[1].slaBlocks, 30);
        assertEq(page[1].expiresAt, block.number + lifetime);
        assertTrue(page[1].exists);
        assertFalse(page[1].disabled);
        assertTrue(page[1].active);
        assertEq(reg.offerCount(), 2);
    }

    function testGetOfferPageMarksDisabledAndExpiredOffers() public {
        uint256 lifetime = reg.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 disabledOfferId = reg.register(0.01 ether, 20, 0.03 ether, lifetime);
        reg.register(0.02 ether, 30, 0.05 ether, lifetime);
        reg.deactivate(disabledOfferId);
        vm.stopPrank();

        vm.roll(block.number + lifetime + 1);

        OfferRegistry.OfferView[] memory page = reg.getOfferPage(1, 10);

        assertEq(page.length, 2);
        assertEq(page[0].offerId, 1);
        assertEq(page[0].provider, provider);
        assertEq(page[0].feePerOp, 0.01 ether);
        assertEq(page[0].collateral, 0.03 ether);
        assertEq(page[0].slaBlocks, 20);
        assertTrue(page[0].exists);
        assertTrue(page[0].disabled);
        assertFalse(page[0].active);

        assertEq(page[1].offerId, 2);
        assertEq(page[1].provider, provider);
        assertTrue(page[1].exists);
        assertFalse(page[1].disabled);
        assertFalse(page[1].active);
        assertEq(reg.offerCount(), 2);
    }

    function testGetOfferPageReturnsEmptyAfterEnd() public view {
        OfferRegistry.OfferView[] memory page = reg.getOfferPage(1, 10);

        assertEq(page.length, 0);
    }

    function testGetOfferPageRejectsZeroStart() public {
        vm.expectRevert(abi.encodeWithSelector(OfferRegistry.InvalidOfferPage.selector, 0, 10, reg.MAX_PAGE_SIZE()));

        reg.getOfferPage(0, 10);
    }

    function testGetOfferPageRejectsOversizedPage() public {
        uint256 count = reg.MAX_PAGE_SIZE() + 1;
        vm.expectRevert(abi.encodeWithSelector(OfferRegistry.InvalidOfferPage.selector, 1, count, reg.MAX_PAGE_SIZE()));

        reg.getOfferPage(1, count);
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
        assertFalse(offer.disabled);
        assertEq(offer.expiresAt, block.number + maxLifetime);
        assertTrue(reg.isActive(offerId));
    }

    function testRenewReactivatesDisabledOffer() public {
        uint256 lifetime = reg.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = reg.register(0.01 ether, 20, 0.03 ether, lifetime);
        reg.deactivate(offerId);
        reg.renew(offerId, lifetime);
        vm.stopPrank();

        OfferRegistry.Offer memory offer = reg.getOffer(offerId);
        assertFalse(offer.disabled);
        assertTrue(reg.isActive(offerId));
    }
}
