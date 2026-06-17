# Protocol Overview

SureLock separates three things that are easy to confuse:

- `commit()` reserves a specific `userOpHash`; provider collateral is not locked yet.
- `accept()` is the provider's explicit consent; collateral locks and the SLA deadline starts.
- Each offer declares one compatible EntryPoint. This is a provider capability claim used by routers and watchers, not a cryptographic proof.
- Watchers resolve outcomes. They observe EntryPoint activity off-chain and call `settle`, `refund`, or `cancel`; the contracts enforce timing, authorization, and payout accounting.

Balances are internal credits. Providers, clients, and the fee recipient withdraw credited funds explicitly.

Offers and commitments live in the same `SureLock` contract. `WatcherRegistry` only authorizes watcher accounts and forwards resolution calls.

## Reference

| From | Action | To |
|---|---|---|
| none | `commit` | `Proposed` |
| `Proposed` | `accept` | `Active` |
| `Proposed` | `cancel` | `Cancelled` |
| `Active` | `settle` | `Settled` |
| `Active` | `refund` | `Refunded` |

```mermaid
sequenceDiagram
    title Provider lifecycle
    actor Provider
    participant SureLock

    Provider->>SureLock: register(entryPoint, feePerOp, slaBlocks, collateral, lifetime)
    Provider->>SureLock: deposit collateral
    Note over SureLock: A client commit creates pending work
    Provider->>SureLock: accept(commitId)
    SureLock-->>SureLock: lock collateral
    Note over SureLock: Success credits feePerOp and unlocks collateral
    Note over SureLock: SLA miss slashes collateral to the client
    Provider->>SureLock: renew(offerId)
    Provider->>SureLock: deactivate(offerId)
    Provider->>SureLock: withdraw idle balance
```

```mermaid
sequenceDiagram
    title Client lifecycle
    actor Client
    participant SureLock

    Client->>SureLock: read active offers
    Client->>SureLock: commit(offerId, userOpHash, acceptWindowBlocks)
    Note over SureLock: Happy path credits provider feePerOp
    Note over SureLock: SLA miss credits client feePerOp + collateral
    Note over SureLock: No-accept cancel credits client feePerOp
    Client->>SureLock: withdraw credited balance
```

```mermaid
sequenceDiagram
    title Happy path: accepted and included before deadline
    actor Provider
    participant SureLock
    participant WatcherRegistry
    participant EntryPoint
    actor Watcher

    Provider->>SureLock: accept(commitId)
    SureLock-->>SureLock: lock collateral
    Provider->>EntryPoint: include UserOperation
    EntryPoint-->>Watcher: UserOperationEvent(userOpHash)
    Watcher->>WatcherRegistry: settle(surelock, commitId, inclusionBlock)
    WatcherRegistry->>SureLock: settle(commitId, inclusionBlock)
    SureLock-->>Provider: credit feePerOp
    SureLock-->>SureLock: unlock collateral
```

```mermaid
sequenceDiagram
    title SLA miss path: accepted but not included before deadline
    actor Client
    actor Provider
    participant SureLock
    participant WatcherRegistry
    actor Watcher

    Provider->>SureLock: accept(commitId)
    SureLock-->>SureLock: lock collateral
    Watcher->>WatcherRegistry: refund(surelock, commitId)
    WatcherRegistry->>SureLock: refund(commitId)
    SureLock-->>Client: credit feePerOp + collateral
```

```mermaid
sequenceDiagram
    title No-accept path: provider never accepts
    actor Client
    participant SureLock
    participant WatcherRegistry
    actor Watcher

    alt client cancels during accept window
        Client->>SureLock: cancel(commitId)
    else accept window expired
        Watcher->>WatcherRegistry: cancel(surelock, commitId)
        WatcherRegistry->>SureLock: cancel(commitId)
    end

    SureLock-->>Client: credit feePerOp
    SureLock-->>SureLock: release userOpHash
```
