import { ethers } from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { QuoteRegistry, SLAEscrow } from '../typechain-types'

/**
 * Client (user)-side actor. Wraps the signer + registry + escrow for a wallet.
 *
 * Usage:
 *   const client = new ClientActor(clientSigner, registry, escrow)
 *   const commitId = await client.commit(quoteId)         // happy path
 *   // ... after SLA miss ...
 *   await client.claimRefund(commitId)
 *   const refund = await client.claimPayout()
 */
export class ClientActor {
  constructor(
    readonly signer: HardhatEthersSigner,
    readonly registry: QuoteRegistry,
    readonly escrow: SLAEscrow
  ) {}

  get address(): string {
    return this.signer.address
  }

  /**
   * Commit a UserOp to an offer. Creates a PROPOSED commit -- bundler must call
   * accept() within ACCEPT_GRACE_BLOCKS to make it ACTIVE. Fetches offer params
   * from the registry automatically.
   * @param quoteId     Offer to commit to.
   * @param userOpHash  Canonical ERC-4337 userOpHash (bytes32 hex). A random one is
   *                    generated if omitted -- useful for playground exploration.
   *                    In production, compute off-chain:
   *                      keccak256(abi.encode(keccak256(abi.encode(allFields)), EP, chainId))
   * @returns { commitId, userOpHash }
   */
  async commit(quoteId: bigint, userOpHash?: string): Promise<{ commitId: bigint; userOpHash: string }> {
    const hash        = userOpHash ?? ethers.hexlify(ethers.randomBytes(32))
    const offer       = await this.registry.getOffer(quoteId)
    const protocolFee = await this.escrow.protocolFeeWei()

    const tx = await this.escrow.connect(this.signer).commit(
      quoteId,
      hash,
      offer.bundler,
      offer.collateralWei,
      offer.slaBlocks,
      { value: offer.feePerOp + protocolFee }
    )
    const receipt = await tx.wait()
    if (!receipt) throw new Error('commit: no receipt')

    for (const log of receipt.logs) {
      try {
        const parsed = this.escrow.interface.parseLog(log)
        if (parsed?.name === 'CommitCreated') return { commitId: parsed.args.commitId as bigint, userOpHash: hash }
      } catch {}
    }
    throw new Error('commit: CommitCreated event not found')
  }

  /**
   * Cancel a PROPOSED commit and recover feePerOp (protocolFeeWei is non-refundable).
   * Only the CLIENT may cancel during the accept window; afterwards bundler/feeRecipient
   * may also cancel.
   */
  async cancel(commitId: bigint): Promise<void> {
    await (await this.escrow.connect(this.signer).cancel(commitId)).wait()
  }

  /**
   * Claim refund after SLA miss on an ACTIVE commit. Only callable after:
   *   deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1
   * User receives: feePaid + collateralLocked (100% of both).
   */
  async claimRefund(commitId: bigint): Promise<void> {
    await (await this.escrow.connect(this.signer).claimRefund(commitId)).wait()
  }

  /**
   * Claim all pending payouts (fee refunds + slash proceeds).
   * Returns the amount claimed (0 if nothing pending).
   */
  async claimPayout(): Promise<bigint> {
    const pending = await this.escrow.pendingWithdrawals(this.signer.address)
    if (pending === 0n) return 0n
    await (await this.escrow.connect(this.signer).claimPayout()).wait()
    return pending
  }

  /** How much ETH is queued for this client to claim via claimPayout(). */
  async pendingPayout(): Promise<bigint> {
    return this.escrow.pendingWithdrawals(this.signer.address)
  }

  /** Read a full commit struct. */
  async getCommit(commitId: bigint) {
    return this.escrow.getCommit(commitId)
  }
}
