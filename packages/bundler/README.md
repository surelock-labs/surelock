# @surelock-labs/bundler

> **Already running a bundler?** This SDK adds on-chain SLA enforcement on top of your existing infrastructure. Register a fee offer backed by posted collateral, accept incoming commit requests, settle with an MPT receipt proof, and earn fees. It does not replace your bundler node -- it wraps it with a slashing-backed SLA guarantee via the SureLock protocol.

Earn fees by providing on-chain bundler SLAs. Register an offer, watch for incoming commits, `accept()` them, include the UserOp on-chain, then `settle()` with a Merkle Patricia Trie receipt proof to claim the fee.

> **Testnet only -- Base Sepolia.** Mainnet after external audit.

```bash
npm install @surelock-labs/bundler ethers
```

---

## At a glance

**What you import:**
```typescript
import { createBundlerClient, buildSettleProof, DEPLOYMENTS, withRetry } from "@surelock-labs/bundler";
```

**What you monitor** -- one persistent listener, called for every new `PROPOSED` commit targeting your offer:
```typescript
const stop = client.watchCommits(signer.address, async (commit) => {
  await client.accept(signer, commit.commitId);   // lock collateral, start SLA clock
  // ... include commit.userOpHash via EntryPoint ...
  // ... build proof and call settle() within 256 blocks of inclusion ...
});
```

**What runs after inclusion** -- a single off-chain job triggered after your EntryPoint tx confirms:
```typescript
const inclusionBlock = (await provider.getTransactionReceipt(inclusionTxHash))!.blockNumber;
const { blockHeaderRlp, receiptProof, txIndex } =
  await withRetry(() => buildSettleProof(provider, inclusionBlock, inclusionTxHash));
await client.settle(signer, commit.commitId, BigInt(inclusionBlock), blockHeaderRlp, receiptProof, txIndex);
```

You have 256 blocks (~8.5 min on Base) from `inclusionBlock` to call `settle()`. Miss it -> commit becomes REFUNDED and you forfeit collateral.

---

## Quick start

```typescript
import { createBundlerClient, buildSettleProof, DEPLOYMENTS, withRetry } from "@surelock-labs/bundler";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const { registry, escrow } = DEPLOYMENTS[84532]; // Base Sepolia testnet
// DEPLOYMENTS contains official addresses verified and maintained by SureLock Labs.
// Base Sepolia (84532) is live now. Base Mainnet (8453) will be added at launch.
// For local development, pass your own deployed addresses instead of using DEPLOYMENTS.

const client = createBundlerClient({
  rpcUrl: "https://sepolia.base.org",
  registryAddress: registry,
  escrowAddress:   escrow,
  provider,
});

// 1. Deposit collateral and register an offer
await client.deposit(signer, ethers.parseEther("0.1"));

const quoteId = await client.register(signer, {
  feePerOp:      ethers.parseUnits("100", "gwei"), // fee earned per UserOp on settle
  slaBlocks:     10,                                // blocks to include (~20s on Base)
  collateralWei: ethers.parseUnits("200", "gwei"), // must be strictly > feePerOp (T8)
});

// 2. Watch for PROPOSED commits and handle them
const stop = client.watchCommits(signer.address, async (commit) => {
  // You have ACCEPT_GRACE_BLOCKS (12) to call accept().
  // If you don't, the client can cancel() and recover their fee. No collateral at risk until you accept().
  await client.accept(signer, commit.commitId);

  // Include commit.userOpHash via EntryPoint, then build and submit the MPT proof.
  // settle() must be called within 256 blocks of inclusion (EVM blockhash limit).
  const inclusionReceipt = await provider.getTransactionReceipt(inclusionTxHash);
  if (!inclusionReceipt?.blockNumber) throw new Error("inclusion receipt missing");
  const inclusionBlock = inclusionReceipt.blockNumber;

  // buildSettleProof is a standalone function, not a client method.
  // withRetry handles "header not found" from lagging RPC nodes.
  const { blockHeaderRlp, receiptProof, txIndex } =
    await withRetry(() => buildSettleProof(provider, inclusionBlock, inclusionTxHash));

  await client.settle(signer, commit.commitId, BigInt(inclusionBlock), blockHeaderRlp, receiptProof, txIndex);
});

// 3. Claim accumulated fees
const claimed = await client.claimPayout(signer);
console.log(`Claimed ${ethers.formatUnits(claimed, "gwei")} gwei`);

stop(); // unsubscribe when done
```

---

## How it works

1. You deposit ETH collateral into `SLAEscrow`.
2. You register an offer on `QuoteRegistry` -- fee, SLA window, collateral locked per commit. `collateralWei > feePerOp` is strictly enforced.
3. A client calls `commit()` against your offer. It enters `PROPOSED` -- **collateral is not locked yet**.
4. You have `ACCEPT_GRACE_BLOCKS = 12` (~24s on Base) to call `accept(commitId)`. This locks `collateralLocked` from your idle balance and starts the SLA clock. The commit moves to `ACTIVE`.
5. You include the UserOp on-chain through the canonical EntryPoint within `slaBlocks`.
6. You call `settle()` with a Merkle Patricia Trie receipt proof. The contract verifies `blockhash(inclusionBlock)`, walks the receipt trie, and confirms a `UserOperationEvent` with the matching hash. On success you earn the full `feePerOp`.

**If you never accept** -- the commit becomes CANCELLED after the accept window. The client calls `cancel()` and recovers their `feePerOp`. You lose nothing, earn nothing.

**If you accept but miss the SLA** -- the commit becomes REFUNDED. The client calls `claimRefund()` and receives `feePerOp + collateralLocked`. You forfeit `collateralLocked`.

**256-block window.** `blockhash()` is only retained for the last 256 blocks (~8.5 min on Base). The sequence: include the UserOp -> call `settle()` before `inclusionBlock + 256`. Monitor every block after inclusion. Flag "included but not settled" around block +200 as a warning -- after +256 the proof is permanently unsubmittable and the commit becomes REFUNDED.

**Self-commit is blocked.** `commit()` reverts `SelfCommitForbidden` if `msg.sender == bundler`.

---

## API

**Return values.** `deposit()`, `withdraw()`, `deregister()`, `accept()`, `settle()`, and `claimPayout()` all await the transaction internally and return `undefined` (or `bigint` for `claimPayout`). Do not expect transaction objects -- just `await` them.

**DEPLOYMENTS.** Only Base Sepolia (`84532`) is exported. For a local hardhat node or other networks, pass contract addresses directly.

### Offer management

#### `register(signer, params)` -> `Offer`

Returns the full `Offer` (ready to pass to `commitOp`), not just the `quoteId`.

```typescript
const offer = await client.register(signer, {
  feePerOp:      ethers.parseUnits("100", "gwei"),
  slaBlocks:     10,
  collateralWei: ethers.parseUnits("200", "gwei"), // must be strictly > feePerOp (T8)
});
// offer.quoteId, offer.collateralWei, ... all populated
```

**Registration bond.** The contract charges a one-time registration bond (currently 0.01 ETH on testnet; read via `registry.registrationBond()`). The SDK fetches the current value from the contract on every call -- you do not need to pass it. Bond is refunded (pull-only, via `claimBond()`) when you call `deregister()`.

**Optional params.** `lifetime` defaults to `302_400` blocks (~3.5 days, the minimum). Override if you need a longer listing window.

```typescript
const offer = await client.register(signer, {
  feePerOp:      ethers.parseUnits("100", "gwei"),
  slaBlocks:     10,
  collateralWei: ethers.parseUnits("200", "gwei"),
  lifetime:      302_400, // optional -- default is MIN_LIFETIME (~3.5 days)
});
```

Register with a longer `slaBlocks` if your latency isn't reliable. One miss can wipe the profit from many good runs.

#### `renew(signer, quoteId)`

Extends an offer's lifetime by resetting `registeredAt` to the current block. Call before the offer expires to avoid re-paying the bond.

```typescript
await client.renew(signer, quoteId);
```

#### `deregister(signer, quoteId)`

Deactivates the offer. Already-open commits (PROPOSED or ACTIVE) continue until they settle or expire. Bond is moved to `pendingBonds` -- claim it with `claimBond()` below.

```typescript
await client.deregister(signer, quoteId);
await client.claimBond(signer); // pulls bond to bundler wallet
```

#### `deregisterExpired(signer, quoteId)`

Permissionless cleanup of an offer past its `lifetime`. Anyone can call this; the bond still goes to the offer's bundler's `pendingBonds` (not the caller's).

#### `claimBond(signer)` -> `amount`

Pulls the caller's accumulated `pendingBonds` from the registry. Returns the amount claimed (`0n` if nothing pending). The contract's bond flow is pull-only (CEI-compliant); `claimBond` is always the second step after `deregister`.

```typescript
const amount = await client.claimBond(signer);
```

#### `getPendingBond(bundlerAddress)` -> balance

View helper for pending bond balance -- useful before calling `claimBond`.

---

### Collateral

#### `deposit(signer, amount)`

```typescript
await client.deposit(signer, ethers.parseEther("1"));
```

#### `withdraw(signer, amount)`

Withdraws idle (unlocked) collateral only. Collateral locked by ACTIVE commits cannot be withdrawn until those commits resolve.

```typescript
const idle = await client.getIdleBalance(signer.address);
await client.withdraw(signer, idle);
```

#### `getDeposited(bundlerAddress)` -> total balance (idle + locked)

#### `getIdleBalance(bundlerAddress)` -> withdrawable balance

```typescript
const total  = await client.getDeposited(signer.address);
const idle   = await client.getIdleBalance(signer.address);
const locked = total - idle; // currently locked by ACTIVE commits
```

---

### Commit lifecycle

#### `accept(signer, commitId)`

Transitions a `PROPOSED` commit to `ACTIVE`, locking `collateralLocked` and setting `deadline = block.number + slaBlocks`.

Must be called within `ACCEPT_GRACE_BLOCKS` (12) of the commit block.

```typescript
await client.accept(signer, commitId);
```

Reverts `InsufficientCollateral` if idle balance is too low. Check `idle >= offer.collateralWei` before accepting.

#### `settle(signer, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex)`

Call after including the UserOp and building the MPT proof.

```typescript
const inclusionReceipt = await provider.getTransactionReceipt(inclusionTxHash);
const inclusionBlock = inclusionReceipt.blockNumber;

// buildSettleProof is a standalone function -- import it directly, not from the client.
const { blockHeaderRlp, receiptProof, txIndex } =
  await withRetry(() => buildSettleProof(provider, inclusionBlock, inclusionTxHash));

await client.settle(signer, commitId, BigInt(inclusionBlock), blockHeaderRlp, receiptProof, txIndex);
```

The contract verifies:
1. `keccak256(blockHeaderRlp) == blockhash(inclusionBlock)` -- header matches canonical chain
2. The RLP-decoded `receiptsRoot` is consistent with the header
3. The MPT proof walks to a receipt at `txIndex`
4. That receipt contains a `UserOperationEvent` from `ENTRY_POINT` with the committed `userOpHash`
5. `inclusionBlock <= commit.deadline`

On success, `feePerOp` is credited to your `pendingWithdrawals` and the commit enters `SETTLED`.

#### `claimPayout(signer)` -> amount claimed

```typescript
const claimed = await client.claimPayout(signer);
```

#### `getCommit(commitId, blockTag?)` -> `CommitInfo`

Pass `blockTag` to pin the read to a specific block. Essential right after a write on load-balanced RPCs where "latest" may still trail the node that accepted the tx.

```typescript
const commit = await client.getCommit(commitId);

// After a write, pin the read to the receipt's block:
const rcpt = await client.accept(signer, commitId);
const commitAfter = await client.getCommit(commitId, rcpt.blockNumber);
```

---

### Event watching

#### `watchCommits(bundlerAddress, callback)` -> unsubscribe

```typescript
const stop = client.watchCommits(signer.address, async (commit) => {
  console.log(`New PROPOSED commit ${commit.commitId} -- accept by block ${commit.acceptDeadline}`);
  // accept, include, settle...
});

stop(); // unsubscribe
```

`PendingCommit` fields: `commitId`, `quoteId`, `user`, `userOpHash`, `acceptDeadline`.

---

## Standalone functions

All functions work standalone with explicit arguments:

```typescript
import {
  register, deregister, deposit, withdraw,
  accept, settle, claimPayout, getCommit,
  getIdleBalance, getDeposited, watchCommits,
  buildSettleProof, withRetry, DEPLOYMENTS,
} from "@surelock-labs/bundler";

const { registry, escrow } = DEPLOYMENTS[84532];

const quoteId = await register(signer, registry, { feePerOp, slaBlocks, collateralWei });
await deposit(signer, escrow, amount);

const idle = await getIdleBalance(provider, escrow, signer.address);

const rpc = { send: (m: string, p: unknown[]) => (provider as any).send(m, p) };
const stop = watchCommits(provider, escrow, signer.address, async (commit) => {
  await accept(signer, escrow, commit.commitId);
  // ...include UserOp on-chain, build proof...
  const inclusionReceipt = await provider.getTransactionReceipt(inclusionTxHash);
  const inclusionBlock = inclusionReceipt!.blockNumber;
  const { blockHeaderRlp, receiptProof, txIndex } =
    await withRetry(() => buildSettleProof(rpc, inclusionBlock, inclusionTxHash));
  await settle(signer, escrow, commit.commitId, BigInt(inclusionBlock), blockHeaderRlp, receiptProof, txIndex);
});
```

---

## Types

```typescript
interface RegisterOfferParams {
  feePerOp:      bigint;   // wei
  slaBlocks:     number;   // blocks (~2s/block on Base)
  collateralWei: bigint;   // wei -- must be strictly > feePerOp (T8)
  lifetime?:     number;   // blocks -- defaults to 302,400 (MIN_LIFETIME, ~3.5 days)
  bond?:         bigint;   // wei -- auto-fetched from registry if omitted (currently 0.01 ETH on testnet)
}

interface PendingCommit {
  commitId:       bigint;
  quoteId:        bigint;
  user:           string;
  userOpHash:     string;
  acceptDeadline: bigint; // last block at which accept() will succeed
}

interface CommitInfo {
  commitId:         bigint;
  user:             string;
  feePaid:          bigint;
  bundler:          string;
  collateralLocked: bigint;
  deadline:         bigint;  // 0 until accept()
  settled:          boolean;
  refunded:         boolean;
  quoteId:          bigint;
  userOpHash:       string;
  inclusionBlock:   bigint;  // 0 until settle()
  accepted:         boolean;
  cancelled:        boolean;
  acceptDeadline:   bigint;
  slaBlocks:        number;
}

interface BundlerConfig {
  rpcUrl:          string;
  registryAddress: string;
  escrowAddress:   string;
  // Must be JsonRpcProvider -- buildSettleProof needs raw provider.send()
  provider?:       ethers.JsonRpcProvider;
}
```

---

## CANCELLED state -- what it means for you

A commit becomes CANCELLED in two scenarios:

1. **CLIENT cancels proactively** -- during the 12-block accept window, CLIENT calls `cancel()` before you respond. This is their right.
2. **Accept window expires** -- you don't call `accept()` in time. Afterwards, any party can call `cancel()`.

**In both cases, you lose nothing.** Collateral is never locked until you call `accept()`.

A CANCELLED commit means: no fee earned, no collateral lost, no on-chain action required from you.

Calling `cancel()` yourself on expired commits is good hygiene -- it releases the client's fee sooner.

If you need to check whether a commit has already been cancelled before accepting:

```typescript
const stop = client.watchCommits(signer.address, async (commit) => {
  const state = await client.getCommit(commit.commitId);
  if (state.cancelled) return; // already gone
  await client.accept(signer, commit.commitId);
});
```

**Off-chain reputation matters.** Systematic non-acceptance is observable on-chain. Routing SDKs track `acceptRate` and deprioritize bundlers with high cancel rates.

---

## Economics

- **Protocol fee:** flat `PROTOCOL_FEE_WEI` per commit, paid by the client. Non-refundable on every path. Defaults to `0` at deploy; activated post-launch via a 48h timelock. You always earn the full `feePerOp` on settle -- no cut.

- **On accept timeout (CANCELLED):** you earn nothing, lose nothing. Collateral was never locked.

- **On SLA miss (REFUNDED):** you lose `collateralLocked`. Because `collateralWei > feePerOp` is strictly enforced, a deliberate miss is always net-negative (T8).

- **Capital efficiency:** each `ACTIVE` commit locks `collateralLocked` from your idle balance. `PROPOSED` commits don't lock anything -- only `accept()` does. Run as many simultaneous ACTIVEs as `idleBalance / collateralWei` allows.

## For wallet/dapp builders

Use [`@surelock-labs/router`](https://www.npmjs.com/package/@surelock-labs/router) to fetch offers, pick the best one, and commit a UserOp.

## Disclaimer

This software is provided as-is, without warranty. The contracts have not been externally audited. Testnet only -- do not use with real funds until a mainnet release is announced.

You are responsible for your own keys, collateral, and any ETH you deposit. One bad run can wipe many good ones -- size your collateral accordingly. Read the code. Verify the contracts on Basescan.

## License

MIT
