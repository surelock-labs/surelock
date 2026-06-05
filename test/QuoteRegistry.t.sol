// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {QuoteRegistry} from "src/QuoteRegistry.sol";

contract QuoteRegistryTest is Test {
    QuoteRegistry registry;

    function setUp() public {
        registry = new QuoteRegistry();
    }

    function testInitialNextQuoteIdIsZero() public view {
        assertEq(registry.nextQuoteId(), 0);
    }
}
