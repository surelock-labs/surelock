// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {QuoteRegistry} from "src/QuoteRegistry.sol";

contract QuoteRegistryTest {
    QuoteRegistry registry;

    function setUp() public {
        registry = new QuoteRegistry();
    }

    function testInitialNextQuoteIdIsZero() public view {
        assert(registry.nextQuoteId() == 0);
    }
}
