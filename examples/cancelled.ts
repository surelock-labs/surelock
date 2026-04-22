/**
 * CANCELLED path: two scenarios.
 *
 *   A -- CLIENT cancels proactively during the accept window (change of mind).
 *       CLIENT recovers feePerOp. Bundler loses nothing -- collateral was never
 *       locked. protocolFee is retained by PROTOCOL (non-refundable, T11).
 *
 *   B -- Accept window expires without bundler response.
 *       After ACCEPT_GRACE_BLOCKS (12) pass with no accept(), CLIENT, BUNDLER,
 *       or PROTOCOL may call cancel() to release CLIENT's fee.
 *
 * In both cases: no collateral is ever at risk (T25). Bundler earns nothing.
 *
 * Run:
 *   npx hardhat run examples/cancelled.ts
 */
import { ethers } from 'hardhat'
import { init } from '../playground/world'

const ACCEPT_GRACE_BLOCKS = 12

async function main() {
  const w  = await init()
  const bx = w.bundler(w.a)
  const cx = w.client(w.b)

  const quoteId = await bx.register({ feePerOp: w.gwei(100_000), slaBlocks: 10, collateralWei: w.gwei(200_000) })
  await bx.deposit(w.eth(0.001))

  // -- Scenario A: CLIENT cancels proactively during accept window --------------
  console.log('\n-- Scenario A: client cancels during accept window --')

  const { commitId: commitA } = await cx.commit(quoteId)
  console.log(`Committed ${commitA} (PROPOSED -- accept window open, bundler has ${ACCEPT_GRACE_BLOCKS} blocks to respond)`)

  const { idle: idleBefore }   = await bx.balances()
  const pendingBefore           = await cx.pendingPayout()

  // CLIENT cancels immediately -- no need to wait for the window to expire.
  // Collateral was never locked, so the bundler loses nothing.
  await cx.cancel(commitA)

  const { idle: idleAfter } = await bx.balances()
  const pendingAfter         = await cx.pendingPayout()

  console.log(`Cancelled ${commitA}`)
  console.log(`  Bundler idle      : ${w.fmt.gwei(idleBefore)} -> ${w.fmt.gwei(idleAfter)} gwei (unchanged)`)
  console.log(`  Client pendingPayout: +${w.fmt.gwei(pendingAfter - pendingBefore)} gwei (claimPayout() to withdraw)`)

  await w.print.commit(commitA)

  // -- Scenario B: accept window expires -- anyone may cancel --------------------
  console.log('\n-- Scenario B: accept window expires, client cancels after --')

  const { commitId: commitB } = await cx.commit(quoteId)
  console.log(`Committed ${commitB} (PROPOSED)`)

  // Mine past the accept window (12 blocks + 1 to ensure expiry).
  const blocksToMine = ACCEPT_GRACE_BLOCKS + 1
  console.log(`Mining ${blocksToMine} blocks -- bundler does not respond...`)
  await w.mine(blocksToMine)

  const pendingBeforeB = await cx.pendingPayout()
  await cx.cancel(commitB)
  const pendingAfterB = await cx.pendingPayout()

  console.log(`Cancelled ${commitB} after window expired`)
  console.log(`  Client pendingPayout: +${w.fmt.gwei(pendingAfterB - pendingBeforeB)} gwei (claimPayout() to withdraw)`)

  await w.print.commit(commitB)
  await w.print.state()
}

main().catch((e) => { console.error(e); process.exit(1) })
