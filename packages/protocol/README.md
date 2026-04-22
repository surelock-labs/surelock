# @surelock-labs/protocol

Contracts, ABIs, TypeChain types, and deployment addresses for SureLock -- on-chain SLA enforcement for ERC-4337 bundlers.

A bundler posts collateral and registers an offer. A client commits to that offer for a specific UserOp. If the bundler misses the deadline, the client is made whole on-chain -- no arbitration, no trusted oracle.

---

## How it works

### Three actors

| Actor | Role |
|---|---|
| **BUNDLER** | Posts collateral, registers offers, includes UserOps on-chain |
| **CLIENT** | Commits to an offer, pays the service fee upfront |
| **PROTOCOL** | Collects a flat per-commit enforcement fee; cannot alter committed terms |

### Lifecycle

```
BUNDLER                        CLIENT
  |                              |
  +- register(offer)             |        QuoteRegistry -- strict collateral > fee
  +- deposit(collateral)         |
  |                              +- commit(quoteId, userOpHash, ...)  --> SLAEscrow
  |                              |    |    value = feePerOp + protocolFee
  |                              |    |    CLIENT supplies canonical ERC-4337 userOpHash
  |                              |    |    protocol does not verify the full UserOp
  |                              |    |    blocks self-commit (SelfCommitForbidden)
  |                              |    +-> PROPOSED
  |
  +- accept(commitId)            |        SLAEscrow -- must be called within
  |    +- locks collateral       |        ACCEPT_GRACE_BLOCKS (12).
  |       starts SLA clock       |        PROPOSED -> ACTIVE
  |
  +--- include UserOp on-chain --------------------------------> EntryPoint
  |
  +- settle(commitId, proof)     |        SLAEscrow verifies:
  |    +- MPT receipt proof      |          1. blockHeaderRlp matches blockhash()
  |       anchored to blockhash  |          2. receiptsRoot from header
  |                              |          3. MPT path -> receipt at txIndex
  |                              |          4. receipt has UserOperationEvent
  |                              |             from ENTRY_POINT, matching hash,
  |                              |             and success == true
  v earns full feePerOp          |
                                 |  (if accept window expires without accept)
                                 +- cancel(commitId)         [CLIENT only during window;
                                 v recovers feePerOp          CLIENT/BUNDLER/feeRecipient after]
                                 |  no slash -- collateral was never locked
                                 |
                                 |  (if accepted but SLA deadline + grace window expires)
                                 +- claimRefund(commitId)
                                 v gets feePerOp + full collateralLocked (full slash)
```

### Settlement proof

`settle()` requires a Merkle Patricia Trie receipt proof demonstrating that the canonical EntryPoint emitted a `UserOperationEvent` with the committed `userOpHash` and `success == true` at or before the deadline block.

The proof is verified entirely on-chain against `blockhash(inclusionBlock)` -- no trusted party can fake it.

**EVM constraint:** the EVM only retains the most recent 256 blockhashes. Bundlers must call `settle()` within ~256 blocks (~8.5 min on Base) of the inclusion block.

### Economics at a glance

| Outcome | BUNDLER | CLIENT | PROTOCOL |
|---|---|---|---|
| **SETTLED** | +`feePerOp` (full, no cut) | receives service | +`PROTOCOL_FEE_WEI` (collected at commit) |
| **CANCELLED** | nothing (never accepted) | +`feePerOp` returned | +`PROTOCOL_FEE_WEI` (non-refundable) |
| **REFUNDED** | -`collateralLocked` (full slash) | +`feePerOp` + `collateralLocked` | +`PROTOCOL_FEE_WEI` (no slash share) |

`PROTOCOL_FEE_WEI` is a flat per-commit fee, non-refundable on every path. It starts at 0 at deploy and is activated post-launch via governance. PROTOCOL receives no share of slashed collateral -- the full collateral goes to CLIENT.

### Core guarantees

- **CLIENT is made whole on failure.** On SLA miss, CLIENT recovers `feePerOp` plus the full forfeited collateral. Only `PROTOCOL_FEE_WEI` (zero at launch) and transaction gas are unrecoverable.

- **Cheating is never profitable.** A bundler who deliberately misses loses both the collateral and the foregone fee.

- **Committed terms are immutable.** Once CLIENT commits, no actor -- including PROTOCOL -- can alter any parameter of that commitment.

- **No single actor can freeze resolution.** Every commitment resolves within a bounded, on-chain-deterministic time window. After expiry, CLIENT, BUNDLER, or PROTOCOL can trigger resolution -- CLIENT inaction cannot trap BUNDLER's collateral. No actor can redirect owed funds or block settlement of existing commitments.

- **Settlement is permissionless and self-verifiable.** Any party can verify an inclusion proof independently from on-chain data alone.

---

## Contracts

| Contract | Description |
|---|---|
| `QuoteRegistry` | Bundler offer registry -- register, renew, deregister offers |
| `SLAEscrow` | Collateral escrow -- commit, settle (with MPT proof), claimRefund, claimPayout |

`SLAEscrow` is deployed as a UUPS proxy.

On mainnet the proxy is owned by a `TimelockController` with a 48-hour delay. Before any upgrade can execute, governance must call `freezeCommits()` (blocking new commits) and wait for `_authorizeUpgrade()` to confirm the post-freeze resolution window has elapsed -- ensuring every open commitment can resolve before the upgrade lands.

---

## Development

```bash
cd packages/protocol
npm install
npx hardhat compile
npx hardhat test
```

For runnable examples and the playground REPL, see the [repository README](https://github.com/surelock-labs/surelock#running-locally).
