// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./RLPReader.sol";

/// @title MerkleTrie
/// @notice Verifies Ethereum Merkle Patricia Trie inclusion proofs (docs/DESIGN.md A10).
/// @dev Used to prove that a transaction receipt exists at a given key in the
///      receipt trie, whose root is committed in the block header (receiptsRoot).
///
///      Key encoding for the receipt trie: `rlp(txIndex)`, converted to nibbles.
///      Proof: list of RLP-encoded nodes from root to leaf, ordered root-first.
///
///      Node types:
///        Branch node  : 17-element list [child0..child15, value]
///        Extension node: 2-element list [hp-encodedPath, childRef]
///        Leaf node    : 2-element list [hp-encodedPath, value]
///
///      HP (hex-prefix) path encoding (first nibble of first byte):
///        0 -> extension, even  2 -> leaf, even
///        1 -> extension, odd   3 -> leaf, odd
library MerkleTrie {
    using RLPReader for RLPReader.RLPItem;

    // -- public API ------------------------------------------------------------

    /// @notice Retrieve the value at `key` from the trie and verify the proof.
    /// @param key   Trie key (RLP-encoded transaction index for receipt trie).
    /// @param proof Ordered list of RLP-encoded trie nodes, root to leaf.
    /// @param root  Expected Merkle root (receiptsRoot extracted from block header).
    /// @return value The RLP-encoded receipt bytes stored at `key`.
    function get(
        bytes memory  key,
        bytes[] memory proof,
        bytes32       root
    ) internal pure returns (bytes memory value) {
        bytes memory nibbles = _toNibbles(key);
        uint256 nibblePos    = 0;

        // Current node reference: starts as the 32-byte root hash, then follows pointers.
        // A 32-byte reference means "hash of the node"; shorter means inline RLP.
        bytes memory nodeRef = abi.encodePacked(root);

        for (uint256 i; i < proof.length; i++) {
            bytes memory node = proof[i];

            // Verify this proof node matches the reference we're following.
            if (nodeRef.length == 32) {
                bytes32 expected;
                assembly { expected := mload(add(nodeRef, 0x20)) }
                require(keccak256(node) == expected, "MPT: hash");
            } else {
                // Inline node: the reference IS the node bytes.
                require(keccak256(node) == keccak256(nodeRef), "MPT: inline");
            }

            RLPReader.RLPItem[] memory decoded = RLPReader.toRlpItem(node).toList();

            if (decoded.length == 17) {
                // -- Branch node -----------------------------------------------
                if (nibblePos == nibbles.length) {
                    // Key exhausted here -- value lives in slot [16].
                    return decoded[16].toBytes();
                }
                uint8 nibble = uint8(nibbles[nibblePos++]);
                require(!decoded[nibble].isEmpty(), "MPT: no key");
                nodeRef = _childRef(decoded[nibble]);

            } else if (decoded.length == 2) {
                // -- Extension or Leaf node ------------------------------------
                (bool isLeaf, bytes memory pathNibs) = _decodeHP(decoded[0].toBytes());

                // Consume matching path nibbles
                uint256 pLen = pathNibs.length;
                require(nibblePos + pLen <= nibbles.length, "MPT: overflow");
                for (uint256 j; j < pLen; j++) {
                    require(nibbles[nibblePos + j] == pathNibs[j], "MPT: path");
                }
                nibblePos += pLen;

                if (isLeaf) {
                    require(nibblePos == nibbles.length, "MPT: short key");
                    return decoded[1].toBytes();
                }
                // Extension: follow child
                require(!decoded[1].isEmpty(), "MPT: ext empty");
                nodeRef = _childRef(decoded[1]);

            } else {
                revert("MPT: bad node");
            }
        }
        revert("MPT: incomplete");
    }

    // -- internals -------------------------------------------------------------

    /// @dev Convert a byte array to its nibble (half-byte) representation.
    function _toNibbles(bytes memory data) private pure returns (bytes memory nibs) {
        nibs = new bytes(data.length * 2);
        for (uint256 i; i < data.length; i++) {
            nibs[i * 2]     = bytes1(uint8(data[i]) >> 4);
            nibs[i * 2 + 1] = bytes1(uint8(data[i]) & 0x0f);
        }
    }

    /// @dev Decode an HP-encoded path into (isLeaf, nibbles).
    function _decodeHP(bytes memory enc)
        private
        pure
        returns (bool isLeaf, bytes memory nibs)
    {
        require(enc.length > 0, "MPT: empty HP");
        uint8 first = uint8(enc[0]);
        uint8 flag  = first >> 4;
        require(flag <= 3, "MPT: bad HP flag");  // valid HP flags: 0=ext-even 1=ext-odd 2=leaf-even 3=leaf-odd
        isLeaf      = flag >= 2;
        bool isOdd  = (flag & 1) == 1;

        uint256 cnt = (enc.length - 1) * 2 + (isOdd ? 1 : 0);
        nibs = new bytes(cnt);
        uint256 pos = 0;
        if (isOdd) nibs[pos++] = bytes1(first & 0x0f);
        for (uint256 i = 1; i < enc.length; i++) {
            nibs[pos++] = bytes1(uint8(enc[i]) >> 4);
            nibs[pos++] = bytes1(uint8(enc[i]) & 0x0f);
        }
    }

    /// @dev Extract the node reference from a branch or extension child slot.
    ///      Returns raw RLP bytes for inline nodes (len < 32), or the 32-byte hash payload.
    function _childRef(RLPReader.RLPItem memory item) private pure returns (bytes memory) {
        // Inline node (list encoded as a list item within the parent node)
        if (item.isList()) return item.rawBytes();
        // Hash reference (32-byte byte string, stored as 0xa0 + <32 bytes>)
        return item.toBytes();
    }
}
