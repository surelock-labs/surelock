# @surelock-labs/protocol

## 0.1.1

- Package: README.md and LICENSE now included in published tarball

## 0.1.0

Initial release.

- `ESCROW_ABI`, `REGISTRY_ABI`, `TIMELOCK_ABI` -- contract ABIs
- `DEPLOYMENTS` -- bundled deployment addresses (Base Sepolia, Base Mainnet)
- `loadDeployment(chainId, startDir?)` -- deployment loader with local file fallback
- `Deployment`, `Offer`, `CommitInfo`, `PendingCommit`, `CommitResult` -- shared types
