# @surelock-labs/router

## 0.1.7

- `scoreBundlers` now collapses the N per-bundler `idleBalance` reads into a single Multicall3 `aggregate3` call. Opt out with `{ multicall: false }`.
- When Multicall3 is not deployed on the connected chain, `scoreBundlers` automatically falls back to direct reads and emits a single `console.warn` on the slow path -- keeps reliability scoring usable on custom/local chains without silent degradation.
- `RouterConfig.multicall` and `fetchAndScoreQuotes(..., { multicall })` expose the same opt-out path used by `scoreBundlers`.
- `fetchQuotes` rejects invalid `pageSize` values (`<= 0`, non-integer, non-safe-integer) instead of risking a non-progressing page loop.
- Protocol pin bumped to `^0.1.11`.

## 0.1.6

- Added `totalCommitValue(provider, escrow, offer)` -- returns `offer.feePerOp + protocolFeeWei()` read live. Matches the `totalCommitValue` term in `docs/DESIGN.md`.
- `claimPayout(signer, escrow, fromBlock?)` accepts an optional `fromBlock`. When set, the `pendingWithdrawals` pre-check is pinned to that block -- prevents a false zero on load-balanced RPCs immediately after a `cancel` or `claimRefund`.
- Re-exports from `@surelock-labs/protocol`: `ENTRY_POINT_V06`, `computeUserOpHash`, `UserOperation`, `readEscrowConstants`, `readRegistryConstants`, `EscrowConstants`, `RegistryConstants` -- a client can import everything it needs from `@surelock-labs/router` without adding `@surelock-labs/protocol` or `@surelock-labs/bundler` as direct deps.
- `scoring.ts` no longer hardcodes `SETTLEMENT_GRACE_BLOCKS`; each `scoreBundler` / `scoreBundlers` call reads the value from the escrow contract once per invocation.
- Bumped protocol pin to `^0.1.10`.

## 0.1.5

- `fetchQuotes` now pages via `QuoteRegistry.listActivePage(offset, limit)` instead of `list()`. Bounded response size per RPC; safe on registries with thousands of offers. Takes an optional `pageSize` argument (default 200).

## 0.1.4

- Added `cancel(signer, escrow, commitId)` -- cancel a commit (user-facing).
- Added `claimRefund(signer, escrow, commitId)` -- claim refund after SLA miss (user-facing).
- Added `claimPayout(signer, escrow)` -- pull pendingWithdrawals. Returns the amount paid out.
- All three are also available on the `createRouter()` client.
- Client lifecycle is now reachable end-to-end from the SDK: `selectReliable` -> `commitOp` -> (`cancel` | `claimRefund`) -> `claimPayout`. The README examples that previously told users to "call `escrow.cancel` directly" are no longer the only path.

## 0.1.3

- Package: `@surelock-labs/protocol` peer pin bumped from `^0.1.1` to `^0.1.9` -- aligns the declared floor with the protocol version this release is tested against, so `npm install` selects a tested pair rather than floating through intermediate 0.1.x patch versions.

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
