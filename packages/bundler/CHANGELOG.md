# @surelock-labs/bundler

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
