/**
 * SureLock happy-path smoke script (temporary).
 *
 * Run:
 *   npx hardhat run examples/happy.ts
 */
import { init } from '../playground/world'

async function main() {
  const w  = await init()
  const bx = w.bundler(w.a)
  const cx = w.client(w.b)

  console.log('\n-- deploy ----------------------------------------------')
  console.log(`  registry  : ${w.registryAddress}`)
  console.log(`  escrow    : ${w.escrowAddress}`)
  console.log(`  entryPoint: ${await w.entryPoint.getAddress()}`)

  // 1. Bundler registers an offer and deposits collateral
  const quoteId = await bx.register({ feePerOp: w.gwei(5_000), slaBlocks: 5, collateralWei: w.gwei(10_000) })
  await bx.deposit(w.eth(0.001))
  await w.print.offer(quoteId)

  // 2. Client commits a UserOp
  const { commitId, userOpHash } = await cx.commit(quoteId)
  console.log(`\n-- committed ${commitId}  userOpHash: ${userOpHash} --`)

  // 3. Bundler includes the UserOp and proves inclusion
  await bx.include(commitId)

  const earned = await bx.claimPayout()
  console.log(`\n-- settled -- bundler earned ${w.fmt.gwei(earned)} gwei --`)

  await w.print.commit(commitId)
  await w.print.state()
}

main().catch((e) => { console.error(e); process.exit(1) })
