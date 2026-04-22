# @surelock-labs/bundler

## 0.1.8

- Added `computeUserOpHash(userOp, entryPoint, chainId)` -- canonical ERC-4337 v0.6 userOpHash. Moves the duplicated implementation out of `scripts/demo-settle.ts` into the SDK where any integrator building their own UserOps can reuse it.
- Added `UserOperation` type export for use with `computeUserOpHash`.
- Added `getPendingPayout(provider, escrow, address)` -- read-only preview of `pendingWithdrawals` before calling `claimPayout`.
- README: fixed stale "Return values" section. `deposit`, `withdraw`, `deregister`, `accept`, `settle` return `ContractTransactionReceipt` (since 0.1.4). `register` returns `Offer`. `claimPayout`, `claimBond` return `bigint` (amount).

## 0.1.7

- Added `fetchPendingCommits(provider, escrowAddress, bundlerAddress, fromBlock, toBlock?)` -- one-shot scan of past `CommitCreated` events for a bundler. Complements `watchCommits` for sequential scripts and integration tests where event subscription is impractical.

## 0.1.6

- `claimPayout` accepts an optional `fromBlock` parameter. When set, the `pendingWithdrawals` pre-check is pinned to that block (with auto-retry) instead of using "latest". Prevents false zero returns on load-balanced RPCs immediately after a `settle()` or `accept()` that credited a payout.

## 0.1.5

- `getCommit` now calls the contract's single `getCommit(id)` view instead of two separate calls to `getCommitCore` + `getCommitState`. Halves the RPC cost for every commit read.
- `getCommit` auto-retries when `blockTag` is set -- eliminates "block not found" errors on load-balanced RPCs without callers adding their own retry wrappers.
- `RegisterOfferParams.bond` removed -- the SDK now always reads the current `registrationBond()` from the contract. The previous override parameter was a footgun (stale values caused reverts) with no real use case.
- Re-export `Offer` type from `@surelock-labs/protocol`.

## 0.1.4

- Added `renew(signer, registry, quoteId)` -- extend an offer's lifetime.
- Added `deregisterExpired(signer, registry, quoteId)` -- permissionless cleanup of expired offers.
- Added `claimBond(signer, registry)` -- pull accumulated pendingBonds. Returns the amount claimed.
- Added `getPendingBond(provider, registry, bundler)` -- view pendingBonds balance.
- `getCommit` now accepts an optional `blockTag` to pin reads to a specific block -- essential on load-balanced RPCs where "latest" may lag.
- Write functions that previously returned `void` now return `ContractTransactionReceipt`: `deregister`, `deposit`, `withdraw`, `accept`, `settle`. Callers that ignored the return continue to work; callers that need gas, event parsing, or block pinning now have direct access.
- BREAKING: `register()` now returns the full `Offer` instead of just `bigint`. Callers that only need the id: `(await register(...)).quoteId`.

## 0.1.3

- Fix: `withRetry` now also recognises `"block not found"` in addition to `"header not found"`. Some load-balanced RPC providers (including public Base mainnet behind cloudfront/cloudflare) return the former phrasing when a freshly-mined block has not yet propagated. Proof helpers and any caller wrapping reads in `withRetry` were previously throwing on the first attempt instead of retrying.
- Package: `@surelock-labs/protocol` peer pin bumped from `^0.1.1` to `^0.1.9` -- aligns the declared floor with the protocol version this release is tested against, so `npm install` selects a tested pair rather than floating through intermediate 0.1.x patch versions.

## 0.1.2

- Docs: opening callout clarifies this is an SLA SDK for existing bundler operators, not a standalone ERC-4337 bundler implementation
- Docs: `register()` documents the registration bond (auto-fetched from contract, ~0.01 ETH on testnet) and refund-on-deregister behavior
- Docs: `RegisterOfferParams` now includes `lifetime?` (default 302,400 blocks) and `bond?` (auto-fetched if omitted)
- Package: description updated to reflect actual role

## 0.1.1

- Fix: `buildSettleProof` is a standalone import, not a client method -- corrected in README quick-start and settle() examples
- Docs: added "At a glance" section (what to import, what to monitor, what runs after inclusion)
- Docs: DEPLOYMENTS scope clarified (official SureLock Labs addresses; Base Sepolia live, mainnet at launch)
- Docs: return values documented, 256-block window expanded, collateral constraint T8 highlighted
- Package: README.md and LICENSE now included in published tarball

## 0.1.0

Initial release.

- `BundlerProvider` -- ethers provider wrapper for bundler operators: register, deposit, accept, settle
- `ClientProvider` -- ethers provider wrapper for users: commit, claim refund
- `BundlerSDK` -- typed SDK combining both sides of the protocol
- Re-exports `DEPLOYMENTS`, `Deployment` from `@surelock-labs/protocol`
