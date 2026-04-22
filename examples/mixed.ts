/**
 * Mixed outcomes: two commits to the same bundler.
 *   Commit A -- bundler settles on time  -> bundler earns fee
 *   Commit B -- bundler misses deadline  -> client gets refund, bundler is slashed
 *
 * Run:
 *   npx hardhat run examples/mixed.ts
 */
import { init } from '../playground/world'

async function main() {
  const w   = await init()
  const bx  = w.bundler(w.a)
  const cx1 = w.client(w.b)  // will be settled
  const cx2 = w.client(w.c)  // will be missed

  const quoteId = await bx.register({ feePerOp: w.gwei(5_000), slaBlocks: 10, collateralWei: w.gwei(10_000) })
  await bx.deposit(w.eth(0.001))

  const { commitId: commitA } = await cx1.commit(quoteId)
  const { commitId: commitB } = await cx2.commit(quoteId)
  console.log(`\n-- commitA: ${commitA}  commitB: ${commitB} (both PROPOSED) --`)

  // Include A on time (auto-accepts, then settles)
  await bx.include(commitA)
  console.log(`-- commitA settled --`)

  // For B, the bundler accepts (locks collateral, takes the obligation) but
  // never settles -- we'll mine past the refund window and let the client slash.
  await bx.accept(commitB)
  console.log(`-- commitB accepted (ACTIVE) -- will be missed --`)

  const wait = await w.refundIn(commitB)
  console.log(`-- mining ${wait} blocks -- ignoring commitB --`)
  await w.mine(wait)

  await cx2.claimRefund(commitB)
  const refundB = await cx2.claimPayout()
  console.log(`-- commitB refunded: ${w.fmt.gwei(refundB)} gwei to client --`)

  const earned = await bx.claimPayout()
  console.log(`-- bundler earned (commitA only): ${w.fmt.gwei(earned)} gwei --`)

  console.log('\n-- commitA --')
  await w.print.commit(commitA)
  console.log('\n-- commitB --')
  await w.print.commit(commitB)
  await w.print.state()
}

main().catch((e) => { console.error(e); process.exit(1) })
