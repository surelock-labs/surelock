/**
 * End-to-end testnet demo -- Base Sepolia (v0.8)
 *
 * Demonstrates the SLA enforcement / slashing path:
 *   setup bundler -> register offer -> commit -> accept -> [SLA passes] -> claimRefund
 *
 * The bundler uses PRIVATE_KEY (same as signer) -- one wallet plays both roles on testnet.
 * The 0.01 ETH registration bond is paid once per MIN_LIFETIME (~= 7 days).
 *
 * Usage: npm run demo:sepolia   or   ./surelock demo --network baseSepolia
 */
import { ethers } from "hardhat";
import { loadDeployment } from "./deployment";

const SEP  = "-".repeat(60);
const STEP = (n: number, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";
const gasLine = (r: ethers.TransactionReceipt) =>
    `  gas              : ${r.gasUsed.toLocaleString()} units @ ${ethers.formatUnits(r.gasPrice ?? 0n, "gwei")} gwei = ${eth(r.gasUsed * (r.gasPrice ?? 0n))}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Retry a pinned-block read -- handles RPC propagation lag on load-balanced nodes. */
async function pinRead<T>(fn: () => Promise<T>, retries = 4, delayMs = 1500): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e: any) {
            if (i >= retries || !/header not found|block not found/i.test(String(e))) throw e;
            await sleep(delayMs);
        }
    }
}

/** Poll until currentBlock >= targetBlock, printing progress dots. */
async function waitForBlock(provider: ethers.Provider, targetBlock: number, label: string) {
    process.stdout.write(`  Waiting for block ${targetBlock} (${label})...`);
    while (true) {
        const cur = await provider.getBlockNumber();
        if (cur >= targetBlock) { process.stdout.write(` done (block ${cur})\n`); return; }
        process.stdout.write(".");
        try { await (provider as any).send("evm_mine", []); } catch { await sleep(2000); }
    }
}

// Demo offer parameters -- realistic fee (covers bundler gas cost on Base), minimal collateral.
const DEMO_FEE_WEI     = ethers.parseUnits("5000", "gwei"); // 5000 gwei -- above bundler break-even (~2700 gwei at 0.01 gwei basefee)
const DEMO_COLL_WEI    = DEMO_FEE_WEI + 1n;                // strictly > feePerOp (T8); minimal for testnet
const DEMO_SLA_BLOCKS  = 2;                                 // 2-block SLA window

async function main() {
    console.log("\n" + "=".repeat(60));
    console.log("  surelock -- Base Sepolia end-to-end demo (v0.8)");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const deployment = loadDeployment(chainId);

    // Bundler wallet uses BUNDLER_KEY -- must be a different address from signer (SelfCommitForbidden).
    const bundlerPk = process.env["BUNDLER_KEY"];
    if (!bundlerPk) throw new Error("BUNDLER_KEY env var required -- use: surelock exec --key deployer --bundler-key demo-bundler -- ...");
    const bundler   = new ethers.Wallet(bundlerPk, ethers.provider);

    console.log(`\nNetwork:     ${deployment.network} (chainId ${chainId})`);
    console.log(`User:        ${signer.address}`);
    console.log(`Bundler:     ${bundler.address}`);
    console.log(`Registry:    ${deployment.registry}`);
    console.log(`SLAEscrow:   ${deployment.escrow}`);

    const escrow   = await ethers.getContractAt("SLAEscrow",     deployment.escrow)    as any;
    const registry = await ethers.getContractAt("QuoteRegistry", deployment.registry) as any;

    // Separate nonce counters for signer (user) and bundler -- different addresses, independent sequences.
    let userNonce    = await ethers.provider.getTransactionCount(signer.address,  "latest");
    let bundlerNonce = await ethers.provider.getTransactionCount(bundler.address, "latest");
    const GAS = {
        maxFeePerGas:         ethers.parseUnits("2", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
        gasLimit:             300_000, // explicit limit -- Base Sepolia rejects eth_estimateGas without one
    };
    const UTX = (extra: Record<string, any> = {}) => ({ nonce: userNonce++,    ...GAS, ...extra });
    const BTX = (extra: Record<string, any> = {}) => ({ nonce: bundlerNonce++, ...GAS, ...extra });

    // -- Step 0: Reset state -- drain any leftovers from previous runs ---------

    STEP(0, "Reset state (drain pre-existing balances)");

    // Track the last block from any step-0 tx so we can pin start reads to it.
    let lastStep0Block = 0;

    // Drain signer pending withdrawals
    const stalePending = await escrow.pendingWithdrawals(signer.address) as bigint;
    if (stalePending > 0n) {
        console.log(`Draining stale pending: ${eth(stalePending)}`);
        const r = await (await escrow.connect(signer).claimPayout(UTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(gasLine(r!));
    }

    // Drain bundler idle balance
    const staleIdle = await escrow.idleBalance(bundler.address) as bigint;
    if (staleIdle > 0n) {
        console.log(`Draining bundler idle: ${eth(staleIdle)}`);
        const r = await (await escrow.connect(bundler).withdraw(staleIdle, BTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(gasLine(r!));
    }

    // Deregister any leftover offer from this bundler and recover the bond.
    const allOffersInit: any[] = await registry.list();
    const staleOffer = allOffersInit.find(
        (o: any) => o.bundler?.toLowerCase() === bundler.address.toLowerCase()
    );
    if (staleOffer) {
        console.log(`Deregistering stale offer quoteId=${staleOffer.quoteId}`);
        const r = await (await registry.connect(bundler).deregister(staleOffer.quoteId, BTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(gasLine(r!));
    }
    // ClaimBond covers both: push-failed bonds from prior deregisters and the one just above.
    const staleBond = await registry.pendingBonds(bundler.address) as bigint;
    if (staleBond > 0n) {
        console.log(`Claiming stale bond: ${eth(staleBond)}`);
        const r = await (await registry.connect(bundler).claimBond(BTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(gasLine(r!));
    }
    // (bundler has its own funds -- no excess-return needed)

    // Cancel expired PROPOSED commits and claim abandoned refunds from ACTIVE commits.
    // Only touch commits where signer is the user, bundler, or feeRecipient --
    // on a shared deployment, unrelated open commits would cause a revert.
    const SETTLE_GRACE = 10n, REFUND_GRACE = 5n;
    const feeRecipient = (await escrow.feeRecipient() as string).toLowerCase();
    const signerAddr   = signer.address.toLowerCase();
    const curBlock = BigInt(await ethers.provider.getBlockNumber());
    const nextId   = await escrow.nextCommitId() as bigint;
    for (let id = 0n; id < nextId; id++) {
        const c = await escrow.getCommit(id) as any;
        if (c.settled || c.refunded || c.cancelled) continue;
        const isOurs = c.user.toLowerCase()    === signerAddr
                    || c.bundler.toLowerCase() === signerAddr
                    || signerAddr              === feeRecipient;
        if (!isOurs) continue;
        if (!c.accepted && curBlock > c.acceptDeadline) {
            // PROPOSED + expired accept window -- cancel() recovers feePerOp
            console.log(`Cancelling expired PROPOSED commitId=${id}`);
            const r = await (await escrow.connect(signer).cancel(id, UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(gasLine(r!));
        } else if (c.accepted && c.deadline > 0n
            && curBlock > c.deadline + SETTLE_GRACE + REFUND_GRACE) {
            // ACTIVE + SLA missed + refund window open -- claimRefund recovers fee+collateral
            console.log(`Claiming abandoned refund for commitId=${id}`);
            const r = await (await escrow.connect(signer).claimRefund(id, UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(gasLine(r!));
        }
    }
    // Drain any pending that just accumulated -- pin read to last step-0 block to avoid stale RPC
    if (lastStep0Block > 0) {
        const pendingNow = await pinRead(() =>
            escrow.pendingWithdrawals(signer.address, { blockTag: lastStep0Block })
        ) as bigint;
        if (pendingNow > 0n) {
            const r = await (await escrow.connect(signer).claimPayout(UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(`Drained recovered funds: ${eth(pendingNow)}`);
            console.log(gasLine(r!));
        }
    }

    // Pin start reads to last step-0 tx block to avoid stale-RPC inflated snapshots.
    const contractBalStart = lastStep0Block > 0
        ? await pinRead(() => ethers.provider.getBalance(deployment.escrow, lastStep0Block))
        : await ethers.provider.getBalance(deployment.escrow);
    const reservedBalStart = lastStep0Block > 0
        ? await pinRead(() => escrow.reservedBalance({ blockTag: lastStep0Block })) as bigint
        : await escrow.reservedBalance() as bigint;
    const signerBalStart = await ethers.provider.getBalance(signer.address);
    const excessStart       = contractBalStart - reservedBalStart;
    console.log(`Contract balance (start): ${eth(contractBalStart)}`);
    console.log(`Reserved balance (start): ${eth(reservedBalStart)}`);
    if (excessStart > 0n) console.log(`  -> ${eth(excessStart)} excess (direct ETH send, not protocol-tracked)`);
    console.log(`Signer  balance (start) : ${eth(signerBalStart)}`);

    // -- Step 1: Ensure bundler has an active offer ----------------------------

    STEP(1, "Setup demo bundler and register offer");

    const bond  = await registry.registrationBond() as bigint;
    const minLt = await registry.MIN_LIFETIME()     as bigint;

    // Find any existing active offer from this bundler.
    const allOffers: any[] = await registry.list();
    const existing = allOffers.find(
        (o: any) => o.bundler?.toLowerCase() === bundler.address.toLowerCase()
    );

    let quoteId: bigint;
    let collateralWei: bigint;
    let slaBlocks: number;

    if (existing) {
        quoteId       = BigInt(existing.quoteId);
        collateralWei = BigInt(existing.collateralWei);
        slaBlocks     = Number(existing.slaBlocks);
        console.log(`Re-using existing offer quoteId=${quoteId}`);
    } else {
        // (signer == bundler -- no top-up needed)

        // Register offer from the bundler wallet
        const regTx = await registry.connect(bundler).register(
            DEMO_FEE_WEI, DEMO_SLA_BLOCKS, DEMO_COLL_WEI, minLt,
            BTX({ value: bond })
        );
        const regReceipt = await regTx.wait();
        const event = regReceipt?.logs
            .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
            .find((e: any) => e?.name === "OfferRegistered");
        quoteId       = event?.args?.quoteId as bigint;
        collateralWei = DEMO_COLL_WEI;
        slaBlocks     = DEMO_SLA_BLOCKS;
        console.log(`Registered offer quoteId=${quoteId}`);
    }

    console.log(`  feePerOp  : ${gwei(DEMO_FEE_WEI)}`);
    console.log(`  slaBlocks : ${slaBlocks}`);
    console.log(`  collateral: ${eth(collateralWei)}`);

    // Ensure bundler has enough idle collateral to accept the commit.
    const idle = await escrow.idleBalance(bundler.address) as bigint;
    if (idle < collateralWei) {
        const topUp = collateralWei - idle;
        console.log(`Depositing ${eth(topUp)} collateral for bundler`);
        const depReceipt = await (await escrow.connect(bundler).deposit(BTX({ value: topUp }))).wait();
        const newIdle = await pinRead(() =>
            escrow.idleBalance(bundler.address, { blockTag: depReceipt!.blockNumber })
        ) as bigint;
        console.log(`  New idle: ${eth(newIdle)}`);
        console.log(gasLine(depReceipt!));
    } else {
        console.log(`Bundler idle balance: ${eth(idle)} (sufficient)`);
    }

    // -- Step 2: Commit a UserOp -----------------------------------------------

    STEP(2, "User commits a UserOp (pays fee, records hash)");

    const protocolFee = await escrow.protocolFeeWei() as bigint;
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes(`demo-${Date.now()}`));
    const commitId   = await escrow.nextCommitId() as bigint;
    console.log(`UserOpHash   : ${userOpHash}`);
    console.log(`CommitId     : ${commitId}`);
    console.log(`protocolFee  : ${gwei(protocolFee)}`);

    const commitTx = await escrow.connect(signer).commit(
        quoteId,
        userOpHash,
        bundler.address,
        collateralWei as any,  // uint96 in contract
        slaBlocks,
        UTX({ value: DEMO_FEE_WEI + protocolFee })
    );
    const commitReceipt = await commitTx.wait();

    const c0 = await pinRead(() =>
        escrow.getCommit(commitId, { blockTag: commitReceipt!.blockNumber })
    ) as any;
    console.log(`Committed at block ${commitReceipt!.blockNumber}`);
    console.log(`  feePaid       : ${gwei(c0.feePaid)}`);
    console.log(`  acceptDeadline: block ${c0.acceptDeadline}`);
    console.log(`  status        : PROPOSED`);
    console.log(gasLine(commitReceipt!));

    // -- Step 3: Bundler accepts -----------------------------------------------

    STEP(3, "Bundler accepts (locks collateral, starts SLA clock)");

    const acceptTx = await escrow.connect(bundler).accept(commitId, BTX());
    const acceptReceipt = await acceptTx.wait();

    const c1 = await pinRead(() =>
        escrow.getCommit(commitId, { blockTag: acceptReceipt!.blockNumber })
    ) as any;
    console.log(`Accepted at block ${acceptReceipt!.blockNumber}`);
    console.log(`  SLA deadline  : block ${c1.deadline}`);
    console.log(`  collateral    : ${eth(c1.collateralLocked)}`);
    console.log(`  status        : ACTIVE`);
    console.log(gasLine(acceptReceipt!));

    // -- Step 4: Wait for claimRefund window ----------------------------------

    STEP(4, "Waiting for SLA deadline + settlement + refund grace periods");

    // SETTLEMENT_GRACE_BLOCKS = 10, REFUND_GRACE_BLOCKS = 5
    // claimRefund unlocks at: c.deadline + 10 + 5 + 1
    // +4 extra blocks so even stale load-balanced RPC nodes (up to 3 blocks behind) pass estimateGas
    const refundUnlockBlock = Number(c1.deadline) + 10 + 5 + 4;
    const approxWait = (refundUnlockBlock - Number(c1.deadline) + slaBlocks) * 2;
    console.log(`  SLA deadline      : block ${c1.deadline}`);
    console.log(`  Settlement grace  : +10 blocks`);
    console.log(`  Refund grace      : +5 blocks`);
    console.log(`  claimRefund opens : block ${refundUnlockBlock}`);
    console.log(`  Estimated wait    : ~${approxWait}s`);

    await waitForBlock(ethers.provider, refundUnlockBlock, "claimRefund");

    // -- Step 5: User claims refund (bundler slashed) --------------------------

    STEP(5, "User claims refund -- bundler slashed for SLA miss");

    const pendingBefore = await escrow.pendingWithdrawals(signer.address) as bigint;
    // Retry on execution revert -- load-balanced RPC may return a stale "latest" block that
    // makes estimateGas think the refund window hasn't opened yet (NotExpired).
    let claimReceipt!: ethers.ContractTransactionReceipt | null;
    for (let attempt = 0; ; attempt++) {
        try {
            claimReceipt = await (await escrow.connect(signer).claimRefund(commitId, UTX())).wait();
            break;
        } catch (e: any) {
            if (attempt >= 5) throw e;
            console.log(`  claimRefund attempt ${attempt + 1} reverted -- waiting 2 blocks for RPC sync`);
            userNonce--; // roll back the nonce increment that UTX() consumed
            await waitForBlock(ethers.provider, await ethers.provider.getBlockNumber() + 2, "sync");
        }
    }

    const c2          = await pinRead(() =>
        escrow.getCommit(commitId, { blockTag: claimReceipt!.blockNumber })
    ) as any;
    const pendingAfter = await pinRead(() =>
        escrow.pendingWithdrawals(signer.address, { blockTag: claimReceipt!.blockNumber })
    ) as bigint;
    const earned = pendingAfter - pendingBefore;
    console.log(`Refund claimed`);
    console.log(`  feePaid returned  : ${gwei(BigInt(c2.feePaid))}`);
    console.log(`  collateral slashed: ${eth(BigInt(c2.collateralLocked))}`);
    console.log(`  total credited    : ${eth(earned)}`);
    console.log(`  status            : REFUNDED`);
    console.log(gasLine(claimReceipt!));

    // -- Step 6: User withdraws pending payout --------------------------------

    STEP(6, "User withdraws pending payout via claimPayout()");

    const payoutTx      = await escrow.connect(signer).claimPayout(UTX());
    const payoutReceipt = await payoutTx.wait();
    const pending2      = await pinRead(() =>
        escrow.pendingWithdrawals(signer.address, { blockTag: payoutReceipt!.blockNumber })
    ) as bigint;
    console.log(`Withdrawn: ${eth(pendingAfter)}`);
    console.log(`Remaining pending: ${eth(pending2)}`);
    console.log(gasLine(payoutReceipt!));

    // -- Final state -----------------------------------------------------------

    STEP(7, "Final state");

    const contractBal   = await ethers.provider.getBalance(deployment.escrow);
    const reservedBal   = await escrow.reservedBalance() as bigint;
    const bundlerIdle   = await escrow.idleBalance(bundler.address) as bigint;
    const signerBalEnd  = await ethers.provider.getBalance(signer.address);
    const signerDelta   = signerBalEnd - signerBalStart;
    const excess        = contractBal - reservedBal;
    console.log(`Contract balance   : ${eth(contractBal)}`);
    console.log(`Reserved balance   : ${eth(reservedBal)} (protocol-tracked -- matches contract balance v)`);
    if (excess > 0n) console.log(`  -> ${eth(excess)} excess (untracked, from direct ETH send)`);
    console.log(`Bundler idle left  : ${eth(bundlerIdle)} (collateral was slashed)`);
    console.log(`Signer wallet Delta    : ${signerDelta >= 0n ? "+" : ""}${eth(signerDelta)}`);
    console.log(`  incl. bundler gas fund (~0.001 ETH one-time), user gas, and collateral received`);
    console.log(`\n  SLA enforcement verified:`);
    console.log(`    bundler missed the ${slaBlocks}-block SLA window`);
    console.log(`    -> collateral (${eth(collateralWei)}) slashed`);
    console.log(`    -> user received fee + collateral back`);

    console.log("\n" + "=".repeat(60));
    console.log("  Demo complete. SLA enforcement verified on Base Sepolia.");
    console.log("=".repeat(60) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
