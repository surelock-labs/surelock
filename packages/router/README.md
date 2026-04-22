# @surelock-labs/router

> **Sending UserOps?** This SDK selects a bundler that has posted on-chain collateral against an SLA, commits your UserOp with the fee locked in escrow, and gives you a refund path if the bundler misses. It is not a UserOp router in the ERC-6900/7579 sense -- it is a client-side SDK for SureLock's bundler selection and commitment protocol.

Client-side SDK for SureLock -- fetch bundler offers, pick the best one, and commit a UserOp with on-chain SLA enforcement.

> **Testnet only -- Base Sepolia.** Mainnet after external audit.

```bash
npm install @surelock-labs/router ethers
```

---

## Quick start

```typescript
import { createRouter, DEPLOYMENTS } from "@surelock-labs/router";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const { registry, escrow } = DEPLOYMENTS[84532]; // Base Sepolia

const router = createRouter({ rpcUrl: "https://sepolia.base.org", registryAddress: registry, escrowAddress: escrow });

// Pick the best routable offer by reputation score
const best = await router.selectReliable();
if (!best) throw new Error("no routable offers");

// Commit a UserOp -- bundler must accept within 12 blocks (~24s)
const { commitId } = await router.commitOp(signer, best, userOpHash);
```

See "Commit outcomes" below for what to do if the bundler doesn't accept or misses the SLA.

---

## How it works

1. Bundlers register offers on `QuoteRegistry` -- fee, SLA window, required collateral per commit.
2. `fetchQuotes()` reads all active offers.
3. `selectBest()` filters and ranks them by your chosen strategy.
4. `commitOp()` calls `SLAEscrow.commit()`. The commit enters `PROPOSED`. The bundler has `ACCEPT_GRACE_BLOCKS` (12 blocks) to call `accept()`, which locks their collateral and starts the SLA clock.
5. The bundler includes the UserOp on-chain and calls `settle()` with an MPT receipt proof to claim `feePerOp`.
6. If the bundler never accepted, call `cancel()` to recover `feePerOp`. If they accepted but missed the deadline, call `claimRefund()` to recover `feePerOp + collateralLocked`.

`QuoteRegistry` enforces strict `collateralWei > feePerOp` at registration, so a deliberate miss always costs the bundler more than they would have earned.

---

## API

### `fetchQuotes(provider, registryAddress)`

Returns all active offers from the registry.

```typescript
import { fetchQuotes } from "@surelock-labs/router";

const offers = await fetchQuotes(provider, registry);
// [{ quoteId, bundler, feePerOp, slaBlocks, collateralWei, active }, ...]
```

### `selectBest(offers, strategy?, constraints?)`

Filters active offers, applies constraints, ranks by strategy. Returns `Offer | null`.

```typescript
import { selectBest } from "@surelock-labs/router";

const best    = selectBest(offers);              // default: cheapest fee
const fastest = selectBest(offers, "fastest");   // fewest blocks, tie-break: lowest fee
const safest  = selectBest(offers, "safest");    // most collateral, tie-break: lowest fee
```

**Strategies:**

| Strategy | Primary sort | Tie-break |
|---|---|---|
| `"cheapest"` (default) | lowest `feePerOp` | fewest `slaBlocks` |
| `"fastest"` | fewest `slaBlocks` | lowest `feePerOp` |
| `"safest"` | highest `collateralWei` | lowest `feePerOp` |

**Constraints** (all optional, all must be satisfied -- AND logic):

```typescript
const best = selectBest(offers, "cheapest", {
  maxFee:        ethers.parseUnits("100", "gwei"),
  maxSlaBlocks:  20,
  minCollateral: ethers.parseEther("0.05"),
});
```

Offers where `collateralWei <= feePerOp` are always excluded.

> **Not routability-aware.** `selectBest()` doesn't check whether the bundler currently has enough idle collateral to accept (`idleBalance >= offer.collateralWei`). Use `selectReliable()` when present-time routability matters.
>
> **When to use which.** Use `selectBest()` for offline filtering or when you have pre-fetched offers. Use `selectReliable()` just before committing -- it fetches live balances and scores, so you get the highest-reputation bundler that can actually accept right now.

### `commitOp(signer, escrowAddress, offer, userOpHash)`

Pays `feePerOp + protocolFee()` into escrow and opens a `PROPOSED` commit. Returns `{ commitId, blockNumber }`.

`userOpHash` is the canonical ERC-4337 `bytes32` hash of the UserOperation -- the exact value the EntryPoint emits as `topic[1]` of `UserOperationEvent`, computed as `keccak256(abi.encode(keccak256(abi.encode(allUserOpFields)), entryPoint, chainId))`.

> **Chain-specific.** The hash includes `chainId`, so it is not portable across networks. Recompute it per chain.

If you're computing the hash manually with ethers:

```typescript
const packed = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "address", "uint256"],
  [innerHash, entryPointAddress, chainId]
);
const userOpHash = ethers.keccak256(packed);
```

In practice, most AA wallets and SDKs expose a `getUserOpHash(userOp, entryPoint, chainId)` helper -- use that if available.

> **Silent failure risk.** If `userOpHash` is wrong, `settle()` will revert because no matching `UserOperationEvent` exists in the receipt. Always derive the hash from the same UserOp fields you actually submit to the EntryPoint. Do not reuse a hash across chains -- it includes `chainId` and will not match on a different network.

```typescript
import { commitOp } from "@surelock-labs/router";

const { commitId, blockNumber } = await commitOp(signer, escrow, best, userOpHash);
```

Keep `commitId` -- you'll need it to claim a refund if the bundler misses.

### `createRouter(config)` -- factory

Binds a provider and addresses into a single object. Convenient when routing multiple UserOps.

```typescript
const router = createRouter({
  rpcUrl: "https://sepolia.base.org",
  registryAddress: registry,
  escrowAddress: escrow,  // required for commitOp and selectReliable
});

// Routability-aware: filters by idleBalance >= offer.collateralWei
const best = await router.selectReliable();
const result = await router.commitOp(signer, best!, userOpHash);
```

### `fetchAndScoreQuotes(provider, registryAddress, escrowAddress, lookback?)`

Fetches active offers **and** scores each bundler's on-chain track record. Returns offers sorted best-to-worst by composite score.

```typescript
import { fetchAndScoreQuotes, DEPLOYMENTS } from "@surelock-labs/router";

const { registry, escrow } = DEPLOYMENTS[84532];
const scored = await fetchAndScoreQuotes(provider, registry, escrow);

const { offer, score } = scored[0]; // highest-reputation bundler
console.log(`acceptRate:  ${Math.round(score.acceptRate * 100)}%`);
console.log(`settleRate:  ${Math.round(score.settleRate * 100)}%`);
console.log(`score: ${score.score}/100`);
```

**Scoring weights:**

| Metric | Weight | Description |
|---|---|---|
| `acceptRate` | 40% | Accepted / matured commits (closed accept window only -- in-flight excluded) |
| `settleRate` | 35% | Settled / matured accepted commits (closed settle window only) |
| `idleRatio` | 15% | idleBalance / max(collateralWei) -- bundler-level headroom heuristic |
| speed | 10% | Inverse `medianTimeToAccept` |

Bundlers with no history in the lookback window default to a perfect score.

### `router.selectReliable(constraints?, lookback?)`

Fetches offers, scores bundlers, applies a hard routability filter (`idleBalance >= offer.collateralWei`), applies constraints, returns the highest-scoring routable offer.

Requires `escrowAddress` in `RouterConfig`.

```typescript
const best = await router.selectReliable({ maxFee: ethers.parseUnits("200", "gwei") });
if (!best) throw new Error("no routable offers -- all bundlers below collateral threshold or no offers match constraints");
const { commitId } = await router.commitOp(signer, best, userOpHash);
```

### `scoreBundler(provider, escrowAddr, bundler, collateral, lookback?)`

Score a single bundler directly.

```typescript
import { scoreBundler } from "@surelock-labs/router";

const score = await scoreBundler(provider, escrow, bundlerAddress, collateralWei);
// { bundler, idleRatio, acceptRate, settleRate, medianTimeToAccept, score, sampleSize }
```

`lookback` defaults to `DEFAULT_LOOKBACK_BLOCKS` (5,000 -- ~2.8h on Base at ~2s/block). Works on any EVM chain; adjust if your chain has a significantly different block time.

### `DEPLOYMENTS`

Official addresses verified and maintained by SureLock Labs. Base Sepolia (`84532`) is live now; Base Mainnet (`8453`) will be added at launch. For local development, pass your own deployed addresses instead.

```typescript
import { DEPLOYMENTS } from "@surelock-labs/router";

const { registry, escrow, timelock } = DEPLOYMENTS[84532]; // Base Sepolia testnet
```

### `cancel(signer, escrow, commitId)`

Cancel a commit. During the accept window only the CLIENT may call this; after `acceptDeadline` the CLIENT, BUNDLER, or `feeRecipient` may cancel. Returns the commit's `feePerOp` to `pendingWithdrawals` -- pull via `claimPayout`.

```typescript
import { cancel } from "@surelock-labs/router";
await cancel(signer, escrow, commitId);
```

### `claimRefund(signer, escrow, commitId)`

Claim refund after the bundler accepted but missed the SLA deadline. Credits `feePerOp + collateralLocked` to `pendingWithdrawals`. Opens at `deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1`.

```typescript
import { claimRefund } from "@surelock-labs/router";
await claimRefund(signer, escrow, commitId);
```

### `claimPayout(signer, escrow)`

Pull accumulated `pendingWithdrawals`. Returns the exact amount paid out (`0n` if nothing is pending).

```typescript
import { claimPayout } from "@surelock-labs/router";
const paid = await claimPayout(signer, escrow);
```

### `REGISTRY_ABI`, `ESCROW_ABI`

Exported for callers that want to read state directly (e.g. `escrow.getCommit`, `escrow.pendingWithdrawals`, `registry.isActive`). All write paths for users are covered by the SDK -- no need to reach into the ABI for `cancel` / `claimRefund` / `claimPayout` any more.

```typescript
import { ESCROW_ABI, DEPLOYMENTS } from "@surelock-labs/router";
import { ethers } from "ethers";

const escrow = new ethers.Contract(DEPLOYMENTS[84532].escrow, ESCROW_ABI, provider);
const commit = await escrow.getCommit(commitId);
```

---

## Commit outcomes

Every commit resolves in one of three ways:

| Outcome | What happened | `feePerOp` | Collateral | `protocolFee` |
|---|---|---|---|---|
| **SETTLED** | Bundler included the UserOp on time | Paid to bundler | Unlocked | Non-refundable |
| **CANCELLED** | Bundler never accepted within 12 blocks | **Returned to you** | Never locked | Non-refundable |
| **REFUNDED** | Bundler accepted but missed the SLA | **Returned to you** | **Slashed to you** | Non-refundable |

`PROTOCOL_FEE_WEI` is non-refundable on every path. It defaults to `0` at deploy.

---

### CANCELLED -- bundler didn't accept in time

The bundler has 12 blocks (~24s on Base) to call `accept()`. During the window, only CLIENT may call `cancel()`. After it expires, CLIENT, BUNDLER, or `feeRecipient` may cancel:

```typescript
import { cancel, claimPayout } from "@surelock-labs/router";

await cancel(signer, escrow, commitId);       // after accept window has passed
await claimPayout(signer, escrow);             // pull your feePerOp back
```

Collateral was never locked -- you get your `feePerOp` back, nothing more.

---

### REFUNDED -- bundler accepted but missed the SLA

```typescript
import { claimRefund, claimPayout } from "@surelock-labs/router";

// After: deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1
await claimRefund(signer, escrow, commitId);
await claimPayout(signer, escrow);             // feePerOp + full collateral
```

The protocol takes no share of slashed funds.

---

### Checking commit state

```typescript
import { ESCROW_ABI, DEPLOYMENTS } from "@surelock-labs/router";
import { ethers } from "ethers";

const escrow = new ethers.Contract(DEPLOYMENTS[84532].escrow, ESCROW_ABI, provider);
const commit = await escrow.getCommit(commitId);

if (commit.settled)   console.log("SETTLED -- bundler was paid");
if (commit.cancelled) console.log("CANCELLED -- call cancel() and claimPayout()");
if (commit.refunded)  console.log("REFUNDED -- claimRefund() already called");

// Still open: check if stuck in PROPOSED past the accept window
const block = await provider.getBlockNumber();
if (!commit.accepted && !commit.cancelled && BigInt(block) > commit.acceptDeadline) {
  console.log("Bundler missed accept window -- call cancel()");
}
```

---

## Types

```typescript
interface Offer {
  quoteId:       bigint;
  bundler:       string;
  feePerOp:      bigint;  // wei
  slaBlocks:     number;
  collateralWei: bigint;  // wei -- always strictly > feePerOp (T8)
  active:        boolean; // false if bundler called deregister(); fetchQuotes() only returns active offers
}

interface CommitResult {
  commitId:    bigint;
  blockNumber: number;
}

interface Constraints {
  maxFee?:        bigint;
  maxSlaBlocks?:  number;
  minCollateral?: bigint;
}

type Strategy = "cheapest" | "fastest" | "safest";

interface RouterConfig {
  rpcUrl:            string;
  registryAddress:   string;
  escrowAddress?:    string; // required for commitOp and selectReliable
}

interface BundlerScore {
  bundler:            string;
  idleRatio:          number;  // 0-1
  idleBalance:        bigint;  // wei -- use for per-offer routability
  acceptRate:         number;  // 0-1
  settleRate:         number;  // 0-1
  medianTimeToAccept: number;  // blocks
  score:              number;  // 0-100 composite
  sampleSize:         number;
}
```

---

## Economics

- **Protocol fee:** flat `PROTOCOL_FEE_WEI` per commit, non-refundable on every path. Defaults to `0` at deploy; activated post-launch via a 48h timelock. Future fee changes don't affect open commits. `commitOp()` reads the current fee automatically -- no manual calculation needed. To read it directly: `await escrow.PROTOCOL_FEE_WEI()` (public constant on the contract).
- **Bundler fee:** BUNDLER earns the full `feePerOp` on settle -- no protocol cut.
- **Slash on miss:** CLIENT gets `feePerOp + collateralLocked` (100%). PROTOCOL gets no share.

## Trust

On mainnet, contracts are UUPS upgradeable proxies behind a 48h `TimelockController`. Any queued upgrade is visible on-chain for the full delay before it can execute. Source verified on Basescan. ABIs are exported -- you can bypass this SDK and call the contracts directly.

**Testnet note.** Current Base Sepolia deployments use a shorter timelock delay. They exist to exercise the upgrade flow; the 48h guarantee is a mainnet requirement only.

## For bundler operators

Use [`@surelock-labs/bundler`](https://www.npmjs.com/package/@surelock-labs/bundler) to register offers, watch for commits, settle after inclusion, and claim fees.

## Disclaimer

This software is provided as-is, without warranty. The contracts have not been externally audited. Testnet only -- do not use with real funds until a mainnet release is announced.

You are responsible for your own keys, transactions, and any ETH you commit. Read the code. Verify the contracts on Basescan.

## License

MIT
