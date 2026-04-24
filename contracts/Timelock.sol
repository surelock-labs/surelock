// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Thin wrapper so Hardhat compiles TimelockController and generates typechain types.
// The deployed instance owns the SLAEscrow proxy upgrade key.
//
// Role setup at deploy time (pre-multisig):
//   proposers  = [deployer]      -- replace with Safe multisig before mainnet
//   executors  = [address(0)]    -- anyone can execute after delay (standard)
//   admin      = deployer        -- allows adding multisig as proposer, then renounce
//
// Upgrade flow:
//   1. proposer calls schedule(proxy, 0, upgradeCalldata, 0, salt, minDelay)
//   2. wait minDelay seconds
//   3. anyone calls execute(proxy, 0, upgradeCalldata, 0, salt)
import "@openzeppelin/contracts/governance/TimelockController.sol";
