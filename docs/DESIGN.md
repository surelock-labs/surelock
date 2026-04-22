# SureLock -- Design Axioms

Three actors: **PROTOCOL** (deployer/fee recipient), **BUNDLER** (service provider), **CLIENT** (service consumer). Axioms are unconditional economic properties; every implementation decision must be consistent with all of them. They contain no protocol mechanics -- those are derived in the Theorems section.

**Trust model.** Mathematical guarantees hold between BUNDLER and CLIENT. PROTOCOL is enforcement infrastructure -- cannot alter committed terms, block settlement, or gate participation (T13-T16). However, PROTOCOL is a privileged operator: it controls the admin key, the fee recipient, and the upgrade path. The protocol makes PROTOCOL's behaviour mathematically unprofitable in all scenarios except T17, where CLIENT+PROTOCOL collusion against a cooperating BUNDLER is deterred structurally rather than mathematically. BUNDLERs and CLIENTs extend trust to PROTOCOL as they would to any infrastructure provider. This is an explicit design constraint, not an oversight.

**On-chain address mapping.** "PROTOCOL" as a caller of cleanup functions (`cancel()` after accept window expiry, `claimRefund()` after refund window opens) maps to the `feeRecipient` address -- the operational hot wallet. `feeRecipient` has no authority to act during active windows; CLIENT-only restrictions during the accept window still apply. Cleanup authority is attached to the current `feeRecipient` address at the time the cleanup function is called; it is not snapshotted per commitment. `feeRecipient` has no other state-mutating authority beyond cleanup. The `owner()` (TimelockController post-handover) governs parameter changes and upgrades only.

---

## Lifecycle

A BUNDLER registers an **offer** on-chain specifying per-op fee, required collateral, SLA window, and offer lifetime -- backed by a registration bond and by idle collateral posted separately. A CLIENT reads the offer, then **proposes** a commitment by sending `feePerOp + PROTOCOL_FEE_WEI` plus a client-supplied canonical `userOpHash`; the protocol does not verify possession of the full UserOp -- hash squatting is a bounded liveness issue described in Non-goals; at this point every parameter is snapshotted and `PROTOCOL_FEE_WEI` is credited immediately to PROTOCOL's pending withdrawal as a non-refundable enforcement fee, but **no collateral is locked** -- the commitment is **PROPOSED**. BUNDLER must explicitly **accept** the commitment within `ACCEPT_GRACE_BLOCKS`; on acceptance, the corresponding collateral is locked from BUNDLER's idle pool and the SLA deadline is set -- the commitment becomes **ACTIVE**. CLIENT may **cancel** the commitment at any time during the accept window. Once the window has expired without acceptance, CLIENT, BUNDLER, or PROTOCOL may cancel. In all cases CLIENT recovers `feePerOp` and `PROTOCOL_FEE_WEI` is retained by PROTOCOL. An ACTIVE commitment resolves when BUNDLER calls `settle()` with an on-chain proof of successful execution, or when BUNDLER fails to settle within the settlement grace window -- after which CLIENT, BUNDLER, or PROTOCOL may claim a refund once the refund window opens. A commitment resolves to one of three terminal states: **SETTLED** (BUNDLER proved successful execution through EntryPoint in time -> BUNDLER receives the full `feePerOp`), **REFUNDED** (BUNDLER failed to settle in time -> CLIENT recovers `feePerOp` plus the full slashed collateral), or **CANCELLED** (BUNDLER did not accept within `ACCEPT_GRACE_BLOCKS` -> CLIENT recovers `feePerOp`, no collateral slashed).

---

## Definitions

| Term | Meaning |
|---|---|
| offer | BUNDLER's on-chain ad: feePerOp, collateral, slaBlocks, lifetime. ID: `quoteId` |
| commitment | CLIENT's on-chain reservation against a specific offer + `userOpHash`; all params snapshotted at commit time |
| PROPOSED | commitment state: CLIENT has paid and params are snapshotted; BUNDLER has not yet accepted; no collateral locked |
| ACTIVE | commitment state: BUNDLER has accepted; collateral is locked; SLA deadline is running |
| SETTLED | terminal state: BUNDLER proved successful execution through EntryPoint in time; BUNDLER receives `feePerOp` |
| REFUNDED | terminal state: BUNDLER failed to settle by deadline; CLIENT recovers `feePerOp` + full collateral |
| CANCELLED | terminal state: commitment was cancelled before acceptance (by CLIENT during window, or by CLIENT/BUNDLER/PROTOCOL after window expired); CLIENT recovers `feePerOp`; no slash |
| feePerOp | exact ETH BUNDLER quoted; CLIENT sends at commit; BUNDLER receives in full on settle |
| protocolFee | `PROTOCOL_FEE_WEI`, flat wei/commit, credited to PROTOCOL at commit. Non-refundable in all outcomes including CANCELLED -- payment for enforcement, not for BUNDLER's delivery |
| totalCommitValue | `feePerOp + protocolFee`; total ETH CLIENT must send with commit call |
| collateral | ETH locked from BUNDLER idle pool at accept; forfeited in full to CLIENT on REFUNDED |
| registration bond | one-time BUNDLER deposit on offer registration; returned on deregister; distinct from collateral, serves as spam deterrent |
| ACCEPT_GRACE_BLOCKS | fixed block constant; the accept window -- `ACCEPT_GRACE_BLOCKS` blocks after commit() during which BUNDLER may call accept(); after expiry the commitment can be cancelled |
| SLA window | block range `(acceptBlock, acceptBlock + slaBlocks]` -- first eligible inclusion block is `acceptBlock + 1` |
| deadline | `acceptBlock + slaBlocks`; last block at which successful execution through EntryPoint honors the SLA |
| settlement grace | `SETTLEMENT_GRACE_BLOCKS` (10) blocks after deadline during which BUNDLER may still call settle() with valid proof; sized to survive normal Base reorgs |
| refund grace | fixed blocks after settlement grace; prevents settle/refund race; refunds available only after this window |
| slash | full collateral forfeited to CLIENT on REFUNDED. Protocol constant, not admin-configurable |
| userOpHash | ERC-4337 UserOp ID; uniqueness key across commitments |

---

## A1 -- PROTOCOL earns for enforcement, not for outcomes

PROTOCOL earns `PROTOCOL_FEE_WEI` per commit at commit time -- unconditionally, regardless of outcome. This fee is payment for the enforcement service itself: commit locking, deadline enforcement, and slashing machinery. PROTOCOL receives no share of slashed collateral; on REFUNDED the full collateral goes to CLIENT. Because PROTOCOL's only revenue is per-commit volume, PROTOCOL has no direct incentive for individual failures -- maximising aggregate revenue requires attracting honest BUNDLERs and satisfied CLIENTs. This is a structural bias, not a mathematical guarantee; T17 discusses the residual attack surface.

## A2 -- CLIENT is made whole on failure

On SLA miss, CLIENT recovers the full `feePerOp` plus the full forfeited collateral -- strictly more than `feePerOp` alone. The enforcement fee (`protocolFee`) and gas are the only unrecoverable costs; they are payment for the enforcement service, not for BUNDLER's delivery.

## A3 -- Cheating is never profitable

Within the protocol's in-protocol payoff model, no unilateral actor can gain more by violating their role than by honoring it. Every defection path available to a single actor acting alone costs the defector strictly more than it yields. T17 documents one residual attack surface -- a CLIENT+PROTOCOL collusion path against BUNDLER -- that is structurally deterred (PROTOCOL's revenue depends on honest-BUNDLER volume) rather than mathematically closed by A3 alone.

## A4 -- Conservation of value

Every wei is always assigned to exactly one claimant; no ETH enters or leaves the system without a corresponding actor action. Once a commitment enters a terminal state (SETTLED, REFUNDED, or CANCELLED), no further state transitions or payouts are possible for that commitment -- every state-mutating function must revert on a terminal commitment.

## A5 -- Independent settlement

Each actor can claim what they are owed using only on-chain data and the passage of time, without cooperation from any other actor. Independence means no counterparty cooperation is required; it does not mean actions are automatic -- some actor must still initiate the on-chain transaction.

## A6 -- Committed terms are immutable

Once CLIENT commits, every parameter governing that commitment is fixed and cannot be changed by any actor. This includes the collateral amount, `feePerOp`, `slaBlocks`, `userOpHash`, and the `protocolFee` value read from storage at the commit() call -- all snapshotted or consumed at commit time. (`protocolFee` is consumed immediately into PROTOCOL's pending withdrawal rather than stored on the commitment record, but it is read atomically with the `msg.value` check.) The collateral is locked when BUNDLER accepts, but the amount locked is determined by the snapshotted value from commit time, not re-read from the offer.

## A7 -- Protocol is self-sustaining

The protocol does not require subsidies or the degradation of any actor's margin to function; honest participation does not force any actor into negative EV. `PROTOCOL_FEE_WEI` may be set to zero (fee-inactive mode, e.g. at launch) or up to `MAX_PROTOCOL_FEE_WEI` -- both ends are valid operational choices, not protocol failures. BUNDLER's payout is never reduced by `PROTOCOL_FEE_WEI`: BUNDLER always receives exactly `feePerOp` on settlement. CLIENT's cost floor is `totalCommitValue`; on SLA miss (REFUNDED) CLIENT recovers `feePerOp` plus the full collateral; on cancellation (CANCELLED) CLIENT recovers `feePerOp` only -- no collateral was locked.

## A8 -- No actor can capture owed funds or freeze resolution

No single actor can unilaterally prevent another honest actor from receiving what they are owed, redirect funds away from their rightful owner, or freeze any resolution path (accept, cancel, settle, claimRefund, withdraw, claimPayout). Governance may globally stop new commitments via `freezeCommits()` under T22, but it cannot freeze settlement, refund, cancellation, or withdrawal of existing positions.

## A9 -- Bounded resolution

Every commitment becomes terminally resolvable within a finite, bounded time horizon. Two resolution windows exist:

- **Accept window (PROPOSED state):** Only CLIENT may cancel while the accept window is open. Once the accept window expires, CLIENT, BUNDLER, or PROTOCOL may trigger cancellation; `feePerOp` always flows to CLIENT.
- **Refund window (ACTIVE state):** BUNDLER may settle through the settlement grace window. Once the refund window opens, CLIENT, BUNDLER, or PROTOCOL may trigger claimRefund; `feePerOp` + collateral always flows to CLIENT.

**Invariant:** The settle window and the refund window are strictly non-overlapping -- `settle()` is callable only before the refund window opens, and `claimRefund()` is callable only after it opens. No commitment can be both settled and refunded. Between the two windows there is a `REFUND_GRACE_BLOCKS`-block dead zone during which neither function succeeds; this gap is what prevents a settle/refund race at the boundary.

**Function-level authority:** `accept()` can only be called by the BUNDLER of the referenced offer -- this is the consent act that T25 depends on. `settle()` can be called by any address (relay/keeper services may submit proofs on BUNDLER's behalf); the `feePerOp` payout always credits the snapshotted BUNDLER address regardless of caller. `cancel()` and `claimRefund()` follow the actor lists above.

cancel() and claimRefund() are restricted to parties with a direct stake in the commitment; settle() is explicitly permissionless. Unrestricted third-party access to cancellation or refund would expose the protocol to interference from actors with no legitimate interest. ETH always flows to its rightful owner regardless of which of the three triggers resolution. PROTOCOL has platform-integrity incentive to trigger cleanup on long-expired commits. BUNDLER may self-trigger claimRefund to voluntarily close out a missed commitment (taking the slash) rather than leaving the state unresolved. CLIENT inaction does not permanently trap funds. The protocol must enforce a minimum SLA window > 0 and a maximum SLA window bounded enough that no commitment can lock funds for an unreasonable duration.

## A10 -- SLA fulfillment is verifiably on-chain

A commitment is honored if and only if the exact committed `userOpHash` is proven to have been included through the canonical EntryPoint contract with `success == true` at or before the deadline block. Inclusion alone (with `success == false`) does not satisfy the SLA; the UserOp must have executed successfully through EntryPoint.

Whether the committed userOpHash satisfied the SLA must be deterministically provable from on-chain data alone, without trusting BUNDLER's attestation. No actor can claim a settlement payout without providing proof that any independent verifier can check on-chain. BUNDLER settles by calling `settle(commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex)`. The escrow verifies a Merkle Patricia Trie receipt proof anchored to `blockhash(inclusionBlock)` -- if the proof is invalid, the call reverts.

**Attribution scope.** The proof establishes that the committed hash was successfully executed through EntryPoint; it does not prove which bundler caused the inclusion. The SLA is a hash-level delivery commitment, not a bundler-provenance guarantee. Settlement is permissionless -- any caller may submit a valid proof, and the payout always goes to the snapshotted bundler address. Bundler-specific attribution is only meaningful under the external assumption of exclusive private routing: if CLIENT routes the UserOp exclusively to the committed BUNDLER, then any valid settlement proof is effectively bundler-attributed. The protocol does not enforce this routing assumption on-chain.

**EVM constraint -- settlement deadline:** The EVM retains blockhashes for only the most recent 256 blocks (`BLOCKHASH` opcode returns zero for older blocks). BUNDLER must call `settle()` within 256 blocks of `inclusionBlock` -- approximately 8.5 minutes on Base. This is a hard EVM constraint, not a protocol parameter; it applies regardless of the SLA window length. When `MAX_SLA_BLOCKS >> 256`, a BUNDLER who includes a UserOp early in the SLA window may fail to settle before the blockhash expires, even though the inclusion was within the SLA deadline. BUNDLERs must account for this: late inclusion (close to the SLA deadline) followed by immediate settlement is safer than early inclusion with deferred settlement. The contract enforces this with an explicit `BlockHashUnavailable` revert before proof verification begins. `SETTLEMENT_GRACE_BLOCKS` is a small protocol constant (currently 10) and is always << 256; any future change to this constant must preserve `SETTLEMENT_GRACE_BLOCKS < 256`.

---

# Assumptions

Assumptions bound the threat model -- they describe what the protocol takes as given from its environment. Theorems hold *within* these assumptions; violations of an assumption are outside the protocol's security model.

**Chain finality.**
The protocol treats a block as final once its blockhash is available on-chain (within the EVM's 256-block window). Reorgs after settlement are outside the security model. BUNDLERs and CLIENTs operate under the same finality assumption as any other on-chain application; the protocol does not guarantee protection against deep reorgs. The 256-block `blockhash` horizon bounds the proof window. Because `MAX_SLA_BLOCKS` (1,000) exceeds 256, a BUNDLER who includes a UserOp early in the SLA window and defers `settle()` may lose the ability to prove inclusion even though the inclusion was within the SLA deadline. Protocol parameters do not guarantee proof availability for every valid inclusion; BUNDLERs must settle within 256 blocks of inclusion regardless of remaining SLA time (see A10).

**Block time.**
The T22 unit conversion (blocks to seconds) assumes approximately 2 s per block on Base. The protocol does not enforce block time on-chain; if Base significantly changes its block time this assumption must be re-evaluated and `minDelay` adjusted accordingly. The 2 s/block figure is an operational parameter, not a protocol invariant.

**BUNDLER bears execution risk.**
An honest BUNDLER who attempts to include the UserOp but fails due to external factors (mempool censorship, block builder exclusion, sequencer downtime) is treated as a miss by the protocol. Honest effort without verifiable on-chain successful execution through EntryPoint does not satisfy the SLA. BUNDLERs must price this execution risk into their collateral requirements, SLA windows, and `feePerOp` -- including the gas cost of constructing and submitting the on-chain inclusion proof. This is a design choice that shifts infrastructure risk onto BUNDLER; it is enforced by A10. BUNDLERs must also submit `settle()` within 256 blocks of the inclusion block (A10); the practical implication is that including a UserOp late in the SLA window is safer than including it early.

**Gas costs are external.**
Gas costs paid by any actor to interact with the protocol are outside the protocol's accounting. The theorems account for in-protocol ETH flows; the gas cost of a given action must be priced in by the actor choosing to take it.

---

# Non-goals

The protocol explicitly does *not* provide the following guarantees. Users requiring them must solve for them out-of-band.

- **Deep chain reorgs.** See the finality assumption.
- **Censorship below collateral threshold.** A BUNDLER who finds it profitable to be slashed (MEV, off-chain payment, regulatory compulsion) can always choose to miss the SLA. The protocol makes this expensive, not impossible; the slashing cost is the only defense.
- **Off-chain side payments.** Two parties that agree to act outside the protocol are not constrained by it.
- **PROTOCOL key loss.** If `feeRecipient` becomes unreachable, accumulated protocol fees are permanently locked in the pull-withdrawal mapping. No admin recovery path. PROTOCOL is responsible for maintaining a reachable recipient -- multisig recommended for mainnet.
- **Actor key loss.** Funds in `pendingWithdrawals` are pull-claimed by the earning address; if that address loses its key, the funds are permanently locked. Applies symmetrically to all actors.
- **Oracle or price-feed correctness.** The protocol accepts fee and collateral amounts as specified by BUNDLER at registration; it does not validate them against any external benchmark.
- **No discretionary pause of resolution paths.** There is no pause on `accept`, `cancel`, `settle`, `claimRefund`, `withdraw`, or `claimPayout`. Governance can permanently disable new `commit()` calls via `freezeCommits()` as a prerequisite for layout-changing upgrades; this is a global ingress stop applied uniformly to all users, not a selective whitelist/blacklist, and it does not block resolution or withdrawal of any existing position. If a critical bug is discovered post-deploy, the only remediation path is a UUPS upgrade through the timelock -- with the commit-resolution-window delay fully applied (T22).
- **T22 delay on testnet.** Testnet deployments (e.g. Sepolia with 60 s `minDelay`) do not satisfy T22's arithmetic and provide no meaningful upgrade protection. They exist solely to exercise the upgrade flow mechanics. The T22 guarantee is a mainnet requirement only.
- **Redundant routing.** At most one PROPOSED-or-ACTIVE commitment per `userOpHash` exists at any time (T23). A CLIENT cannot commit the same UserOp to multiple BUNDLERs simultaneously as a hedge -- if one commitment is unresolved, the hash slot is occupied until termination. Parallel routing requires sequential retries, each using a fresh UserOp and fresh hash (T23: hashes are permanently retired after any terminal state).
- **Hash-squatting prevention.** `commit()` accepts a client-supplied `userOpHash` and does not verify that the caller possesses the full UserOp. Any party who observes a `userOpHash` (e.g. from a mempool or relay) can commit it first, occupying the hash slot until the accept window expires and an authorized actor calls `cancel()`. Once any terminal state is reached (CANCELLED, SETTLED, or REFUNDED), `retiredHashes[userOpHash]` is set permanently (T23) -- the squatted hash can never be reused. The victim must build a fresh UserOp with a new hash. This is a bounded liveness issue, not a fund-loss risk: the squatter cannot lock bundler collateral (two-phase design), and the only unrecoverable cost to the squatter is `PROTOCOL_FEE_WEI + gas`.
- **Bundler provenance.** The settlement proof establishes that the committed `userOpHash` was successfully executed through EntryPoint; it does not prove which bundler caused the inclusion. Bundler-specific attribution requires exclusive private routing of the UserOp to the committed bundler -- an assumption the protocol does not enforce on-chain (A10).
- **Accept-window liveness gap.** A BUNDLER who withdraws idle collateral after a CLIENT's PROPOSED commitment cannot accept it. CLIENT may cancel at any point during or after the accept window; until cancel is called, the `userOpHash` slot remains occupied and cannot be rerouted to a backup BUNDLER. The CLIENT's fee is fully recovered on cancel; `PROTOCOL_FEE_WEI` and gas are the only unrecoverable costs. This is a liveness tradeoff intrinsic to two-phase commit: the accept window gives BUNDLER time to validate the UserOp off-chain before locking collateral, eliminating the fake-userOpHash griefing vector that one-phase commit exposed (T25).
- **Accept selectivity.** A BUNDLER with limited idle collateral may choose which PROPOSED commits to accept and which to ignore, effectively deferring or censoring specific CLIENTs. The ignored CLIENT recovers their fee after the accept window and may re-commit to a different bundler. On-chain FIFO enforcement is not implemented (prohibitive gas cost and complexity). The defense is off-chain reputation: aggregators and routing SDKs should deprioritize bundlers with high cancel rates.
- **No operator backstop beyond contract state.** The protocol operator is not an insurer. There is no reserve fund, no discretionary make-whole, and no formal obligation to cover losses outside the three modeled resolution paths (SETTLED, REFUNDED, CANCELLED). The protocol's financial guarantees are strictly bounded by collateral posted on-chain by BUNDLER. If funds are lost due to a smart contract bug, a deep reorg, or any event outside the modeled paths, the on-chain contract state is the complete and exclusive accounting. CLIENTs and BUNDLERs should not expect recovery beyond what the contract mechanically enforces.

---

# Trust reduction roadmap

The protocol launches upgradeable. Trust is reduced in explicit stages; each stage is a one-way ratchet -- no stage can be reversed.

**Stage 1 -- Launch (current).** Upgradeable UUPS proxy behind a 48 h `TimelockController` (T22). Admin functions (`setProtocolFeeWei`, `setRegistry`, `setFeeRecipient`) are governed through the timelock. Deployer EOA removed from `PROPOSER_ROLE` before mainnet; multisig becomes sole proposer.

**Stage 2 -- Freeze admin.** Protocol fee, registry address, and fee recipient are set to final production values. Call `freezeRegistry()` -- one-way lock on the registry address under the current implementation; because the UUPS upgrade path remains open in Stage 2, governance could still deploy new logic that ignores this flag. Hard immutability only arrives in Stage 3 when upgrades are removed. Timeline: post first major integration.

**Stage 3 -- Drop upgradeability.** Upgrade capability is renounced: `_authorizeUpgrade` overridden to unconditionally revert. The contract becomes fully immutable. Timeline: post external audit with no critical findings.

---

# Theorems

Theorems are derived properties -- what follows for specific actor behaviors given the axioms.

---

## Honest BUNDLER

**T1 -- Honest BUNDLER earns a known positive amount on service.**
Terms are fixed at commit time (A6); BUNDLER receives the full `feePerOp` on settlement -- `PROTOCOL_FEE_WEI` is taken from CLIENT at commit time and does not reduce BUNDLER's payout. BUNDLER can calculate exact payout before serving. Settlement requires on-chain proof that the committed userOpHash was successfully executed through EntryPoint at or before the deadline (A10) -- the settlement grace window extends the period in which BUNDLER may call settle(), not the SLA honor window itself. SLA honor is evaluated at the inclusion block; a non-overlapping grace window between the settle deadline and the refund window prevents races at the boundary. The gas cost of providing the on-chain inclusion proof must not exceed `feePerOp`; BUNDLERs must price this into their quoted fee. BUNDLERs should benchmark MPT proof verification gas empirically before setting `feePerOp`; this cost varies with trie depth and receipt size.

**T2 -- Honest BUNDLER's idle collateral is always accessible.**
Collateral not bound to an active or unresolved commitment is fully withdrawable at any time. A PROPOSED commitment does not lock any collateral -- only an ACTIVE commitment (after BUNDLER's explicit accept) does. BUNDLER is never locked into the protocol against their will, subject to bounded delay for ACTIVE commitments (A5, A8, A9, T25).

**T3 -- BUNDLER can withdraw an offer at any time without affecting active commitments.**
BUNDLER may deregister an offer freely. Withdrawal does not affect any commitment already made against that offer -- those proceed under the terms snapshotted at commit time (A6). A CLIENT who has read but not yet committed to a withdrawn offer will find their commit reverts. Registration bond is returned on deregister; distinct from collateral locked per commitment. A BUNDLER who deregisters retains the ability to `accept()` any already-PROPOSED commitment until its accept window expires, subject to sufficient idle collateral at accept time (T23). Deregistration returns the registration bond only; idle collateral is withdrawn separately and its presence is checked at accept time as usual.

---

## Honest CLIENT

**T4 -- Honest CLIENT's unrecoverable cost is bounded by protocolFee + gas.**
CLIENT pays `totalCommitValue = feePerOp + protocolFee` at commit time (A6). `protocolFee` is the non-refundable enforcement fee -- consumed at commit regardless of outcome. Three resolution paths: (1) BUNDLER accepts and fulfills (SETTLED): CLIENT receives the service; (2) BUNDLER accepts and misses (REFUNDED): CLIENT recovers `feePerOp` plus the full forfeited collateral -- strictly more than `feePerOp` alone (A2, A7); (3) BUNDLER never accepts (CANCELLED): CLIENT cancels and recovers `feePerOp`. In all cases `protocolFee` and gas are the only unrecoverable costs. Gas costs are outside the protocol's accounting.

**T5 -- Honest CLIENT is never bound to terms they did not read.**
Every parameter binding CLIENT -- including `PROTOCOL_FEE_WEI` -- is readable on-chain before commitment. The commit call requires `msg.value == feePerOp + PROTOCOL_FEE_WEI` evaluated at execution time against live storage. If either value changed between CLIENT's off-chain read and on-chain execution, the check fails and the commit reverts -- CLIENT is never silently bound to a different fee. CLIENT must re-read and re-submit after any such revert (A6, A8).

---

## Honest PROTOCOL

**T6 -- Honest PROTOCOL's primary revenue is tied to commit volume, not BUNDLER performance.**
PROTOCOL earns `PROTOCOL_FEE_WEI` on every commit at commit time, unconditionally (A1). PROTOCOL receives no share of slashed collateral -- on REFUNDED the full collateral goes to CLIENT. PROTOCOL's only revenue is per-commit enforcement fees, making it structurally incentivized to maximize commit volume, not to provoke misses. Revenue = `PROTOCOL_FEE_WEI` x commit_volume only. No slash share. Because the sole revenue channel is volume-dependent, PROTOCOL has no incentive to cause failures -- provoking misses reduces the commit volume that funds the protocol (A1, A7).

**T7 -- Honest PROTOCOL cannot be blocked from protocol fees.**
`PROTOCOL_FEE_WEI` is credited to PROTOCOL's pending withdrawal at commit time -- no further action by BUNDLER or CLIENT is needed for PROTOCOL to claim it (A5).

---

## Cheating BUNDLER

**T8 -- Deliberate SLA miss is net-negative.**
The protocol enforces `collateral > feePerOp` (strict) at registration, with `feePerOp > 0` and `collateral > 0` guaranteed. A BUNDLER who misses the SLA loses both the forfeited collateral and the foregone honor fee in the same event; total P&L loss = `collateral + feePerOp > 0`. Defection is strictly net-negative (A3). This holds even when the miss targets off-chain value (MEV, censorship) -- that attack is only rational if the off-chain value exceeds the forfeited collateral, a threshold the protocol controls via bond requirements.

**T9 -- Bait-and-switch is impossible.**
Offers are immutable once registered -- there is no `updateOffer`; parameter changes require deregistering and registering a new offer with a new `quoteId`. A BUNDLER who changes offer terms after CLIENT's read causes the commit to revert. A BUNDLER who changes terms after CLIENT's commit cannot alter the snapshotted record (A6). A BUNDLER cannot front-run CLIENT's pending commit by substituting a new offer -- the commit references a specific offer identity (`quoteId`), and any mismatch causes revert.

**T10 -- BUNDLER+CLIENT collusion (self-slashing) is net-negative.**
A BUNDLER who deliberately misses while colluding with a sybil CLIENT: sybil CLIENT pays `feePerOp + protocolFee`; BUNDLER loses `collateral`; sybil CLIENT receives `feePerOp + collateral` on refund. Since BUNDLER and sybil CLIENT are the same economic entity, `feePerOp` and `collateral` are intra-pair transfers -- both cancel out. The pair's real loss is `protocolFee + gas` on both the self-slash path and the honest path. The decisive difference is the service: on the honest path the UserOp is processed (positive value to CLIENT); on self-slash it is not. Self-slashing is never strictly better than honoring, and is strictly worse whenever the service has positive value to CLIENT (A3). The attack is therefore only rational for an adversary who never intended to use the service -- in which case T11 applies: the cost is `protocolFee + gas` per attempt.

---

## Cheating CLIENT

**T11 -- Griefing always has a minimum cost.**
A CLIENT who commits with no intent to use the service forfeits `protocolFee` (`PROTOCOL_FEE_WEI`) unconditionally, plus gas -- in all outcomes including CANCELLED. In the two-phase model, a CLIENT committing with an unincludable `userOpHash` cannot unilaterally lock BUNDLER's collateral: BUNDLER simply does not accept and the commitment becomes cancellable after the accept window expires (T25). The adversarial CLIENT's loss is `protocolFee + gas` per attempt; BUNDLER's only cost is off-chain monitoring -- no on-chain action is required to decline. On a successful `claimRefund` (ACTIVE path), CLIENT recovers `feePerOp` plus the full collateral -- only `protocolFee` and gas are unrecoverable. No attack on BUNDLER is free (A3). To exhaust a BUNDLER through repeated griefing, the adversary's total cost scales with `(protocolFee + gas) x numberOfCommits`. `MAX_PROTOCOL_FEE_WEI` bounds the maximum enforcement fee PROTOCOL can set, keeping griefing cost predictable for CLIENTs. In fee-inactive mode (`PROTOCOL_FEE_WEI = 0`), the griefing floor collapses to gas only -- T11's minimum-cost guarantee is then as strong as the gas cost of a commit call. A non-zero `PROTOCOL_FEE_WEI` is required for a meaningful economic floor.

*Why `protocolFee` is non-refundable on CANCELLED.* A refinement that returns `protocolFee` when BUNDLER never accepts reopens the griefing vector: an attacker registers (or colludes with) a deliberately-inactive BUNDLER offer, commits to it, lets the accept window expire, cancels, and recovers the fee -- collapsing the per-attempt cost to gas only, which is the same economic state T11 identifies as the `PROTOCOL_FEE_WEI = 0` floor. Non-refundable resolution on every terminal path -- CANCELLED included -- is the invariant that keeps T11's cost floor load-bearing regardless of whether BUNDLER chose to accept. The fee is payment for the enforcement slot (commit locking, deadline machinery, state tracking), not for BUNDLER's delivery; it is earned the moment PROTOCOL reserves that slot, independent of how the commitment ultimately resolves (A1).

**T12 -- CLIENT cannot trap BUNDLER's collateral indefinitely.**
In PROPOSED state, BUNDLER's collateral is never at risk -- no collateral is locked until BUNDLER accepts (T25). In ACTIVE state: BUNDLER accepted, consenting to the collateral lock. After the refund window opens, CLIENT, BUNDLER, or PROTOCOL may trigger claimRefund; ETH always flows to CLIENT regardless of which of the three initiates. CLIENT inaction cannot freeze BUNDLER's capital or trap ETH indefinitely (A8, A9).

---

## Cheating PROTOCOL

**T13 -- PROTOCOL cannot extract from committed funds.**
After CLIENT commits, PROTOCOL cannot retroactively raise `PROTOCOL_FEE_WEI` against that commitment, seize collateral, or redirect payouts. Committed terms -- including the `protocolFee` snapshotted at commit time -- are fixed (A6, A8).

**T14 -- PROTOCOL cannot starve BUNDLER or CLIENT.**
On the honor path, BUNDLER receives the full `feePerOp` -- `PROTOCOL_FEE_WEI` is collected separately from CLIENT at commit time and does not reduce BUNDLER's payout. On the refund path, CLIENT receives `feePerOp + collateral` -- the full slashed amount, nothing withheld. PROTOCOL receives only `PROTOCOL_FEE_WEI` already collected at commit; it receives no share of the slash. No actor is reduced to zero on their respective path (A3, A7). Integer division precision loss from BPS computation is eliminated by the flat `PROTOCOL_FEE_WEI` model.

**T15 -- PROTOCOL cannot block settlement.**
Each actor settles independently. PROTOCOL cannot withhold cooperation to prevent BUNDLER or CLIENT from claiming what they are owed (A5). The pull model -- where all payouts are queued in a per-actor withdrawal mapping and claimed in a separate transaction -- ensures that even a malicious or non-cooperative `feeRecipient` cannot block BUNDLER or CLIENT from receiving their funds.

**T16 -- PROTOCOL cannot selectively gate participation.**
BUNDLER registration is permissionless. CLIENT commitment is permissionless except for the global, irreversible `freezeCommits()` latch used as a T22 upgrade prerequisite. PROTOCOL cannot whitelist, blacklist, or selectively deny access to specific actors. `freezeCommits()` applies uniformly to all users and does not block any resolution or withdrawal path.

---

## Collusion

**T17 -- CLIENT+PROTOCOL collusion against BUNDLER is deterred by structure, not math.**
In the two-phase model, a PROTOCOL-controlled sybil CLIENT cannot extract collateral from an honest BUNDLER by committing with an unincludable hash -- the honest BUNDLER simply does not accept, and the only loss is `protocolFee + gas` (T25, T11). The direct-extraction path against honest BUNDLERs is eliminated for the case where BUNDLER correctly evaluates the userOpHash before accepting. Residual execution risk remains: a BUNDLER may accept a hash that appears valid at accept time but becomes unincludable due to nonce exhaustion, EntryPoint state changes, or gas estimation errors between accept and inclusion. This is an operational risk for BUNDLER, not a protocol flaw -- the same risk exists in any non-atomic commit-then-execute system. What remains requires a *colluding BUNDLER* who deliberately accepts and then misses -- and when PROTOCOL is inside the colluding set, `protocolFee` cancels as an intra-party transfer, so the triad's in-protocol cost is gas only. The protocol does not make CLIENT+PROTOCOL collusion involving a cooperating BUNDLER mathematically unprofitable -- it makes it structurally irrational through three mechanisms: (1) **reputation exposure** -- PROTOCOL is a known, publicly deployed contract; a griefing campaign is observable on-chain by anyone and would destroy integrator trust immediately; (2) **BUNDLER exit** -- any BUNDLER who detects the pattern can deregister and withdraw idle collateral at any time (T2, T3), cutting off the attack; (3) **revenue destruction** -- PROTOCOL's primary revenue is `PROTOCOL_FEE_WEI` per commit volume; systematically eliminating honest BUNDLERs eliminates the commit volume that generates that revenue (A1). These are the real constraints on this attack vector. Participants should treat PROTOCOL as a reputationally-constrained operator, not as a mathematically-constrained one.

The current admin model is a launch-phase configuration, not a permanent design target. The governance-minimisation path is a staged public commitment:

- **Stage 1 (launch):** Upgradeable, admin-bounded, 48 h timelocked. All parameter changes observable on-chain for the full delay. Multisig proposer replaces deployer EOA before mainnet.
- **Stage 2 (post product-fit):** Freeze or remove specific admin functions as fee ranges and bond parameters are empirically validated. Tighten on-chain bounds to match observed safe ranges (T24). Each removal is an on-chain, irreversible transaction.
- **Stage 3 (long-term):** Remove upgradeability entirely. Hardcode or maximally bound all remaining parameters. At this point T17 becomes vacuous -- there is no admin lever left to enable the attack.

Each stage transition is a one-way ratchet: it can be verified on-chain and cannot be undone. Participants should calibrate their trust posture to the current stage, not the target stage. This graduation pattern follows Reflexer and Liquity; SureLock treats it as a binding public roadmap, not an aspiration.

**T18 -- BUNDLER+PROTOCOL collusion against other BUNDLERs is bounded.**
PROTOCOL cannot set fee parameters that discriminate between individual BUNDLERs -- parameters are global and apply equally to all offers. A colluding PROTOCOL can raise or lower `PROTOCOL_FEE_WEI` (affecting all CLIENTs equally) but cannot set offer-specific fees or tilt terms toward a specific BUNDLER. Parameter changes apply only to offers registered after the change; committed commitments are already snapshotted (A6).

---

## System-level

**T19 -- No funds can be permanently locked by protocol logic.**
Every wei is assigned to a claimant (A4). Every commitment resolves within a bounded time horizon (A9). BUNDLER and PROTOCOL both have operational incentive to trigger resolution if CLIENT is inactive -- BUNDLER to free locked state, PROTOCOL to maintain platform health. No combination of CLIENT inaction can trap funds indefinitely. However, funds in `pendingWithdrawals` are paid to the claiming address via `sendValue`; if the recipient is a non-payable smart contract or a contract that reverts on ETH receipt, those funds become permanently unreachable. Callers that cannot receive ETH at `msg.sender` should use `claimPayoutTo(to)` / `withdrawTo(to, amount)` / `claimBondTo(to)` to redirect to a payable address. The same limitation applies to PROTOCOL key loss (see Non-goals).

**T20 -- No single actor can capture the protocol.**
PROTOCOL cannot redirect committed funds (A6, A8). BUNDLER cannot retain collateral past deadline without settling (A3). CLIENT cannot prevent BUNDLER from settling (A5). Unilateral capture requires violating at least one axiom.

**T21 -- Honest participation is individually rational.**
When all actors behave honestly: PROTOCOL earns fees, BUNDLER earns service revenue, CLIENT receives the service. In the absence of external payoffs for defection, no actor can improve their outcome by deviating unilaterally from honest play (A3, A7).

**T22 -- Logic immutability requires infrastructure support.**
A6 guarantees committed terms are immutable in protocol logic. In a proxy architecture this holds only if the upgrade path carries a timelock delay long enough to give all participants notice and exit time.

The timelock provides an **observation guarantee**: any queued upgrade is visible on-chain for at least `minDelay` seconds before it can execute, giving every participant -- BUNDLER and CLIENT alike -- time to observe the pending change and exit (cancel PROPOSED commits, withdraw idle collateral, wait out ACTIVE commits) before the upgrade lands.

**What the delay does and does not protect.** The delay protects commitments that exist *at the moment an upgrade is queued*: those commits will resolve within `maxResolutionWindow` seconds, and a delay of `delay >= maxResolutionWindow` ensures the upgrade cannot land while they are still open. However, the delay does not protect commitments created *after* an upgrade is already queued -- a new commit created at `queue_time + delay - 1 second` may still be unresolved when the upgrade executes. The protocol implements Model A with an on-chain fence: governance calls `freezeCommits()` before queuing any layout-changing upgrade, which prevents new `commit()` calls at the contract level. `freezeCommits()` is a one-way ratchet and does not block any resolution function (accept, cancel, settle, claimRefund, withdraw).

**Upgrade enforcement.** `_authorizeUpgrade()` enforces these preconditions in code: (1) `commitsFrozen` must be true, and (2) at least `MAX_RESOLUTION_WINDOW_SECONDS` (2,056 s) must have elapsed since `freezeCommits()` was called. This guarantees every commitment created before the freeze is resolvable before any upgrade can execute. The 48 h `TimelockController` delay provides additional advance notice on top of this window.

**Ordering caveat.** `_authorizeUpgrade()` checks that freeze was active and the resolution window has elapsed *at execution time*; it does not verify that `freezeCommits()` was called before the upgrade was scheduled. The recommended sequence (freeze -> schedule -> execute) is a governance convention. A governance actor who schedules first and freezes later can still execute the upgrade once both conditions are satisfied; any commit created between scheduling and freezing has up to 48 h (the timelock delay) to resolve, which exceeds `MAX_RESOLUTION_WINDOW_SECONDS`, so the risk is bounded but the ordering guarantee is procedural rather than contract-enforced.

`maxResolutionWindow = (ACCEPT_GRACE_BLOCKS + MAX_SLA_BLOCKS + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1) x block_time_seconds`

On Base (2 s/block) at current constants: `(12 + 1,000 + 10 + 5 + 1) x 2 = 2,056 s ~= 34 min`; the 48 h mainnet delay satisfies this with very large margin. Testnet deployments with shorter delays (e.g. Sepolia at 60 s) do not satisfy T22 and carry no meaningful upgrade-protection guarantee; they exist only to test the upgrade flow mechanics.

`renounceOwnership()` is overridden on both QuoteRegistry and SLAEscrow to unconditionally revert with a custom error (`RenounceOwnershipDisabled`). Calling it would permanently brick all admin functions with no recovery path, equivalent to protocol capture (A8).

T22 applies to both contracts. `setRegistry()` affects only future commits. Because all commitment-critical fields -- `quoteId`, `bundler`, `feePerOp`, `collateralLocked`, `slaBlocks` -- are snapshotted into the `Commit` struct at `commit()` time and never re-read from the registry, changing the registry address cannot alter the resolution or economics of any existing commitment. A Certora rule (`setRegistry_noAffectOpenCommits`) verifies this claim formally. `freezeRegistry()` disables `setRegistry()` under the current implementation; it is part of Stage 2 (admin freeze) in the trust-reduction roadmap. Because upgrades remain possible in Stage 2, this is a governance commitment rather than a hard on-chain impossibility -- hard immutability requires Stage 3. QuoteRegistry admin functions (`setBond`) affect only future registrations and do not alter open commitments (A6). Nevertheless, governing QuoteRegistry through the same timelock as SLAEscrow is required: an unconstrained `setBond` raise could render honest bundlers unable to register (A8), and a split governance model -- where one contract has a 48 h delay and the other has none -- creates a false sense of security. Both contracts must be owned by the same TimelockController.

**Same-governance caveat.** `_validateRegistry()` verifies `registry.owner() == owner()` at `setRegistry()` and `initialize()` call time, but does not continuously re-check this invariant. After the handover sequence completes, transferring QuoteRegistry ownership independently -- without going through the escrow's `setRegistry()` -- silently diverges the two owners without any on-chain barrier. The requirement that both contracts remain under the same TimelockController is a procedural property upheld by the handover sequence and operational discipline, not a continuously-enforced contract invariant.

The TimelockController's own `DEFAULT_ADMIN_ROLE` must be renounced by the deployer before mainnet. Retaining it allows unilateral reduction of `minDelay` or removal of the proposer multisig, which would silently invalidate the delay guarantee above. **Deployment note.** SLAEscrow calls `__Ownable_init(msg.sender)` in `initialize()`, making the deployer EOA its initial owner. QuoteRegistry uses `Ownable(owner_)` in its constructor, so its initial owner is the address passed at deploy time (also the deployer EOA in the standard deployment script). In both cases ownership must be transferred to the TimelockController (`transferOwnership(timelockAddress)`) before the handover sequence below is considered complete. "Timelock-owned" is a post-handover property, not an initialization-time guarantee.

The complete mainnet handover sequence is:

0. Transfer ownership of both contracts to the TimelockController (`transferOwnership(timelockAddress)`).
1. Add multisig as `PROPOSER_ROLE`.
2. Remove deployer EOA from `PROPOSER_ROLE`.
3. Deployer calls `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`.
4. Verify on-chain: contract `owner()` == TimelockController; `hasRole(PROPOSER_ROLE, multisig)` is true; `hasRole(PROPOSER_ROLE, deployer)` and `hasRole(DEFAULT_ADMIN_ROLE, deployer)` are both false.

Resolution paths (`cancel`, `settle`, `claimRefund`, `withdraw`, `claimPayout`) have no pause. New `commit()` calls can be globally disabled by governance via `freezeCommits()` ahead of an upgrade; that latch does not affect any resolution or withdrawal path.

**T23 -- BUNDLER's collateral exposure is bounded by posted amount.**
A BUNDLER's total collateral at risk at any time is bounded by their posted collateral. Multiple concurrent PROPOSED commits targeting the same BUNDLER lock no collateral -- BUNDLER chooses which to accept. Collateral is locked per commitment at accept() time, not at commit() time; idle collateral is checked at accept() -- accept() reverts if idle collateral is insufficient. Collateral is BUNDLER-scoped, not offer-scoped.

**Hash uniqueness and retirement.** At most one commitment per `userOpHash` may be in state PROPOSED or ACTIVE at any time (`activeCommitForHash` mapping). On fresh deployments, and for commitments finalized under the current logic version, once a commitment reaches any terminal state (SETTLED, REFUNDED, or CANCELLED) the hash is permanently retired in the `retiredHashes` mapping and can never be used for a new commitment. Retries after any terminal state require a fresh UserOp and a fresh hash -- the same `userOpHash` cannot be recommitted. This prevents stale on-chain proof reuse across commitment attempts and eliminates same-hash double-payment vectors. The full retirement invariant is universal on fresh deployments and version-bounded on upgraded deployments.

**Upgrade note.** `retiredHashes` occupies proxy storage slot 10, which previously held `settledHashes` (tracking only settled hashes). Existing `true` entries (settled hashes) remain valid. Historical cancelled and refunded hashes from before this version are not retroactively retired. Accordingly T23's permanent-retirement guarantee applies to all commitments finalized under the current implementation; legacy cancelled/refunded hashes finalized under earlier logic are an explicit exception scoped to the upgrade boundary. On a fresh deployment this caveat is moot.

**T24 -- Admin-configurable parameters are bounded and preceded by notice.**
Every parameter PROTOCOL can adjust is constrained by protocol-enforced bounds such that no permitted setting can: (a) reduce an honest actor's in-protocol return to zero or below (A7), (b) selectively gate or retroactively block an honest actor from participating or exiting -- though a sufficiently high bond or nonzero fee can raise the cost of entry for all participants equally (A8), or (c) alter the resolution of any already-committed commitment (A6, T13). The set of valid admin settings is the subset of parameter space on which every axiom continues to hold. T24 is complementary to T22: T22 protects pending commitments from upgrade-driven changes over time; T24 protects against capture via parameter adjustment within a single protocol version.

Slash split = protocol constant, not configurable. The timelock delay (T22) is the protocol's advance-notice guarantee for all parameter changes. Any modification to `PROTOCOL_FEE_WEI` or other admin parameters is observable on-chain for at least 48 hours before taking effect. Every participant -- BUNDLER and CLIENT alike -- has the full delay window to observe a pending change and exit before it applies to them. No parameter change can be made to take effect instantly.

Concrete enforced bounds (all checked in contract logic):
- `PROTOCOL_FEE_WEI` in `[0, MAX_PROTOCOL_FEE_WEI]`
- `slaBlocks` in `[1, MAX_SLA_BLOCKS]` (enforced at registration); `MAX_SLA_BLOCKS = 1,000` (~33 min on Base) -- sufficient for any realistic UserOp SLA, prevents multi-hour fund locks
- `registrationBond` in `[MIN_BOND, MAX_BOND]`; `MIN_BOND = 0.0001 ETH`, `MAX_BOND = 10 ETH` -- enforced in QuoteRegistry.

T24 describes the invariant that admin power must satisfy at every point in time. The governance-minimisation path (T17) describes how the set of admin-configurable parameters itself shrinks over time toward zero.

---

**T25 -- BUNDLER consent is required to lock collateral.**
A CLIENT cannot unilaterally lock BUNDLER's collateral. A commitment remains PROPOSED -- no collateral touched -- until BUNDLER explicitly calls accept(). Only CLIENT may cancel during the accept window; once expired, CLIENT, BUNDLER, or PROTOCOL may cancel. In all cases `feePerOp` returns to CLIENT. BUNDLER's collateral is never at risk from a PROPOSED commitment. This eliminates the fake-userOpHash griefing vector from the single-phase model: a CLIENT committing with an unincludable hash cannot force a collateral lock -- the adversary's only unrecoverable cost is `protocolFee + gas`, which is bounded and known before commit (T11, A3). BUNDLER has no early-reject path during the accept window -- a BUNDLER who cannot or will not serve the commitment simply does not call `accept()`; the commitment becomes cancellable after the accept window -- an authorized actor (CLIENT, BUNDLER, or PROTOCOL) must call cancel() for the state transition to complete. This is deliberate: an early-reject path would let BUNDLER selectively process commits in real time, weakening the CLIENT's ability to predict when their funds are recoverable. A BUNDLER who withdraws idle collateral below pending PROPOSED collateral requirements will be unable to accept those commits -- this is a binary exit path producing the same CLIENT outcome as non-acceptance, not a selective rejection mechanism. CLIENT may cancel at any point during the accept window and is not forced to wait out the full window.
