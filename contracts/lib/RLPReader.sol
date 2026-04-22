// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RLPReader
/// @notice Minimal RLP decoder for on-chain receipt proof verification (docs/DESIGN.md A10).
/// @dev Implements only the subset required: list parsing, bytes/uint/address/bytes32
///      extraction. Pointer-based to avoid redundant memory copies.
library RLPReader {

    // -- types -----------------------------------------------------------------

    struct RLPItem {
        uint256 memPtr;  // pointer to first byte of the encoded item (including prefix)
        uint256 dataLen; // total byte length (prefix + payload)
    }

    // -- entry points ----------------------------------------------------------

    /// @notice Wrap a `bytes memory` buffer as an RLPItem.
    function toRlpItem(bytes memory data) internal pure returns (RLPItem memory item) {
        require(data.length > 0, "RLP: empty input");
        uint256 ptr;
        assembly { ptr := add(data, 0x20) }
        item = RLPItem(ptr, data.length);
    }

    /// @notice Decode an RLP list into its direct children.
    function toList(RLPItem memory item) internal pure returns (RLPItem[] memory result) {
        require(_isList(item.memPtr), "RLP: not list");
        (uint256 offset, uint256 payloadLen) = _header(item.memPtr);
        require(offset + payloadLen <= item.dataLen, "RLP: content length mismatch");

        uint256 end = item.memPtr + offset + payloadLen;
        uint256 cur = item.memPtr + offset;

        // Count children
        uint256 count = 0;
        { uint256 c = cur; while (c < end) { c += _itemLen(c); count++; } }

        result = new RLPItem[](count);
        for (uint256 i; i < count; i++) {
            uint256 len = _itemLen(cur);
            result[i] = RLPItem(cur, len);
            cur += len;
        }
    }

    /// @notice Extract the payload bytes of a non-list item (strips RLP prefix).
    function toBytes(RLPItem memory item) internal pure returns (bytes memory out) {
        require(!_isList(item.memPtr), "RLP: is list");
        (uint256 offset, uint256 len) = _header(item.memPtr);
        require(offset + len <= item.dataLen, "RLP: content length mismatch");
        out = new bytes(len);
        uint256 src = item.memPtr + offset;
        assembly { mcopy(add(out, 0x20), src, len) }
    }

    /// @notice Decode a big-endian uint256 from an RLP byte string.
    function toUint(RLPItem memory item) internal pure returns (uint256 out) {
        bytes memory b = toBytes(item);
        require(b.length <= 32, "RLP: uint>32");
        for (uint256 i; i < b.length; i++) out = (out << 8) | uint8(b[i]);
    }

    /// @notice Decode a 20-byte Ethereum address from an RLP byte string.
    function toAddress(RLPItem memory item) internal pure returns (address addr) {
        bytes memory b = toBytes(item);
        require(b.length == 20, "RLP: not address");
        assembly { addr := shr(96, mload(add(b, 0x20))) }
    }

    /// @notice Decode a 32-byte hash from an RLP byte string.
    function toBytes32(RLPItem memory item) internal pure returns (bytes32 out) {
        bytes memory b = toBytes(item);
        require(b.length == 32, "RLP: not bytes32");
        assembly { out := mload(add(b, 0x20)) }
    }

    /// @notice Return true if the item is an RLP list (vs. a byte string).
    function isList(RLPItem memory item) internal pure returns (bool) {
        return _isList(item.memPtr);
    }

    /// @notice Return true if the item encodes an empty string (0x80) or empty list (0xc0).
    function isEmpty(RLPItem memory item) internal pure returns (bool) {
        uint8 prefix = _prefix(item.memPtr);
        return prefix == 0x80 || prefix == 0xc0;
    }

    /// @notice Copy all raw bytes of this item (prefix + payload), for inline-node handling.
    function rawBytes(RLPItem memory item) internal pure returns (bytes memory out) {
        out = new bytes(item.dataLen);
        uint256 ptr = item.memPtr;
        assembly { mcopy(add(out, 0x20), ptr, mload(out)) }
    }

    // -- internals -------------------------------------------------------------

    function _prefix(uint256 ptr) private pure returns (uint8 b) {
        assembly { b := byte(0, mload(ptr)) }
    }

    function _isList(uint256 ptr) private pure returns (bool) {
        return _prefix(ptr) >= 0xc0;
    }

    /// @dev Returns (payloadOffset, payloadLen) for the item at ptr.
    ///      Enforces canonical RLP encoding:
    ///      - single bytes 0x00-0x7f must not use 0x80+ prefix
    ///      - long-form lengths must not have leading zeros
    ///      - long-form encoding only when payload > 55 bytes
    function _header(uint256 ptr) private pure returns (uint256 offset, uint256 payloadLen) {
        uint8 p = _prefix(ptr);
        if (p < 0x80) { return (0, 1); }                                    // single byte
        if (p < 0xb8) {                                                      // short string
            uint256 strLen = p - 0x80;
            if (strLen == 1) {
                uint8 content;
                assembly { content := byte(0, mload(add(ptr, 1))) }
                require(content >= 0x80, "RLP: non-canonical single byte");
            }
            return (1, strLen);
        }
        if (p < 0xc0) {                                                      // long string
            uint256 ll = p - 0xb7;
            uint8 firstLenByte;
            assembly { firstLenByte := byte(0, mload(add(ptr, 1))) }
            require(firstLenByte != 0, "RLP: leading zero in length");
            uint256 strLen = _be(ptr + 1, ll);
            require(strLen > 55, "RLP: non-canonical long form");
            return (1 + ll, strLen);
        }
        if (p < 0xf8) { return (1, p - 0xc0); }                             // short list
        {                                                                     // long list
            uint256 ll = p - 0xf7;
            uint8 firstLenByte;
            assembly { firstLenByte := byte(0, mload(add(ptr, 1))) }
            require(firstLenByte != 0, "RLP: leading zero in length");
            uint256 listLen = _be(ptr + 1, ll);
            require(listLen > 55, "RLP: non-canonical long form");
            return (1 + ll, listLen);
        }
    }

    function _itemLen(uint256 ptr) private pure returns (uint256) {
        (uint256 offset, uint256 payloadLen) = _header(ptr);
        return offset + payloadLen;
    }

    /// @dev Read `len` bytes at `ptr` as a big-endian unsigned integer.
    ///      Callers are responsible for ensuring [ptr, ptr+len) lies within a valid, allocated
    ///      memory buffer. In MerkleTrie every node is hash-verified against receiptsRoot before
    ///      parsing, so attacker-controlled bytes cannot reach this function through that path.
    ///      Do not rely on EVM memory zero-fill as a safety guarantee for out-of-bounds reads.
    function _be(uint256 ptr, uint256 len) private pure returns (uint256 out) {
        for (uint256 i; i < len; i++) {
            uint8 b;
            assembly { b := byte(0, mload(add(ptr, i))) }
            out = (out << 8) | b;
        }
    }
}
