// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// RLPReader Unit Tests
// ============================================================================
//
// Test vectors ported from Optimism's RLPReader.t.sol (MIT, ethereum-optimism/optimism).
// Covers canonical encoding enforcement, bounds checking, and decode correctness.
//
// Intentional behavioral differences vs Optimism's library (documented below):
//
//   1. No MAX_LIST_LENGTH cap -- Optimism reverts on lists >32 elements.
//      We accept any length. Needed because ERC-4337 receipt logs can exceed 32
//      entries in large bundler batches.
//
//   2. No InvalidDataRemainder check -- Optimism rejects RLP items with trailing
//      bytes after the encoded value. We silently ignore trailing bytes. This is
//      correct for MerkleTrie node parsing where child items are sliced from a
//      larger parent buffer.
//
//   3. Error messages differ -- Optimism uses custom errors (EmptyItem,
//      ContentLengthMismatch, InvalidHeader, etc.); we use require() strings.

import "forge-std/Test.sol";
import "../../contracts/lib/RLPReader.sol";

contract RLPReaderTest is Test {
    using RLPReader for RLPReader.RLPItem;

    // -------------------------------------------------------------------------
    // toRlpItem
    // -------------------------------------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toRlpItem_empty_reverts() external {
        vm.expectRevert("RLP: empty input");
        RLPReader.toRlpItem(hex"");
    }

    function test_toRlpItem_singleByte_succeeds() external pure {
        RLPReader.RLPItem memory item = RLPReader.toRlpItem(hex"00");
        assertEq(item.dataLen, 1);
    }

    function test_toRlpItem_multiBytes_succeeds() external pure {
        RLPReader.RLPItem memory item = RLPReader.toRlpItem(hex"827a77");
        assertEq(item.dataLen, 3);
    }

    function test_toRlpItem_rlpList_succeeds() external pure {
        RLPReader.RLPItem memory item = RLPReader.toRlpItem(hex"c0");
        assertEq(item.dataLen, 1);
    }

    // -------------------------------------------------------------------------
    // toBytes (= Optimism readBytes)
    // -------------------------------------------------------------------------

    function test_toBytes_byte00_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"00").toBytes(), hex"00");
    }

    function test_toBytes_byte01_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"01").toBytes(), hex"01");
    }

    function test_toBytes_byte7f_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"7f").toBytes(), hex"7f");
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toBytes_listItem_reverts() external {
        // 0xc7 >= 0xc0: list prefix -- toBytes rejects lists
        vm.expectRevert("RLP: is list");
        RLPReader.toRlpItem(hex"c7c0c1c0c3c0c1c0").toBytes();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toBytes_truncatedLongString_reverts() external {
        // 0xb9: long-string, needs 2 length bytes; buffer has 0 more -> reads zero -> leading zero
        vm.expectRevert("RLP: leading zero in length");
        RLPReader.toRlpItem(hex"b9").toBytes();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toBytes_nonCanonicalSingleByte_reverts() external {
        // 0x81 0x0a: short-string of length 1, content 0x0a (<0x80) -> non-canonical
        vm.expectRevert("RLP: non-canonical single byte");
        RLPReader.toRlpItem(hex"810a").toBytes();
    }

    function test_toBytes_trailingBytesIgnored_succeeds() external pure {
        // 0x80 = empty string; 0x0a is trailing. Trailing bytes are tolerated (no InvalidDataRemainder).
        assertEq(RLPReader.toRlpItem(hex"800a").toBytes(), hex"");
    }

    // -------------------------------------------------------------------------
    // toList (= Optimism readList)
    // -------------------------------------------------------------------------

    function test_toList_emptyList_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"c0").toList().length, 0);
    }

    function test_toList_multiList_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(hex"c6827a77c10401").toList();
        assertEq(list.length, 3);
        assertEq(list[0].rawBytes(), hex"827a77");
        assertEq(list[1].rawBytes(), hex"c104");
        assertEq(list[2].rawBytes(), hex"01");
    }

    function test_toList_shortListMax_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(
            hex"f784617364668471776572847a78637684617364668471776572847a78637684617364668471776572847a78637684617364668471776572"
        ).toList();
        assertEq(list.length, 11);
        assertEq(list[0].rawBytes(), hex"8461736466");
        assertEq(list[10].rawBytes(), hex"8471776572");
    }

    function test_toList_longList_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(
            hex"f840cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376"
        ).toList();
        assertEq(list.length, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(list[i].rawBytes(), hex"cf84617364668471776572847a786376");
        }
    }

    function test_toList_32Elements_succeeds() external pure {
        // Optimism's test_readList_longList2 -- exactly at their MAX_LIST_LENGTH cap
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(
            hex"f90200cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376cf84617364668471776572847a786376"
        ).toList();
        assertEq(list.length, 32);
    }

    function test_toList_33Elements_succeeds() external pure {
        // Optimism reverts here (MAX_LIST_LENGTH=32). We accept it.
        // 0xe1 = 0xc0+33 (short list, 33-byte payload); 33 self-encoded bytes 0x45
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(
            hex"e1454545454545454545454545454545454545454545454545454545454545454545"
        ).toList();
        assertEq(list.length, 33);
    }

    function test_toList_listOfLists_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(hex"c4c2c0c0c0").toList();
        assertEq(list.length, 2);
        assertEq(list[0].rawBytes(), hex"c2c0c0");
        assertEq(list[1].rawBytes(), hex"c0");
    }

    function test_toList_nestedListOfLists_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(hex"c7c0c1c0c3c0c1c0").toList();
        assertEq(list.length, 3);
        assertEq(list[0].rawBytes(), hex"c0");
        assertEq(list[1].rawBytes(), hex"c1c0");
        assertEq(list[2].rawBytes(), hex"c3c0c1c0");
    }

    function test_toList_dictTest_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(
            hex"ecca846b6579318476616c31ca846b6579328476616c32ca846b6579338476616c33ca846b6579348476616c34"
        ).toList();
        assertEq(list.length, 4);
        assertEq(list[0].rawBytes(), hex"ca846b6579318476616c31");
        assertEq(list[3].rawBytes(), hex"ca846b6579348476616c34");
    }

    function test_toList_trailingBytesIgnored_succeeds() external pure {
        // 0xc0 0x00: empty list followed by trailing byte. No InvalidDataRemainder.
        assertEq(RLPReader.toRlpItem(hex"c000").toList().length, 0);
    }

    // -- content-length checks -------------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_payloadTruncated_reverts() external {
        // 0xef = 0xc0+47: claims 47-byte payload, only 2 bytes present
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(hex"efdebd").toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_payloadMismatch_reverts() external {
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(hex"efb83600").toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_payloadTooShort_reverts() external {
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(
            hex"efdebdaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ).toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_longListLengthOverflow_reverts() external {
        // 0xff: 8-byte length field; decoded length >> actual buffer
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(hex"ff0f000000000000021111").toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_longListClaimsMoreThanPresent1_reverts() external {
        // 0xf9: 2-byte length = 0x0180 = 384; only 1 byte present
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(hex"f90180").toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_longListClaimsMoreThanPresent2_reverts() external {
        vm.expectRevert("RLP: content length mismatch");
        RLPReader.toRlpItem(hex"ffffffffffffffffff0001020304050607").toList();
    }

    // -- canonical-form violations ---------------------------------------------

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_leadingZeroInLongListLength_reverts() external {
        // 0xfb: long-list, 4-byte length field starting with 0x00
        vm.expectRevert("RLP: leading zero in length");
        RLPReader.toRlpItem(
            hex"fb00000040000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"
        ).toList();
    }

    /// forge-config: default.allow_internal_expect_revert = true
    function test_toList_longFormForShortPayload_reverts() external {
        // 0xf8: long-list with 1-byte length = 1 (<=55 -> must use short form)
        vm.expectRevert("RLP: non-canonical long form");
        RLPReader.toRlpItem(hex"f80100").toList();
    }

    // -------------------------------------------------------------------------
    // rawBytes
    // -------------------------------------------------------------------------

    function test_rawBytes_singleByte_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"00").rawBytes(), hex"00");
    }

    function test_rawBytes_shortString_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"827a77").rawBytes(), hex"827a77");
    }

    function test_rawBytes_emptyList_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"c0").rawBytes(), hex"c0");
    }

    function test_rawBytes_nestedList_succeeds() external pure {
        assertEq(RLPReader.toRlpItem(hex"c7c0c1c0c3c0c1c0").rawBytes(), hex"c7c0c1c0c3c0c1c0");
    }

    function test_rawBytes_fromParsedList_succeeds() external pure {
        RLPReader.RLPItem[] memory list = RLPReader.toRlpItem(hex"c6827a77c10401").toList();
        assertEq(list[0].rawBytes(), hex"827a77");
        assertEq(list[1].rawBytes(), hex"c104");
        assertEq(list[2].rawBytes(), hex"01");
    }
}
