import hre, { ethers } from 'hardhat'
import { setup } from './setup'
import { BundlerActor } from './bundler'
import { ClientActor } from './client'
import {
  printOffer,
  printOffers,
  printCommit,
  printBalances,
  mineBlocks,
  currentBlock,
  blocksUntilRefund,
} from './inspect'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { QuoteRegistry, SLAEscrow, MockEntryPoint } from '../typechain-types'

export interface World {
  // -- contracts --------------------------------------------------------------
  registry: QuoteRegistry
  escrow: SLAEscrow
  registryAddress: string
  escrowAddress: string
  /** Playground EntryPoint stub. Use bx.include(commitId) rather than calling this directly. */
  entryPoint: MockEntryPoint

  // -- wallets -----------------------------------------------------------------
  // Any wallet can act as bundler, client, or both -- use the factories below.
  // [0] owner -- deployer and feeRecipient (earns protocol fees)
  // [1] a  [2] b  [3] c  [4] d  [5] e  [6] f -- generic funded wallets
  owner: HardhatEthersSigner
  a: HardhatEthersSigner
  b: HardhatEthersSigner
  c: HardhatEthersSigner
  d: HardhatEthersSigner
  e: HardhatEthersSigner
  f: HardhatEthersSigner

  // -- actor factories ---------------------------------------------------------
  /** Wrap any wallet as a BundlerActor (register, deposit, settle, etc.) */
  bundler: (signer: HardhatEthersSigner) => BundlerActor
  /** Wrap any wallet as a ClientActor (commit, claimRefund, claimPayout, etc.) */
  client:  (signer: HardhatEthersSigner) => ClientActor

  // -- unit helpers ------------------------------------------------------------
  /** parseUnits(n, 'gwei') -> bigint.  gwei(100) -> 100000000000n */
  gwei:    (n: number | string) => bigint
  /** parseEther(n) -> bigint.  eth(1) -> 1000000000000000000n */
  eth:     (n: number | string) => bigint
  /** Wallet ETH balance (on-chain, not escrow).  balance(w.a.address) */
  balance: (address: string)    => Promise<bigint>

  // -- format helpers ----------------------------------------------------------
  fmt: {
    /** formatEther(v) -> '0.0001'.  For wei -> ETH string. */
    eth:  (v: bigint) => string
    /** formatUnits(v, 'gwei') -> '100.0'.  For wei -> gwei string. */
    gwei: (v: bigint) => string
  }

  // -- chain control -----------------------------------------------------------
  /** Mine n blocks (default 1). */
  mine:          (n?: number)       => Promise<void>
  /** Current block number. */
  block:         ()                 => Promise<number>
  /** Blocks to mine until claimRefund() unblocks for a commit. */
  refundIn:      (commitId: bigint) => Promise<number>
  /** Save EVM state. Returns a snapshot id you can pass to revert(). */
  snapshot:      ()                 => Promise<string>
  /** Restore EVM state to a previously saved snapshot. */
  revert:        (id: string)       => Promise<void>

  // -- inspect -----------------------------------------------------------------
  print: {
    offer:   (quoteId: bigint)  => Promise<void>
    offers:  ()                 => Promise<void>
    commit:  (commitId: bigint) => Promise<void>
    /** Balances for all wallets + registry/escrow summary. */
    state:   ()                 => Promise<void>
  }

  // -- history -----------------------------------------------------------------
  /** Print all contract events involving this wallet, in block order. */
  history: (signer: HardhatEthersSigner) => Promise<void>

  // -- help --------------------------------------------------------------------
  /** Print this quick-reference. */
  help: () => void

  // -- hre ---------------------------------------------------------------------
  hre: typeof hre
}

/**
 * Deploy contracts and return a fully wired World for interactive use.
 *
 *   const { init } = require('./playground/world')
 *   const w = await init()
 *
 *   // Any wallet can play any role:
 *   const bx = w.bundler(w.a)    // a acts as bundler
 *   const ca = w.client(w.b)     // b acts as client
 *   // a can also commit as a client while still being a bundler:
 *   const ca2 = w.client(w.a)
 */
export async function init(): Promise<World> {
  const base    = await setup()
  const signers = await hre.ethers.getSigners()
  const [, a, b, c, d, e, f] = signers  // [0] = owner = base.owner

  // -- factories ---------------------------------------------------------------
  const bundler = (signer: HardhatEthersSigner) =>
    new BundlerActor(signer, base.registry, base.escrow, base.entryPoint)
  const client = (signer: HardhatEthersSigner) =>
    new ClientActor(signer, base.registry, base.escrow)

  // -- helpers -----------------------------------------------------------------
  const gwei    = (n: number | string) => ethers.parseUnits(String(n), 'gwei')
  const eth     = (n: number | string) => ethers.parseEther(String(n))
  const balance = (address: string)    => hre.ethers.provider.getBalance(address)

  // -- print.state -------------------------------------------------------------
  const printState = async () => {
    const block        = await currentBlock()
    const escrowBal    = await hre.ethers.provider.getBalance(base.escrowAddress)
    const activeOffers = await base.registry.activeCount()
    const nextQuoteId  = await base.registry.nextQuoteId()
    const nextCommitId = await base.escrow.nextCommitId()
    const ownerPending = await base.escrow.pendingWithdrawals(base.owner.address)

    console.log(`\n--- World state (block ${block}) -------------------------`)
    console.log(`  registry  activeOffers: ${activeOffers}  nextQuoteId: ${nextQuoteId}`)
    console.log(`  escrow    balance: ${ethers.formatEther(escrowBal)} ETH  nextCommitId: ${nextCommitId}`)
    console.log(`  owner     pendingPayout (protocol fees): ${ethers.formatUnits(ownerPending, 'gwei')} gwei`)
    console.log(`  --------------------------------------------------------`)
    for (const [label, signer] of [['a', a], ['b', b], ['c', c], ['d', d], ['e', e], ['f', f]] as const) {
      await printBalances(base.escrow, label, signer.address)
    }
  }

  // -- history -----------------------------------------------------------------
  const history = async (signer: HardhatEthersSigner) => {
    const addr = signer.address.toLowerCase()
    type Entry = { block: number; desc: string }
    const entries: Entry[] = []
    const push = (e: { blockNumber: number }, desc: string) =>
      entries.push({ block: e.blockNumber, desc })

    const reg = base.registry
    const esc = base.escrow

    // Registry events
    for (const e of await reg.queryFilter(reg.filters.OfferRegistered())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `OfferRegistered   quoteId: ${e.args.quoteId}`)
    }
    for (const e of await reg.queryFilter(reg.filters.OfferDeactivated())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `OfferDeactivated  quoteId: ${e.args.quoteId}  reason: ${Number(e.args.reason) === 0 ? 'voluntary' : 'auto'}`)
    }
    for (const e of await reg.queryFilter(reg.filters.OfferRenewed())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `OfferRenewed      quoteId: ${e.args.quoteId}`)
    }
    for (const e of await reg.queryFilter(reg.filters.BondClaimed())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `BondClaimed       ${ethers.formatUnits(e.args.amount, 'gwei')} gwei`)
    }

    // Escrow: deposit / withdraw
    for (const e of await esc.queryFilter(esc.filters.Deposited())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `Deposited         ${ethers.formatEther(e.args.amount)} ETH`)
    }
    for (const e of await esc.queryFilter(esc.filters.Withdrawn())) {
      if (e.args.bundler.toLowerCase() === addr)
        push(e, `Withdrawn         ${ethers.formatEther(e.args.amount)} ETH`)
    }

    // Escrow: commits -- track commitIds this address is part of (for Settled/Refunded lookup)
    const myCommitIds = new Set<string>()
    for (const e of await esc.queryFilter(esc.filters.CommitCreated())) {
      const isUser    = e.args.user.toLowerCase()    === addr
      const isBundler = e.args.bundler.toLowerCase() === addr
      if (isUser || isBundler) {
        myCommitIds.add(e.args.commitId.toString())
        push(e, `CommitCreated     commitId: ${e.args.commitId}  as ${isUser ? 'user' : 'bundler'}  quoteId: ${e.args.quoteId}  acceptDeadline: block ${e.args.acceptDeadline}`)
      }
    }

    // Escrow: settled / refunded (no address indexed -- match via commitId)
    for (const e of await esc.queryFilter(esc.filters.Settled())) {
      if (myCommitIds.has(e.args.commitId.toString()))
        push(e, `Settled           commitId: ${e.args.commitId}  bundlerNet: ${ethers.formatUnits(e.args.bundlerNet, 'gwei')} gwei`)
    }
    for (const e of await esc.queryFilter(esc.filters.Refunded())) {
      if (myCommitIds.has(e.args.commitId.toString()))
        push(e, `Refunded          commitId: ${e.args.commitId}  userGot: ${ethers.formatUnits(e.args.userAmount, 'gwei')} gwei`)
    }

    // Escrow: payout claimed
    for (const e of await esc.queryFilter(esc.filters.PayoutClaimed())) {
      if (e.args.recipient.toLowerCase() === addr)
        push(e, `PayoutClaimed     ${ethers.formatUnits(e.args.amount, 'gwei')} gwei`)
    }

    entries.sort((x, y) => x.block - y.block)

    if (entries.length === 0) {
      console.log(`\n  (no history for ${signer.address})`)
      return
    }
    console.log(`\n--- History: ${signer.address} ---`)
    for (const e of entries) {
      console.log(`  block ${String(e.block).padEnd(4)}  ${e.desc}`)
    }
  }

  // -- assemble -----------------------------------------------------------------
  return {
    registry:        base.registry,
    escrow:          base.escrow,
    registryAddress: base.registryAddress,
    escrowAddress:   base.escrowAddress,
    entryPoint:      base.entryPoint,
    owner: base.owner,
    a, b, c, d, e, f,
    bundler,
    client,
    gwei,
    eth,
    balance,
    fmt: {
      eth:  (v: bigint) => ethers.formatEther(v),
      gwei: (v: bigint) => ethers.formatUnits(v, 'gwei'),
    },
    mine:     (n = 1) => mineBlocks(n),
    block:    currentBlock,
    refundIn: (commitId) => blocksUntilRefund(base.escrow, commitId),
    snapshot: () => hre.network.provider.send('evm_snapshot', []) as Promise<string>,
    revert:   (id: string) => hre.network.provider.send('evm_revert', [id]) as Promise<void>,
    print: {
      offer:   (quoteId)  => printOffer(base.registry, quoteId),
      offers:  ()         => printOffers(base.registry),
      commit:  (commitId) => printCommit(base.escrow, commitId),
      state:   printState,
    },
    history,
    help: () => console.log(`
SureLock playground -- quick reference
==============================================================================

  Signer layout:
    w.owner  [0] -- deployer, feeRecipient
    w.a-f    [1-6] -- generic funded wallets

  Any wallet can play any role:
    const bx = w.bundler(w.a)    // a acts as bundler
    const cx = w.client(w.b)     // b acts as client

  BundlerActor:
    bx.register(params)          -- register offer -> quoteId
    bx.deposit(amount)           -- add ETH to collateral pool
    bx.withdraw(amount)          -- remove idle (unlocked) ETH
    bx.accept(commitId)          -- accept PROPOSED commit -> ACTIVE (locks collateral)
    bx.include(commitId)         -- auto-accept + emit UserOp + prove on-chain
    bx.claimPayout()             -- pull accumulated fees -> amount claimed
    bx.deregister(id)            -- voluntary deregister, queues bond in pendingBonds
    bx.claimBond()               -- withdraw queued bond after deregister()
    bx.renew(id)                 -- reset offer TTL (ACTIVE only)
    bx.balances()                -- { deposited, locked, idle }
    bx.pendingPayout()           -- queued but unclaimed fees

  ClientActor:
    cx.commit(quoteId, userOp?)  -- commit UserOp (bytes) -> { commitId, userOpHash }
    cx.cancel(commitId)          -- cancel PROPOSED commit, recover fee
    cx.claimRefund(commitId)     -- claim refund after SLA miss on ACTIVE commit
    cx.claimPayout()             -- pull refund + slash proceeds -> amount claimed
    cx.getCommit(commitId)       -- read full Commit struct
    cx.pendingPayout()           -- queued but unclaimed amount

  Unit helpers:
    w.gwei(100)                  -- 100000000000n
    w.eth(1)                     -- 1000000000000000000n
    w.balance(address)           -- wallet ETH balance (on-chain)

  Chain control:
    w.mine(n?)                   -- mine n blocks (default 1)
    w.block()                    -- current block number
    w.refundIn(commitId)         -- blocks until claimRefund() unblocks
    w.snapshot()                 -> id   save EVM state
    w.revert(id)                 -- restore EVM state

  Inspect:
    w.print.offer(quoteId)       -- log one offer
    w.print.offers()             -- log all active offers
    w.print.commit(commitId)     -- log commit state + status
    w.print.state()              -- log balances for all wallets + contract ETH
    w.history(signer)            -- log all events involving a wallet

  Lifecycle (two-phase):
    1. client commit()   -> PROPOSED (collateral NOT yet locked)
    2. bundler accept()  -> ACTIVE   (collateral locked, SLA clock starts at acceptBlock)
    3a. bundler include()/settle()  -> SETTLED -- bundler earns feePaid
    3b. deadline expires -> client claimRefund() slashes 100% (fee + collateral) to client

  Windows (slaBlocks=5, commit at N, accept at M):
    accept window       : [N, N + ACCEPT_GRACE_BLOCKS]          (12 blocks)
    settle window       : [M, M + 5 + SETTLEMENT_GRACE_BLOCKS]
    client refund unlock: M + 5 + SETTLEMENT_GRACE + REFUND_GRACE + 1

    protocolFeeWei is non-refundable at commit (default 0).

==============================================================================`),
    hre,
  }
}
