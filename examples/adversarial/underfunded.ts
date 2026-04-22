/**
 * Underfunded bundler: deposits just enough collateral for one active commit.
 *
 * v0.6 two-phase note: commits create a PROPOSED slot that does NOT lock collateral.
 * The collateral lock is taken at accept() time, so InsufficientCollateral now
 * reverts on accept -- not on commit. Both clients can commit freely; the second
 * accept() is what the underfunded bundler cannot cover.
 *
 * Run:
 *   npx hardhat run examples/adversarial/underfunded.ts
 */
import { init } from '../../playground/world'

async function main() {
  const w   = await init()
  const bx  = w.bundler(w.a)
  const cx1 = w.client(w.b)
  const cx2 = w.client(w.c)

  // Offer requires 200 gwei collateral per commit
  const quoteId = await bx.register({ feePerOp: w.gwei(100), slaBlocks: 5, collateralWei: w.gwei(200) })
  // Deposit exactly one commit's worth
  await bx.deposit(w.gwei(200))
  console.log(`\n-- bundler deposited exactly 200 gwei (one active commit) --`)

  // Both commits succeed -- PROPOSED state is free, no lock yet
  const { commitId: c1 } = await cx1.commit(quoteId)
  const { commitId: c2 } = await cx2.commit(quoteId)
  console.log(`-- cx1 committed: ${c1} (PROPOSED) --`)
  console.log(`-- cx2 committed: ${c2} (PROPOSED) --`)

  // Accept the first -- locks all 200 gwei
  await bx.accept(c1)
  console.log(`-- bx accepted ${c1} (ACTIVE) -- bundler is now fully locked --`)

  // Accept the second fails -- no idle collateral left
  try {
    await bx.accept(c2)
    console.log('ERROR: should have reverted')
  } catch (e: any) {
    console.log(`-- bx cannot accept ${c2}: InsufficientCollateral`)
  }

  // Settle the first commit -- collateral unlocks (already accepted, include just settles)
  await bx.include(c1)
  console.log(`-- ${c1} settled -- collateral freed --`)

  // Now the second commit can be accepted and settled
  await bx.include(c2)
  console.log(`-- ${c2} accepted + settled after unlock --`)

  const earned = await bx.claimPayout()
  console.log(`-- bundler earned ${w.fmt.gwei(earned)} gwei total --`)
}

main().catch((e) => { console.error(e); process.exit(1) })
