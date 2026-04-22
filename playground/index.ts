/**
 * SureLock local playground
 * ==============================================================================
 *
 * Local chain (Hardhat in-process or persistent node) with QuoteRegistry +
 * SLAEscrow deployed fresh. Two entry points: init() for interactive shell use,
 * setup() for scripted scenarios.
 *
 *
 * -- INTERACTIVE SHELL (recommended) -----------------------------------------
 *
 *   npx hardhat node                          # terminal 1 (persistent state)
 *   npx hardhat console --network localhost   # terminal 2
 *
 *   > const { init } = require('./playground')
 *   > const w = await init()
 *   > const bx = w.bundler(w.a)          // a acts as bundler
 *   > const cx = w.client(w.b)           // b acts as client
 *   > const quoteId = await bx.register({ slaBlocks: 5 })
 *   > await bx.deposit(w.eth(0.01))
 *   > const { commitId } = await cx.commit(quoteId)
 *   > await bx.include(commitId)         // emit + prove on-chain
 *   > await w.print.commit(commitId)
 *   > await w.print.state()
 *
 * Or in-process (no separate terminal, state resets on each run):
 *
 *   npx hardhat console --network hardhat
 *
 *
 * -- init() -- World object ----------------------------------------------------
 *
 *   const w = await init()
 *
 *   Signer layout:
 *     w.owner    [0] -- deployer, feeRecipient
 *     w.a-w.f   [1-6] -- generic funded wallets
 *
 *   Any wallet can act as bundler, client, or both:
 *     const bx = w.bundler(w.a)    // a acts as bundler
 *     const cx = w.client(w.b)     // b acts as client
 *     const cx2 = w.client(w.a)    // a can also be a client simultaneously
 *
 *   BundlerActor methods:
 *       .register(params)   -- register offer -> quoteId
 *       .deposit(amount)    -- add ETH to collateral pool
 *       .withdraw(amount)   -- remove idle (unlocked) ETH
 *       .accept(commitId)   -- accept PROPOSED commit -> ACTIVE (locks collateral)
 *       .include(commitId)  -- auto-accept + emit UserOp via EntryPoint + submit MPT proof
 *       .claimPayout()      -- pull accumulated fees -> amount claimed
 *       .deregister(id)     -- voluntary deregister, returns bond
 *       .renew(id)          -- reset offer TTL (ACTIVE only)
 *       .balances()         -- { deposited, locked, idle }
 *       .pendingPayout()    -- queued but unclaimed fees
 *
 *   ClientActor methods:
 *       .commit(quoteId,?)  -- commit UserOp (bytes), pays fee -> { commitId, userOpHash }
 *       .cancel(commitId)   -- cancel PROPOSED commit, recover feePaid
 *       .claimRefund(id)    -- claim refund after SLA miss on ACTIVE commit
 *       .claimPayout()      -- pull refund + slash proceeds -> amount claimed
 *       .getCommit(id)      -- read full Commit struct
 *       .pendingPayout()    -- queued but unclaimed amount
 *
 *   Unit helpers:
 *     w.gwei(100)           -- 100000000000n  (parseUnits)
 *     w.eth(1)              -- 1000000000000000000n  (parseEther)
 *
 *   Chain control:
 *     w.mine(n?)            -- mine n blocks (default 1)
 *     w.block()             -- current block number
 *     w.refundIn(commitId)  -- blocks until claimRefund() unblocks
 *
 *   Inspect:
 *     w.print.offer(quoteId)   -- log one offer
 *     w.print.offers()         -- log all active offers
 *     w.print.commit(commitId) -- log commit state + status
 *     w.print.state()          -- log balances for all wallets + contract ETH
 *
 *   Raw contracts (for direct calls):
 *     w.registry            -- QuoteRegistry instance
 *     w.escrow              -- SLAEscrow instance
 *     w.registryAddress
 *     w.escrowAddress
 *
 *
 * -- setup() -- lower-level, for scripts --------------------------------------
 *
 *   import { setup, BundlerActor, ClientActor } from '../playground'
 *
 *   const ctx = await setup()
 *   const bundler = new BundlerActor(ctx.owner, ctx.registry, ctx.escrow, ctx.entryPoint)
 *   const client  = new ClientActor(ctx.owner, ctx.registry, ctx.escrow)
 *
 *
 * -- setupWithTimelock(delaySeconds) -- mirrors production ---------------------
 *
 *   const ctx = await setupWithTimelock(5)   // 5s delay for interactive play
 *   // ctx.timelock, ctx.timelockAddress, ctx.timelockDelay
 *   // SLAEscrow ownership transferred to Timelock
 *   // Admin calls require: schedule -> evm_increaseTime -> execute
 *
 *
 * -- run a script -------------------------------------------------------------
 *
 *   npx hardhat run playground/happy.ts --network hardhat
 *
 *
 * -- LIFECYCLE & TIMING REFERENCE ---------------------------------------------
 *
 *   Two-phase commit:
 *     1. client commit()   -> PROPOSED (collateral NOT yet locked)
 *     2. bundler accept()  -> ACTIVE   (collateral locked, SLA clock starts at acceptBlock)
 *     3a. bundler include()/settle()  -> SETTLED -- bundler earns feePaid
 *     3b. deadline expires -> client claimRefund() slashes 100% (fee + collateral) to client
 *
 *   Windows (commit at block N, accept at block M, slaBlocks=5):
 *     accept window        : [N,         N + ACCEPT_GRACE_BLOCKS]       (ACCEPT_GRACE = 12)
 *     settle window        : [M,         M + 5 + SETTLEMENT_GRACE_BLOCKS]  (SETTLEMENT_GRACE = 10)
 *     client refund unlock : M + 5 + SETTLEMENT_GRACE + REFUND_GRACE + 1   (REFUND_GRACE = 5)
 *
 *   protocolFeeWei is non-refundable at commit (default 0).
 *   happy: bundler earns full feePerOp
 *   sad:   bundler loses full collateral -> 100% (feePaid + collateral) to client
 *
 * ==============================================================================
 */

export { setup, setupWithTimelock } from './setup'
export { init }                     from './world'
export { BundlerActor }            from './bundler'
export { ClientActor }             from './client'
export {
  printOffer,
  printOffers,
  printCommit,
  printBalances,
  printEscrowState,
  mineBlocks,
  currentBlock,
  blocksUntilRefund,
} from './inspect'

export type { PlaygroundContext, TimelockContext } from './setup'
export type { World }                              from './world'
export type { RegisterParams, BundlerBalances } from './bundler'
