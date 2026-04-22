/**
 * Late settlement: uses snapshot/revert to explore both branches from the same state.
 *
 *   Branch A (happy): bundler settles before deadline -> earns fee, collateral freed.
 *   Branch B (sad):   bundler waits past deadline -> settle reverts DeadlinePassed,
 *                     client claims refund, bundler is slashed.
 *
 * Run:
 *   npx hardhat run examples/adversarial/settle-late.ts
 */
import { init } from '../../playground/world'

async function main() {
  const w  = await init()
  const bx = w.bundler(w.a)
  const cx = w.client(w.b)

  const quoteId = await bx.register({ feePerOp: w.gwei(100), slaBlocks: 5, collateralWei: w.gwei(200) })
  await bx.deposit(w.eth(0.001))
  const { commitId } = await cx.commit(quoteId)

  // Accept before snapshotting so both branches start from an ACTIVE commit
  // (the refund path needs `accepted=true` to know the SLA deadline).
  await bx.accept(commitId)

  const snap = await w.snapshot()

  // -- Branch A: settle on time -------------------------------------------------
  console.log('\n-- Branch A: settle on time --')
  await bx.include(commitId)
  const earned = await bx.claimPayout()
  console.log(`  bundler earned ${w.fmt.gwei(earned)} gwei`)
  await w.print.commit(commitId)

  // -- Branch B: miss the deadline ----------------------------------------------
  await w.revert(snap)
  console.log('\n-- Branch B: miss the deadline --')

  const wait = await w.refundIn(commitId)
  await w.mine(wait)

  try {
    await bx.include(commitId)
    console.log('ERROR: should have reverted')
  } catch (e: any) {
    console.log(`  include blocked: DeadlinePassed`)
  }

  await cx.claimRefund(commitId)
  const refund = await cx.claimPayout()
  console.log(`  client refunded ${w.fmt.gwei(refund)} gwei`)
  await w.print.commit(commitId)
}

main().catch((e) => { console.error(e); process.exit(1) })
