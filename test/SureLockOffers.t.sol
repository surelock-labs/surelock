// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract SureLockOffersTest is Test {
    SureLock surelock;
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
        WatcherRegistry watcherRegistry = new WatcherRegistry(address(this), address(0xFEE), address(0xA11CE));
        surelock = new SureLock(address(watcherRegistry), address(this));
    }

    function testInitialNextOfferIdIsOne() public view {
        assertEq(surelock.nextOfferId(), 1);
    }

    function testRegisterStoresOffer() public {
        uint256 lifetime = surelock.MIN_LIFETIME();

        vm.expectEmit(true, true, false, true, address(surelock));
        emit OfferRegistered(1, provider, 0.01 ether, 0.03 ether, 20, block.number + lifetime);

        vm.prank(provider);
        uint256 offerId = surelock.register(0.01 ether, 20, 0.03 ether, lifetime);

        SureLock.Offer memory offer = surelock.getOffer(offerId);
        assertEq(offer.provider, provider);
        assertFalse(offer.disabled);
        assertEq(offer.slaBlocks, 20);
        assertEq(offer.feePerOp, 0.01 ether);
        assertEq(offer.collateral, 0.03 ether);
        assertEq(offer.expiresAt, block.number + lifetime);
        assertTrue(surelock.exists(offerId));
        assertTrue(surelock.isActive(offerId));
        assertEq(surelock.nextOfferId(), 2);
        assertEq(surelock.offerCount(), 1);
    }

    function testRegisterRejectsSlaBelowMinimum() public {
        uint256 lifetime = surelock.MIN_LIFETIME();
        uint256 minSlaBlocks = surelock.MIN_SLA_BLOCKS();

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                SureLock.InvalidSlaBlocks.selector, minSlaBlocks - 1, minSlaBlocks, surelock.MAX_SLA_BLOCKS()
            )
        );
        surelock.register(0.01 ether, minSlaBlocks - 1, 0.03 ether, lifetime);
    }

    function testDeactivateDisablesOffer() public {
        uint256 lifetime = surelock.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = surelock.register(0.01 ether, 20, 0.03 ether, lifetime);
        surelock.deactivate(offerId);
        vm.stopPrank();

        SureLock.Offer memory offer = surelock.getOffer(offerId);

        assertEq(offer.provider, provider);
        assertEq(offer.feePerOp, 0.01 ether);
        assertEq(offer.collateral, 0.03 ether);
        assertEq(offer.slaBlocks, 20);
        assertTrue(offer.disabled);
        assertTrue(surelock.exists(offerId));
        assertFalse(surelock.isActive(offerId));
        assertEq(surelock.offerCount(), 1);
    }

    function testDeactivateRejectsMissingOffer() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.OfferNotFound.selector, 0));
        surelock.deactivate(0);
    }

    function testGetOfferPageListsCreatedOffers() public {
        uint256 lifetime = surelock.MIN_LIFETIME();
        address secondProvider = address(0xBEEF);

        vm.prank(provider);
        surelock.register(0.01 ether, 20, 0.03 ether, lifetime);

        vm.prank(secondProvider);
        surelock.register(0.02 ether, 30, 0.05 ether, lifetime);

        SureLock.OfferView[] memory page = surelock.getOfferPage(1, 10);

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
        assertEq(surelock.offerCount(), 2);
    }

    function testGetOfferPageMarksDisabledAndExpiredOffers() public {
        uint256 lifetime = surelock.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 disabledOfferId = surelock.register(0.01 ether, 20, 0.03 ether, lifetime);
        surelock.register(0.02 ether, 30, 0.05 ether, lifetime);
        surelock.deactivate(disabledOfferId);
        vm.stopPrank();

        vm.roll(block.number + lifetime + 1);

        SureLock.OfferView[] memory page = surelock.getOfferPage(1, 10);

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
        assertEq(surelock.offerCount(), 2);
    }

    function testGetOfferPageReturnsEmptyAfterEnd() public view {
        SureLock.OfferView[] memory page = surelock.getOfferPage(1, 10);

        assertEq(page.length, 0);
    }

    function testGetOfferPageRejectsZeroStart() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidOfferPage.selector, 0, 10, surelock.MAX_PAGE_SIZE()));

        surelock.getOfferPage(0, 10);
    }

    function testGetOfferPageRejectsOversizedPage() public {
        uint256 count = surelock.MAX_PAGE_SIZE() + 1;
        vm.expectRevert(abi.encodeWithSelector(SureLock.InvalidOfferPage.selector, 1, count, surelock.MAX_PAGE_SIZE()));

        surelock.getOfferPage(1, count);
    }

    function testGetOfferRevertsWhenMissing() public {
        vm.expectRevert(abi.encodeWithSelector(SureLock.OfferNotFound.selector, 42));
        surelock.getOffer(42);
    }

    function testRenewExtendsOffer() public {
        uint256 minLifetime = surelock.MIN_LIFETIME();
        uint256 maxLifetime = surelock.MAX_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = surelock.register(0.01 ether, 20, 0.03 ether, minLifetime);
        vm.roll(100);
        surelock.renew(offerId, maxLifetime);
        vm.stopPrank();

        SureLock.Offer memory offer = surelock.getOffer(offerId);
        assertFalse(offer.disabled);
        assertEq(offer.expiresAt, block.number + maxLifetime);
        assertTrue(surelock.isActive(offerId));
    }

    function testRenewReactivatesDisabledOffer() public {
        uint256 lifetime = surelock.MIN_LIFETIME();

        vm.startPrank(provider);
        uint256 offerId = surelock.register(0.01 ether, 20, 0.03 ether, lifetime);
        surelock.deactivate(offerId);
        surelock.renew(offerId, lifetime);
        vm.stopPrank();

        SureLock.Offer memory offer = surelock.getOffer(offerId);
        assertFalse(offer.disabled);
        assertTrue(surelock.isActive(offerId));
    }
}
