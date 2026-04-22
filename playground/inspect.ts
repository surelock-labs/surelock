import hre, { ethers } from 'hardhat'
import type { QuoteRegistry, SLAEscrow } from '../typechain-types'

const gwei = (v: bigint) => ethers.formatUnits(v, 'gwei') + ' gwei'
const eth  = (v: bigint) => ethers.formatEther(v) + ' ETH'

export async function printOffer(registry: QuoteRegistry, quoteId: bigint): Promise<void> {
  const o      = await registry.getOffer(quoteId)
  const active = await registry.isActive(quoteId)
  const expiry = o.registeredAt + o.lifetime

  console.log(`  Offer #${o.quoteId}`)
  console.log(`    bundler:      ${o.bundler}`)
  console.log(`    feePerOp:  ${gwei(o.feePerOp)}`)
  console.log(`    collateral:   ${gwei(o.collateralWei)}`)
  console.log(`    slaBlocks:    ${o.slaBlocks}`)
  console.log(`    lifetime:     ${o.lifetime} blocks`)
  console.log(`    registeredAt: block ${o.registeredAt}  expiry: block ${expiry}`)
  console.log(`    bond:         ${eth(o.bond)}`)
  console.log(`    active:       ${active}`)
}

export async function printOffers(registry: QuoteRegistry): Promise<void> {
  const offers = await registry.list()
  if (offers.length === 0) {
    console.log('  (no active offers)')
    return
  }
  for (const o of offers) {
    await printOffer(registry, o.quoteId)
    console.log()
  }
}

export async function printCommit(escrow: SLAEscrow, commitId: bigint): Promise<void> {
  const c = await escrow.getCommit(commitId)
  const status =
    c.settled   ? 'SETTLED'
  : c.refunded  ? 'REFUNDED'
  : c.cancelled ? 'CANCELLED'
  : c.accepted  ? 'ACTIVE'
  :               'PROPOSED'

  console.log(`  Commit #${commitId}  [${status}]`)
  console.log(`    user:             ${c.user}`)
  console.log(`    bundler:          ${c.bundler}`)
  console.log(`    feePaid:          ${gwei(c.feePaid)}`)
  console.log(`    collateralLocked: ${gwei(c.collateralLocked)}`)
  console.log(`    slaBlocks:        ${c.slaBlocks}`)
  console.log(`    acceptDeadline:   block ${c.acceptDeadline}`)
  if (c.accepted) {
    console.log(`    deadline:         block ${c.deadline}`)
  }
  console.log(`    quoteId:          ${c.quoteId}`)
  console.log(`    userOpHash:       ${c.userOpHash}`)
  if (c.settled) {
    console.log(`    inclusionBlock:   ${c.inclusionBlock}`)
  }
}

export async function printBalances(escrow: SLAEscrow, label: string, address: string): Promise<void> {
  const deposited = await escrow.deposited(address)
  const locked    = await escrow.lockedOf(address)
  const pending   = await escrow.pendingWithdrawals(address)
  const idle      = deposited - locked
  console.log(
    `  ${label.padEnd(8)} deposited: ${gwei(deposited).padEnd(14)}` +
    `  locked: ${gwei(locked).padEnd(10)}` +
    `  idle: ${gwei(idle).padEnd(10)}` +
    `  pendingPayout: ${gwei(pending)}`
  )
}

export async function printEscrowState(
  escrow: SLAEscrow,
  label1: string,
  address1: string,
  label2: string,
  address2: string
): Promise<void> {
  const block = await hre.ethers.provider.getBlockNumber()
  const bal   = await hre.ethers.provider.getBalance(await escrow.getAddress())
  console.log(`  block: ${block}  contractBalance: ${eth(bal)}`)
  await printBalances(escrow, label1, address1)
  await printBalances(escrow, label2, address2)
}

/** Mine n blocks on the local Hardhat / localhost network. */
export async function mineBlocks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await hre.network.provider.send('evm_mine')
  }
}

export async function currentBlock(): Promise<number> {
  return hre.ethers.provider.getBlockNumber()
}

/**
 * Returns how many blocks to mine to reach the refund window for an ACTIVE commit.
 * Only meaningful after accept() -- a PROPOSED commit has deadline=0 and cannot be
 * refunded (it is cancelled, not refunded, if the accept window expires).
 *
 * unlocksAt = deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1
 */
export async function blocksUntilRefund(escrow: SLAEscrow, commitId: bigint): Promise<number> {
  const c = await escrow.getCommit(commitId)
  if (!c.accepted) throw new Error(`commit ${commitId} is PROPOSED -- call bx.accept(commitId) first`)
  const SETTLEMENT_GRACE = Number(await escrow.SETTLEMENT_GRACE_BLOCKS())
  const REFUND_GRACE     = Number(await escrow.REFUND_GRACE_BLOCKS())
  const unlocksAt        = Number(c.deadline) + SETTLEMENT_GRACE + REFUND_GRACE + 1
  const cur              = await currentBlock()
  return Math.max(0, unlocksAt - cur)
}
