/**
 * Lifecycle: bundler registers, takes a commit, accepts it (locks collateral),
 * deregisters the offer while the commit is still open, then settles and withdraws.
 * Deregister succeeds even with an ACTIVE commit -- the offer goes INACTIVE, the
 * bond is returned, but the locked collateral stays locked until the commit finalizes.
 *
 * Run:
 *   npx hardhat run examples/deregister.ts
 */
import { init } from '../playground/world'

async function main() {
  const w  = await init()
  const bx = w.bundler(w.a)
  const cx = w.client(w.b)

  const quoteId = await bx.register({ feePerOp: w.gwei(5_000), slaBlocks: 5, collateralWei: w.gwei(10_000) })
  await bx.deposit(w.eth(0.001))
  console.log(`\n-- registered offer ${quoteId} --`)
  await w.print.offer(quoteId)

  const { commitId } = await cx.commit(quoteId)
  console.log(`\n-- committed ${commitId} (PROPOSED -- no collateral locked yet) --`)

  // Accept to lock collateral before deregistering, so the next step demonstrates
  // that deregister works with an outstanding ACTIVE obligation.
  await bx.accept(commitId)
  console.log(`-- accepted ${commitId} (ACTIVE -- collateral now locked) --`)

  // Deregister is allowed with ACTIVE commits outstanding: the offer goes INACTIVE
  // and the bond is queued in pendingBonds, but the commit's locked collateral
  // stays locked in escrow until the commit is settled or refunded.
  await bx.deregister(quoteId)
  console.log(`-- deregistered (bond queued in pendingBonds; commit collateral still locked) --`)
  await w.print.offer(quoteId)

  // Bond must be explicitly pulled after deregister().
  const bond = await bx.claimBond()
  console.log(`-- bond claimed: ${w.fmt.gwei(bond)} gwei --`)

  // Settle the outstanding commit (already accepted, so include() skips accept)
  await bx.include(commitId)
  const earned = await bx.claimPayout()
  console.log(`\n-- settled -- bundler earned ${w.fmt.gwei(earned)} gwei --`)

  // Withdraw remaining idle collateral
  const { idle } = await bx.balances()
  if (idle > 0n) {
    await bx.withdraw(idle)
    console.log(`-- withdrew ${w.fmt.gwei(idle)} gwei idle collateral --`)
  }

  await w.print.commit(commitId)
  await w.print.state()
}

main().catch((e) => { console.error(e); process.exit(1) })
