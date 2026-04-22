/**
 * SLA miss: bundler ignores the commit, client claims refund + slash proceeds.
 *
 *   feePaid:          100 gwei  -> returned to client
 *   collateralLocked: 200 gwei  -> 100% to client (full slash)
 *   total refund:     300 gwei  -> client receives feePaid + collateralLocked
 *
 * Run:
 *   npx hardhat run examples/sla-miss.ts
 */
import { init } from '../playground/world'

async function main() {
  const w  = await init()
  const bx = w.bundler(w.a)
  const cx = w.client(w.b)

  const quoteId = await bx.register({ feePerOp: w.gwei(5_000), slaBlocks: 5, collateralWei: w.gwei(10_000) })
  await bx.deposit(w.eth(0.001))

  const { commitId } = await cx.commit(quoteId)
  console.log(`\n-- committed ${commitId} (PROPOSED) --`)

  // Two-phase commit: bundler must accept to start the SLA clock. After accept
  // the bundler "owns" the obligation -- then we simulate a miss by doing nothing.
  await bx.accept(commitId)
  console.log(`-- accepted ${commitId} (ACTIVE) -- bundler will now miss the SLA --`)

  const wait = await w.refundIn(commitId)
  console.log(`-- mining ${wait} blocks to open refund window --`)
  await w.mine(wait)

  await cx.claimRefund(commitId)
  const refund = await cx.claimPayout()
  console.log(`-- refund claimed: ${w.fmt.gwei(refund)} gwei --`)

  await w.print.commit(commitId)
  await w.print.state()
}

main().catch((e) => { console.error(e); process.exit(1) })
