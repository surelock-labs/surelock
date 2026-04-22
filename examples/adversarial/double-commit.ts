/**
 * Double-commit attack -- two guards:
 *
 *   Guard 1 (activeCommitForHash): while a commit is open (PROPOSED or ACTIVE),
 *   the same UserOp hash cannot be committed to a second bundler.
 *   commit() reverts UserOpAlreadyCommitted.
 *
 *   Guard 2 (retiredHashes): once a commit reaches any terminal state
 *   (settled, refunded, or cancelled), that hash is permanently retired.
 *   Any subsequent commit() for the same hash reverts UserOpHashRetired.
 *   Re-use always requires a fresh UserOp and a fresh hash.
 *
 * Run:
 *   surelock dev node           (in another terminal)
 *   surelock dev run examples/adversarial/double-commit.ts
 */
import { ethers } from 'ethers'
import { init } from '../../playground/world'

async function main() {
  const w   = await init()
  const bx1 = w.bundler(w.a)
  const bx2 = w.bundler(w.b)
  const cx  = w.client(w.c)

  // Two bundlers register competing offers
  const q1 = await bx1.register({ feePerOp: w.gwei(100), slaBlocks: 5, collateralWei: w.gwei(200) })
  const q2 = await bx2.register({ feePerOp: w.gwei(100), slaBlocks: 5, collateralWei: w.gwei(200) })
  await bx1.deposit(w.eth(0.001))
  await bx2.deposit(w.eth(0.001))

  // Fix the UserOp bytes so both commits hash to the same userOpHash.
  const fixedUserOp = ethers.hexlify(ethers.randomBytes(32))

  // -- Guard 1: activeCommitForHash ---------------------------------------------
  const { commitId: c1 } = await cx.commit(q1, fixedUserOp)
  console.log(`\n-- commit to bundler1 succeeded: commitId ${c1} --`)

  try {
    await cx.commit(q2, fixedUserOp)
    console.log('ERROR: second commit should have reverted')
  } catch {
    console.log(`-- second commit blocked (activeCommitForHash): UserOpAlreadyCommitted --`)
  }

  // -- Guard 2: retiredHashes blocks all re-use after settlement ----------------
  await bx1.include(c1)
  console.log(`-- commitId ${c1} settled -- retiredHashes[hash] = true permanently --`)

  // The active-commit guard is cleared, but retiredHashes permanently blocks any new commit.
  try {
    await cx.commit(q2, fixedUserOp)
    console.log('ERROR: commit after settlement should have reverted')
  } catch {
    console.log(`-- commit after settle blocked (retiredHashes): UserOpHashRetired --`)
  }

  // -- Same guard applies after refund: hash is also retired --------------------
  // Use a fresh hash to demonstrate the refund path.
  const anotherUserOp = ethers.hexlify(ethers.randomBytes(32))
  const { commitId: c2 } = await cx.commit(q1, anotherUserOp)
  await bx1.accept(c2)
  console.log(`\n-- commit ${c2} accepted -- letting SLA expire --`)

  await w.mine(await w.refundIn(c2))
  await cx.claimRefund(c2)
  console.log(`-- commitId ${c2} refunded -- retiredHashes[hash] = true (same as settle) --`)

  // Hash is also permanently blocked after refund -- re-use always requires a fresh UserOp.
  try {
    await cx.commit(q2, anotherUserOp)
    console.log('ERROR: commit after refund should have reverted')
  } catch {
    console.log(`-- commit after refund blocked (retiredHashes): UserOpHashRetired --`)
    console.log(`   Re-use always requires a fresh UserOp and a fresh hash. --`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
