// Refund path demo: bundler accepts then misses the SLA; user claims feePerOp + slashed collateral.
import { ethers } from "hardhat";
import type { Signer, Provider } from "ethers";
import {
    register, deregister, deposit, withdraw, accept,
    claimBond, getIdleBalance, getCommit,
} from "@surelock-labs/bundler";
import { fetchQuotes, commitOp, cancel, claimRefund, claimPayout, type Offer } from "@surelock-labs/router";
import { loadDeployment } from "./deployment";

const SEP  = "-".repeat(60);
const STEP = (n: number, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForBlock(provider: Provider, targetBlock: number, label: string) {
    process.stdout.write(`  Waiting for block ${targetBlock} (${label})...`);
    while (true) {
        let cur: number;
        try {
            cur = await provider.getBlockNumber();
        } catch {
            process.stdout.write("!");
            await sleep(2000);
            continue;
        }
        if (cur >= targetBlock) { process.stdout.write(` done (block ${cur})\n`); return; }
        process.stdout.write(".");
        try { await (provider as any).send("evm_mine", []); } catch { await sleep(2000); }
    }
}

// Demo offer parameters -- realistic fee for a low-basefee L2, minimal collateral.
const DEMO_FEE_WEI     = ethers.parseUnits("5000", "gwei"); // 5000 gwei -- above bundler break-even at ~0.01 gwei basefee
const DEMO_COLL_WEI    = DEMO_FEE_WEI + 1n;                // strictly > feePerOp (T8); minimal for testnet
const DEMO_SLA_BLOCKS  = 2;                                 // 2-block SLA window

async function main() {
    console.log("\n" + "=".repeat(60));
    console.log("  surelock -- end-to-end SLA-enforcement demo");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const deployment = loadDeployment(chainId);
    const provider = ethers.provider;

    const bundlerPk = process.env["BUNDLER_KEY"];
    if (!bundlerPk) throw new Error("BUNDLER_KEY env var required -- use: surelock exec --key deployer --bundler-key demo-bundler -- ...");
    const bundler = new ethers.Wallet(bundlerPk, provider);

    console.log(`\nNetwork:     ${deployment.network} (chainId ${chainId})`);
    console.log(`User:        ${signer.address}`);
    console.log(`Bundler:     ${bundler.address}`);
    console.log(`Registry:    ${deployment.registry}`);
    console.log(`SLAEscrow:   ${deployment.escrow}`);

    // Raw contract handles only remain for reads that the SDK doesn't expose
    // directly (feeRecipient, nextCommitId, reservedBalance, pendingWithdrawals).
    const escrow = await ethers.getContractAt("SLAEscrow", deployment.escrow) as any;

    // -- Step 0: Reset state -- drain any leftovers from previous runs ---------

    STEP(0, "Reset state (drain pre-existing balances)");

    // Drain signer pending withdrawals via SDK.
    const userClaimed = await claimPayout(signer as unknown as Signer, deployment.escrow);
    if (userClaimed > 0n) console.log(`  Drained user pending: ${eth(userClaimed)}`);

    // Drain bundler idle collateral via SDK.
    const staleIdle = await getIdleBalance(provider, deployment.escrow, bundler.address);
    if (staleIdle > 0n) {
        await withdraw(bundler, deployment.escrow, staleIdle);
        console.log(`  Drained bundler idle: ${eth(staleIdle)}`);
    }

    // Deregister any leftover offer from this bundler (bond goes to pendingBonds).
    const activeOffers = await fetchQuotes(provider, deployment.registry);
    const staleOffer = activeOffers.find(o => o.bundler.toLowerCase() === bundler.address.toLowerCase());
    if (staleOffer) {
        await deregister(bundler, deployment.registry, staleOffer.quoteId);
        console.log(`  Deregistered stale offer quoteId=${staleOffer.quoteId}`);
    }
    const staleBondAmount = await claimBond(bundler, deployment.registry);
    if (staleBondAmount > 0n) console.log(`  Claimed stale bond: ${eth(staleBondAmount)}`);

    // Cancel expired PROPOSED commits, claim abandoned refunds from ACTIVE commits.
    // Only touch commits where we have standing (user, bundler, or feeRecipient).
    const SETTLE_GRACE = 10n, REFUND_GRACE = 5n;
    const feeRecipient = (await escrow.feeRecipient() as string).toLowerCase();
    const signerAddr   = signer.address.toLowerCase();
    const curBlock = BigInt(await provider.getBlockNumber());
    const nextId   = BigInt(await escrow.nextCommitId());
    for (let id = 0n; id < nextId; id++) {
        const c = await getCommit(provider, deployment.escrow, id);
        if (c.settled || c.refunded || c.cancelled) continue;
        const isOurs = c.user.toLowerCase()    === signerAddr
                    || c.bundler.toLowerCase() === signerAddr
                    || signerAddr              === feeRecipient;
        if (!isOurs) continue;
        if (!c.accepted && curBlock > c.acceptDeadline) {
            await cancel(signer as unknown as Signer, deployment.escrow, id);
            console.log(`  Cancelled expired PROPOSED commitId=${id}`);
        } else if (c.accepted && c.deadline > 0n
            && curBlock > c.deadline + SETTLE_GRACE + REFUND_GRACE) {
            await claimRefund(signer as unknown as Signer, deployment.escrow, id);
            console.log(`  Claimed abandoned refund for commitId=${id}`);
        }
    }
    // Drain anything that just accumulated.
    const userClaimed2 = await claimPayout(signer as unknown as Signer, deployment.escrow);
    if (userClaimed2 > 0n) console.log(`  Drained recovered funds: ${eth(userClaimed2)}`);

    const contractBalStart = await provider.getBalance(deployment.escrow);
    const reservedBalStart = BigInt(await escrow.reservedBalance());
    const signerBalStart   = await provider.getBalance(signer.address);
    const excessStart      = contractBalStart - reservedBalStart;
    console.log(`Contract balance (start): ${eth(contractBalStart)}`);
    console.log(`Reserved balance (start): ${eth(reservedBalStart)}`);
    if (excessStart > 0n) console.log(`  -> ${eth(excessStart)} excess (direct ETH send, not protocol-tracked)`);
    console.log(`Signer  balance (start) : ${eth(signerBalStart)}`);

    // -- Step 1: Ensure bundler has an active offer ----------------------------

    STEP(1, "Setup demo bundler and register offer");

    let offer: Offer;
    const offers  = await fetchQuotes(provider, deployment.registry);
    const mine    = offers.find(o => o.bundler.toLowerCase() === bundler.address.toLowerCase());

    if (mine) {
        offer = mine;
        console.log(`Re-using existing offer quoteId=${offer.quoteId}`);
    } else {
        offer = await register(bundler, deployment.registry, {
            feePerOp:      DEMO_FEE_WEI,
            slaBlocks:     DEMO_SLA_BLOCKS,
            collateralWei: DEMO_COLL_WEI,
        });
        console.log(`Registered offer quoteId=${offer.quoteId}`);
    }

    console.log(`  feePerOp  : ${gwei(offer.feePerOp)}`);
    console.log(`  slaBlocks : ${offer.slaBlocks}`);
    console.log(`  collateral: ${eth(offer.collateralWei)}`);

    // Ensure bundler has enough idle collateral to accept.
    const idle = await getIdleBalance(provider, deployment.escrow, bundler.address);
    if (idle < offer.collateralWei) {
        const topUp = offer.collateralWei - idle;
        await deposit(bundler, deployment.escrow, topUp);
        console.log(`  Deposited ${eth(topUp)} collateral for bundler`);
    } else {
        console.log(`  Bundler idle balance: ${eth(idle)} (sufficient)`);
    }

    // -- Step 2: Commit a UserOp -----------------------------------------------

    STEP(2, "User commits a UserOp (pays fee, records hash)");

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes(`demo-${Date.now()}`));
    const { commitId, blockNumber: commitBlock } = await commitOp(
        signer as unknown as Signer,
        deployment.escrow,
        offer,
        userOpHash,
    );

    const c0 = await getCommit(provider, deployment.escrow, commitId, commitBlock);
    console.log(`UserOpHash     : ${userOpHash}`);
    console.log(`CommitId       : ${commitId}`);
    console.log(`Committed at   : block ${commitBlock}`);
    console.log(`  feePaid      : ${gwei(c0.feePaid)}`);
    console.log(`  acceptDeadline: block ${c0.acceptDeadline}`);
    console.log(`  status        : PROPOSED`);

    // -- Step 3: Bundler accepts -----------------------------------------------

    STEP(3, "Bundler accepts (locks collateral, starts SLA clock)");

    const acceptRcpt = await accept(bundler, deployment.escrow, commitId);
    const c1 = await getCommit(provider, deployment.escrow, commitId, acceptRcpt.blockNumber);
    console.log(`  SLA deadline  : block ${c1.deadline}`);
    console.log(`  collateral    : ${eth(c1.collateralLocked)}`);
    console.log(`  status        : ACTIVE`);

    // -- Step 4: Wait for claimRefund window ----------------------------------

    STEP(4, "Waiting for SLA deadline + settlement + refund grace periods");

    // SETTLEMENT_GRACE_BLOCKS = 10, REFUND_GRACE_BLOCKS = 5
    // +4 extra blocks so stale load-balanced RPC nodes pass estimateGas
    const refundUnlockBlock = Number(c1.deadline) + 10 + 5 + 4;
    const approxWait = (refundUnlockBlock - Number(c1.deadline) + offer.slaBlocks) * 2;
    console.log(`  SLA deadline      : block ${c1.deadline}`);
    console.log(`  claimRefund opens : block ${refundUnlockBlock}`);
    console.log(`  Estimated wait    : ~${approxWait}s`);

    await waitForBlock(provider, refundUnlockBlock, "claimRefund");

    // -- Step 5: User claims refund (bundler slashed) --------------------------

    STEP(5, "User claims refund -- bundler slashed for SLA miss");

    // Retry-on-revert covers load-balanced RPCs returning a stale "latest" (NotExpired).
    let claimRcpt!: Awaited<ReturnType<typeof claimRefund>>;
    for (let attempt = 0; ; attempt++) {
        try {
            claimRcpt = await claimRefund(signer as unknown as Signer, deployment.escrow, commitId);
            break;
        } catch (e: any) {
            if (attempt >= 5) throw e;
            console.log(`  claimRefund attempt ${attempt + 1} reverted -- waiting 2 blocks for RPC sync`);
            await waitForBlock(provider, await provider.getBlockNumber() + 2, "sync");
        }
    }

    const c2 = await getCommit(provider, deployment.escrow, commitId, claimRcpt.blockNumber);
    console.log(`Refund claimed`);
    console.log(`  feePaid returned  : ${gwei(c2.feePaid)}`);
    console.log(`  collateral slashed: ${eth(c2.collateralLocked)}`);
    console.log(`  total credited    : ${eth(c2.feePaid + c2.collateralLocked)}`);
    console.log(`  status            : REFUNDED`);

    // -- Step 6: User withdraws pending payout --------------------------------

    STEP(6, "User withdraws pending payout via claimPayout()");

    const paidOut = await claimPayout(signer as unknown as Signer, deployment.escrow);
    console.log(`Withdrawn: ${eth(paidOut)}`);

    // -- Step 7: Cleanup bundler position (per feedback_cleanup_funds.md) -----

    STEP(7, "Cleanup bundler position -- return all recoverable funds");

    const bundlerIdleEnd = await getIdleBalance(provider, deployment.escrow, bundler.address);
    if (bundlerIdleEnd > 0n) {
        await withdraw(bundler, deployment.escrow, bundlerIdleEnd);
        console.log(`  Withdrew bundler idle: ${eth(bundlerIdleEnd)}`);
    }
    await deregister(bundler, deployment.registry, offer.quoteId);
    console.log(`  Deregistered quoteId=${offer.quoteId}`);
    const recoveredBond = await claimBond(bundler, deployment.registry);
    if (recoveredBond > 0n) console.log(`  Claimed bond: ${eth(recoveredBond)}`);

    // -- Final state -----------------------------------------------------------

    STEP(8, "Final state");

    const contractBal   = await provider.getBalance(deployment.escrow);
    const reservedBal   = BigInt(await escrow.reservedBalance());
    const signerBalEnd  = await provider.getBalance(signer.address);
    const signerDelta   = signerBalEnd - signerBalStart;
    const excess        = contractBal - reservedBal;
    console.log(`Contract balance   : ${eth(contractBal)}`);
    console.log(`Reserved balance   : ${eth(reservedBal)}`);
    if (excess > 0n) console.log(`  -> ${eth(excess)} excess (untracked)`);
    console.log(`Signer wallet delta: ${signerDelta >= 0n ? "+" : ""}${eth(signerDelta)}`);
    console.log(`\n  SLA enforcement verified:`);
    console.log(`    bundler missed the ${offer.slaBlocks}-block SLA window`);
    console.log(`    -> collateral (${eth(offer.collateralWei)}) slashed to user`);
    console.log(`    -> bundler position fully cleaned up`);

    console.log("\n" + "=".repeat(60));
    console.log(`  Demo complete. SLA enforcement verified on ${deployment.network ?? `chainId ${chainId}`}.`);
    console.log("=".repeat(60) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
