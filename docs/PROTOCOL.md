# Protocol Overview

SureLock separates three things that are easy to confuse:

- `commit()` reserves a specific `userOpHash`; provider collateral is not locked yet.
- `accept()` is the provider's explicit consent; collateral locks and the SLA deadline starts.
- Watchers resolve outcomes. They observe EntryPoint activity off-chain and call `settle`, `refund`, or `cancel`; the contracts enforce timing, authorization, and payout accounting.

Balances are internal credits. Providers, clients, and the fee recipient withdraw credited funds explicitly.

```mermaid
sequenceDiagram
    title Provider lifecycle
    actor Provider
    participant OfferRegistry
    participant SLAEscrow

    Provider->>OfferRegistry: register(feePerOp, collateral, slaBlocks, lifetime)
    Provider->>SLAEscrow: deposit collateral
    Note over SLAEscrow: A client commit creates pending work
    Provider->>SLAEscrow: accept(commitId)
    SLAEscrow-->>SLAEscrow: lock collateral
    Note over SLAEscrow: Success credits feePerOp and unlocks collateral
    Note over SLAEscrow: SLA miss slashes collateral to the client
    Provider->>OfferRegistry: renew(offerId)
    Provider->>OfferRegistry: deactivate(offerId)
    Provider->>SLAEscrow: withdraw idle balance
```

```mermaid
sequenceDiagram
    title Client lifecycle
    actor Client
    participant OfferRegistry
    participant SLAEscrow

    Client->>OfferRegistry: read active offers
    Client->>SLAEscrow: commit(offerId, userOpHash, acceptWindowBlocks)
    Note over SLAEscrow: Happy path credits provider feePerOp
    Note over SLAEscrow: SLA miss credits client feePerOp + collateral
    Note over SLAEscrow: No-accept cancel credits client feePerOp
    Client->>SLAEscrow: withdraw credited balance
```

```mermaid
sequenceDiagram
    title Happy path: accepted and included before deadline
    actor Provider
    participant SLAEscrow
    participant WatcherRegistry
    participant EntryPoint
    actor Watcher

    Provider->>SLAEscrow: accept(commitId)
    SLAEscrow-->>SLAEscrow: lock collateral
    Provider->>EntryPoint: include UserOperation
    EntryPoint-->>Watcher: UserOperationEvent(userOpHash)
    Watcher->>WatcherRegistry: settle(escrow, commitId, inclusionBlock)
    WatcherRegistry->>SLAEscrow: settle(commitId, inclusionBlock)
    SLAEscrow-->>Provider: credit feePerOp
    SLAEscrow-->>SLAEscrow: unlock collateral
```

```mermaid
sequenceDiagram
    title SLA miss path: accepted but not included before deadline
    actor Client
    actor Provider
    participant SLAEscrow
    participant WatcherRegistry
    actor Watcher

    Provider->>SLAEscrow: accept(commitId)
    SLAEscrow-->>SLAEscrow: lock collateral
    Watcher->>WatcherRegistry: refund(escrow, commitId)
    WatcherRegistry->>SLAEscrow: refund(commitId)
    SLAEscrow-->>Client: credit feePerOp + collateral
```

```mermaid
sequenceDiagram
    title No-accept path: provider never accepts
    actor Client
    participant SLAEscrow
    participant WatcherRegistry
    actor Watcher

    alt client cancels during accept window
        Client->>SLAEscrow: cancel(commitId)
    else accept window expired
        Watcher->>WatcherRegistry: cancel(escrow, commitId)
        WatcherRegistry->>SLAEscrow: cancel(commitId)
    end

    SLAEscrow-->>Client: credit feePerOp
    SLAEscrow-->>SLAEscrow: release userOpHash
```
