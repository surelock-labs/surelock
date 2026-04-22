# @surelock-labs/protocol

## 0.1.10

- Added shared primitives previously local to `@surelock-labs/bundler`:
  - `ENTRY_POINT_V06` -- canonical ERC-4337 v0.6 EntryPoint address.
  - `UserOperation` type + `computeUserOpHash(userOp, entryPoint, chainId)` -- v0.6 userOpHash computation.
  - `readEscrowConstants(provider, escrow)` / `EscrowConstants` -- live reader for version, entryPoint, grace blocks, MAX_SLA_BLOCKS, MAX_PROTOCOL_FEE_WEI, current protocolFeeWei, feeRecipient.
  - `readRegistryConstants(provider, registry)` / `RegistryConstants` -- live reader for MIN_BOND, MAX_BOND, MAX_SLA_BLOCKS, current registrationBond.
- `ethers` is now a peerDependency (`^6.0.0`).

## 0.1.1

- Package: README.md and LICENSE now included in published tarball

## 0.1.0

Initial release.

- `ESCROW_ABI`, `REGISTRY_ABI`, `TIMELOCK_ABI` -- contract ABIs
- `DEPLOYMENTS` -- bundled deployment addresses (Base Sepolia, Base Mainnet)
- `loadDeployment(chainId, startDir?)` -- deployment loader with local file fallback
- `Deployment`, `Offer`, `CommitInfo`, `PendingCommit`, `CommitResult` -- shared types
