# @surelock-labs/router

## 0.1.2

- Docs: opening callout clarifies this is a SureLock commitment SDK, not a generic ERC-6900/7579 UserOp router
- Package: description updated to reflect actual role

## 0.1.1

- Docs: selectBest vs selectReliable decision guidance added
- Docs: constraints AND-logic stated explicitly
- Docs: userOpHash ethers code example + chain-specific warning
- Docs: Offer.active field documented
- Docs: DEFAULT_LOOKBACK_BLOCKS clarified for any EVM chain
- Docs: PROTOCOL_FEE_WEI shown as public constant with read example
- Docs: DEPLOYMENTS scope clarified (official SureLock Labs addresses)
- Package: README.md and LICENSE now included in published tarball

## 0.1.0

Initial release.

- `fetchQuotes(provider, registryAddr)` -- fetch active bundler offers from the registry
- `selectBest(offers, strategy, constraints?)` -- select the best offer by fee, SLA, or collateral
- `scoreBundler(provider, escrowAddr, bundlerAddr, collateral, lookback)` -- compute bundler reputation score
- Re-exports `REGISTRY_ABI`, `ESCROW_ABI` from `@surelock-labs/protocol`
