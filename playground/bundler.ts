import { ethers, hexlify } from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { QuoteRegistry, SLAEscrow, MockEntryPoint } from '../typechain-types'
import { buildBlockHeaderRlp, buildReceiptProof } from './buildSettleProof'

export interface RegisterParams {
  /** Max fee per UserOp (wei). Default: 100 gwei. Must be < collateralWei. */
  feePerOp?: bigint
  /** SLA window in blocks. Default: 10. Max: 1_000 (~33 min on Base). */
  slaBlocks?: number
  /** Collateral locked per commit (wei). Default: 200 gwei. Must be > feePerOp. */
  collateralWei?: bigint
  /** Offer TTL in blocks. Default: MIN_LIFETIME (302_400, ~7 days). */
  lifetime?: number
}

export interface BundlerBalances {
  deposited: bigint
  locked: bigint
  idle: bigint
}

/**
 * Bundler-side actor. Wraps the signer + registry + escrow for a bundler wallet.
 *
 * Usage:
 *   const bundler = new BundlerActor(bundlerSigner, registry, escrow)
 *   const quoteId = await bundler.register({ slaBlocks: 5 })
 *   await bundler.deposit(ethers.parseEther('0.01'))
 *   // ... after a commit ...
 *   await bundler.include(commitId)   // auto-accepts + emits + settles
 *   const earned = await bundler.claimPayout()
 */
export class BundlerActor {
  constructor(
    readonly signer: HardhatEthersSigner,
    readonly registry: QuoteRegistry,
    readonly escrow: SLAEscrow,
    readonly entryPoint: MockEntryPoint,
  ) {}

  get address(): string {
    return this.signer.address
  }

  /** Register a new offer. Returns the quoteId. */
  async register(params: RegisterParams = {}): Promise<bigint> {
    const feePerOp   = params.feePerOp   ?? ethers.parseUnits('100', 'gwei')
    const slaBlocks     = params.slaBlocks      ?? 10
    const collateralWei = params.collateralWei  ?? ethers.parseUnits('200', 'gwei')
    const lifetime      = params.lifetime       ?? 302_400 // MIN_LIFETIME
    const bond          = await this.registry.registrationBond()

    const tx = await this.registry
      .connect(this.signer)
      .register(feePerOp, slaBlocks, collateralWei, lifetime, { value: bond })
    const receipt = await tx.wait()
    if (!receipt) throw new Error('register: no receipt')

    for (const log of receipt.logs) {
      try {
        const parsed = this.registry.interface.parseLog(log)
        if (parsed?.name === 'OfferRegistered') return parsed.args.quoteId as bigint
      } catch {}
    }
    throw new Error('register: OfferRegistered event not found')
  }

  /** Deregister an offer (voluntary, ACTIVE or EXPIRED). Queues bond in pendingBonds; call claimBond() to withdraw. */
  async deregister(quoteId: bigint): Promise<void> {
    await (await this.registry.connect(this.signer).deregister(quoteId)).wait()
  }

  /** Withdraw the registration bond queued by deregister(). Returns the amount claimed (0 if nothing pending). */
  async claimBond(): Promise<bigint> {
    const pending = await this.registry.pendingBonds(this.signer.address)
    if (pending === 0n) return 0n
    await (await this.registry.connect(this.signer).claimBond()).wait()
    return pending
  }

  /** Withdraw the registration bond to a specific address. */
  async claimBondTo(to: string): Promise<bigint> {
    const pending = await this.registry.pendingBonds(this.signer.address)
    if (pending === 0n) return 0n
    await (await this.registry.connect(this.signer).claimBondTo(to as any)).wait()
    return pending
  }

  /** Reset an offer's TTL (ACTIVE only). */
  async renew(quoteId: bigint): Promise<void> {
    await (await this.registry.connect(this.signer).renew(quoteId)).wait()
  }

  /** Deposit ETH collateral into the escrow pool. */
  async deposit(amount: bigint): Promise<void> {
    await (await this.escrow.connect(this.signer).deposit({ value: amount })).wait()
  }

  /** Withdraw idle (unlocked) collateral from the escrow pool. */
  async withdraw(amount: bigint): Promise<void> {
    await (await this.escrow.connect(this.signer).withdraw(amount)).wait()
  }

  /**
   * Accept a PROPOSED commit: locks collateral and starts the SLA clock (T25/A9).
   * Must be called by the named bundler within ACCEPT_GRACE_BLOCKS of the commit.
   */
  async accept(commitId: bigint): Promise<void> {
    await (await this.escrow.connect(this.signer).accept(commitId)).wait()
  }

  /**
   * Include a committed UserOp: idempotently accepts the commit if still PROPOSED,
   * then calls the EntryPoint and proves inclusion on-chain.
   * Looks up the userOpHash from the commit so it cannot be passed incorrectly.
   */
  async include(commitId: bigint): Promise<void> {
    const commit = await this.escrow.getCommit(commitId)
    if (!commit.accepted) {
      await (await this.escrow.connect(this.signer).accept(commitId)).wait()
    }

    const tx      = await this.entryPoint.connect(this.signer).handleOp(commit.userOpHash)
    const receipt = await tx.wait()
    if (!receipt) throw new Error('include: no receipt from entryPoint')

    const provider     = this.signer.provider as { send(method: string, params: unknown[]): Promise<any> }
    const blockNumber  = receipt.blockNumber
    const blockHeaderRlp = await buildBlockHeaderRlp(provider, blockNumber)
    const proof          = await buildReceiptProof(provider, blockNumber, receipt.hash)

    await (await this.escrow.connect(this.signer).settle(
      commitId,
      blockNumber,
      blockHeaderRlp,
      proof.proofNodes.map(n => hexlify(n)),
      proof.txIndex,
    )).wait()
  }

  /**
   * Claim all pending payouts (accumulated fees from settled commits).
   * Returns the amount claimed (0 if nothing pending).
   */
  async claimPayout(): Promise<bigint> {
    const pending = await this.escrow.pendingWithdrawals(this.signer.address)
    if (pending === 0n) return 0n
    await (await this.escrow.connect(this.signer).claimPayout()).wait()
    return pending
  }

  /** Returns deposited / locked / idle balances for this bundler. */
  async balances(): Promise<BundlerBalances> {
    const deposited = await this.escrow.deposited(this.signer.address)
    const locked    = await this.escrow.lockedOf(this.signer.address)
    return { deposited, locked, idle: deposited - locked }
  }

  /** How much ETH is queued for this bundler to claim via claimPayout(). */
  async pendingPayout(): Promise<bigint> {
    return this.escrow.pendingWithdrawals(this.signer.address)
  }
}
