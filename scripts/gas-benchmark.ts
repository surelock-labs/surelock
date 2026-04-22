/**
 * Gas benchmark -- all hot-path SLAEscrow + QuoteRegistry operations on Base Sepolia.
 *
 * Runs every measurable on-chain operation once and prints a summary table.
 *
 * Measured operations:
 *   QuoteRegistry: register, renew
 *   SLAEscrow:     deposit, commit, accept, cancel, claimRefund, claimPayout, withdraw
 *
 * NOT measured here (require special setup):
 *   settle()         -- needs a live MPT receipt proof; see scripts/demo-sepolia-settle.ts
 *   deregister()     -- requires offer to expire (MIN_LIFETIME = 302,400 blocks ~= 7 days)
 *   claimBond()      -- same; callable after deregister()
 *
 * Usage:
 *   npx hardhat run scripts/gas-benchmark.ts --network baseSepolia
 */
import { ethers } from "hardhat";
import { loadDeployment } from "./deployment";

const SEP  = "-".repeat(60);
const STEP = (n: number, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pinRead<T>(fn: () => Promise<T>, retries = 4, delayMs = 1500): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e: any) {
            if (i >= retries || !/header not found|block not found/i.test(String(e))) throw e;
            await sleep(delayMs);
        }
    }
}

async function waitForBlock(provider: ethers.Provider, targetBlock: number, label: string) {
    process.stdout.write(`  Waiting for block ${targetBlock} (${label})...`);
    while (true) {
        const cur = await provider.getBlockNumber();
        if (cur >= targetBlock) { process.stdout.write(` done (block ${cur})\n`); return; }
        process.stdout.write(".");
        // On hardhat/localhost, mine a block rather than sleep-polling
        try { await (provider as any).send("evm_mine", []); } catch { await sleep(2000); }
    }
}

// Deterministic demo bundler -- same wallet as demo-sepolia.ts
const DEMO_BUNDLER_SEED = "surelock demo bundler v1 base sepolia";

// Benchmark offer parameters (same as demo -- kept tiny for cheap runs)
const BENCH_FEE_WEI  = ethers.parseUnits("1", "gwei");
const BENCH_COLL_WEI = BENCH_FEE_WEI + 1n;
const BENCH_SLA      = 2; // blocks

// ---- result table -----------------------------------------------------------

interface GasRow {
    contract: string;
    operation: string;
    gasUsed: bigint;
    gasPriceGwei: string;
    ethCost: string;
}

const rows: GasRow[] = [];

function record(contract: string, operation: string, r: ethers.TransactionReceipt) {
    const price = r.gasPrice ?? 0n;
    rows.push({
        contract,
        operation,
        gasUsed:      r.gasUsed,
        gasPriceGwei: ethers.formatUnits(price, "gwei"),
        ethCost:      ethers.formatEther(r.gasUsed * price),
    });
    console.log(`  gas: ${r.gasUsed.toLocaleString()} units @ ${ethers.formatUnits(price, "gwei")} gwei = ${ethers.formatEther(r.gasUsed * price)} ETH`);
}

function printTable() {
    const pad = (s: string, n: number) => s.padEnd(n);
    const padL = (s: string, n: number) => s.padStart(n);

    const COL = [20, 16, 12, 12, 20];
    const header = [
        pad("Contract",   COL[0]),
        pad("Operation",  COL[1]),
        padL("Gas units", COL[2]),
        padL("Gas (gwei)",COL[3]),
        padL("ETH cost",  COL[4]),
    ].join("  ");
    const sep = COL.map(n => "-".repeat(n)).join("  ");

    console.log("\n" + "=".repeat(84));
    console.log("  Gas benchmark results");
    console.log("=".repeat(84));
    console.log(header);
    console.log(sep);
    for (const row of rows) {
        console.log([
            pad(row.contract,   COL[0]),
            pad(row.operation,  COL[1]),
            padL(row.gasUsed.toLocaleString(), COL[2]),
            padL(row.gasPriceGwei,             COL[3]),
            padL(row.ethCost + " ETH",         COL[4]),
        ].join("  "));
    }
    console.log(sep);
    console.log([
        pad("NOT MEASURED", COL[0]),
        pad("settle()",     COL[1]),
        padL("~175-200k",   COL[2]),
        padL("-",           COL[3]),
        padL("see settle demo", COL[4]),
    ].join("  "));
    console.log([
        pad("QuoteRegistry",  COL[0]),
        pad("deregister()",   COL[1]),
        padL("~50-60k",       COL[2]),
        padL("-",             COL[3]),
        padL("MIN_LIFETIME=302400blks", COL[4]),
    ].join("  "));
    console.log([
        pad("QuoteRegistry",  COL[0]),
        pad("claimBond()",    COL[1]),
        padL("~30-40k",       COL[2]),
        padL("-",             COL[3]),
        padL("after deregister()", COL[4]),
    ].join("  "));
    console.log("=".repeat(84));
}

// -----------------------------------------------------------------------------

async function main() {
    console.log("\n" + "=".repeat(60));
    console.log("  surelock -- gas benchmark (v0.8)");
    console.log("=".repeat(60));

    const [signer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const deployment = loadDeployment(chainId);

    const bundlerPk = ethers.keccak256(ethers.toUtf8Bytes(DEMO_BUNDLER_SEED));
    const bundler   = new ethers.Wallet(bundlerPk, ethers.provider);

    console.log(`\nNetwork:  ${deployment.network} (chainId ${chainId})`);
    console.log(`Signer:   ${signer.address}`);
    console.log(`Bundler:  ${bundler.address}`);

    const escrow   = await ethers.getContractAt("SLAEscrow",     deployment.escrow)    as any;
    const registry = await ethers.getContractAt("QuoteRegistry", deployment.registry) as any;

    let userNonce    = await ethers.provider.getTransactionCount(signer.address,  "latest");
    let bundlerNonce = await ethers.provider.getTransactionCount(bundler.address, "latest");
    const GAS = {
        maxFeePerGas:         ethers.parseUnits("2", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    };
    const UTX = (extra: Record<string, any> = {}) => ({ nonce: userNonce++,    ...GAS, ...extra });
    const BTX = (extra: Record<string, any> = {}) => ({ nonce: bundlerNonce++, ...GAS, ...extra });

    // ---- Step 0: Reset (same pattern as demo) --------------------------------

    STEP(0, "Reset state");

    let lastStep0Block = 0;
    const SETTLE_GRACE = 10n, REFUND_GRACE = 5n;

    const stalePending = await escrow.pendingWithdrawals(signer.address) as bigint;
    if (stalePending > 0n) {
        const r = await (await escrow.connect(signer).claimPayout(UTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(`  drained stale pending: ${eth(stalePending)}`);
    }

    const staleIdle = await escrow.idleBalance(bundler.address) as bigint;
    if (staleIdle > 0n) {
        const r = await (await escrow.connect(bundler).withdraw(staleIdle, BTX())).wait();
        lastStep0Block = r!.blockNumber;
        console.log(`  drained bundler idle: ${eth(staleIdle)}`);
    }

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
            const r = await (await escrow.connect(signer).cancel(id, UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(`  cancelled orphaned PROPOSED commitId=${id}`);
        } else if (c.accepted && c.deadline > 0n && curBlock > c.deadline + SETTLE_GRACE + REFUND_GRACE) {
            const r = await (await escrow.connect(signer).claimRefund(id, UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(`  claimed orphaned refund commitId=${id}`);
        }
    }
    if (lastStep0Block > 0) {
        const p = await pinRead(() => escrow.pendingWithdrawals(signer.address, { blockTag: lastStep0Block })) as bigint;
        if (p > 0n) {
            const r = await (await escrow.connect(signer).claimPayout(UTX())).wait();
            lastStep0Block = r!.blockNumber;
            console.log(`  drained recovered: ${eth(p)}`);
        }
    }
    console.log("  reset complete");

    // ---- Step 1: QuoteRegistry.register() -----------------------------------

    STEP(1, "QuoteRegistry.register()");

    const bond    = await registry.registrationBond() as bigint;
    const minLt   = await registry.MIN_LIFETIME()     as bigint;

    // Fund bundler if needed
    const bundlerBal = await ethers.provider.getBalance(bundler.address);
    const needed     = bond + ethers.parseEther("0.003");
    if (bundlerBal < needed) {
        const topUp = needed - bundlerBal;
        console.log(`  funding bundler: ${eth(topUp)}`);
        await (await signer.sendTransaction({ to: bundler.address, value: topUp, ...UTX() })).wait();
    }

    // Register a fresh benchmark offer (separate from the demo's quoteId=1)
    const regTx = await registry.connect(bundler).register(
        BENCH_FEE_WEI, BENCH_SLA, BENCH_COLL_WEI, minLt,
        BTX({ value: bond })
    );
    const regReceipt = await regTx.wait();
    const regEvent = regReceipt?.logs
        .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === "OfferRegistered");
    const benchQuoteId: bigint = regEvent?.args?.quoteId as bigint;
    console.log(`  registered quoteId=${benchQuoteId}`);
    record("QuoteRegistry", "register()", regReceipt!);

    // ---- Step 2: QuoteRegistry.renew() --------------------------------------

    STEP(2, "QuoteRegistry.renew()");

    const renewReceipt = await (await registry.connect(bundler).renew(benchQuoteId, BTX())).wait();
    console.log(`  renewed quoteId=${benchQuoteId}`);
    record("QuoteRegistry", "renew()", renewReceipt!);

    // ---- Step 3: SLAEscrow.deposit() ----------------------------------------

    STEP(3, "SLAEscrow.deposit()");

    const depositReceipt = await (await escrow.connect(bundler).deposit(
        BTX({ value: BENCH_COLL_WEI * 2n })  // enough for both commits A and B
    )).wait();
    console.log(`  deposited ${eth(BENCH_COLL_WEI * 2n)}`);
    record("SLAEscrow", "deposit()", depositReceipt!);

    // ---- Step 4: SLAEscrow.commit() -- commit A (will be accepted + SLA miss)

    STEP(4, "SLAEscrow.commit() -- path A (accept + SLA miss)");

    const protocolFee = await escrow.protocolFeeWei() as bigint;
    const hashA = ethers.keccak256(ethers.toUtf8Bytes(`bench-A-${Date.now()}`));
    const idA   = await escrow.nextCommitId() as bigint;

    const commitAReceipt = await (await escrow.connect(signer).commit(
        benchQuoteId, hashA, bundler.address, BENCH_COLL_WEI as any, BENCH_SLA,
        UTX({ value: BENCH_FEE_WEI + protocolFee })
    )).wait();
    console.log(`  commitId=${idA} userOpHash=${hashA.slice(0, 10)}...`);
    record("SLAEscrow", "commit()", commitAReceipt!);

    // ---- Step 5: SLAEscrow.accept() -----------------------------------------

    STEP(5, "SLAEscrow.accept()");

    const acceptReceipt = await (await escrow.connect(bundler).accept(idA, BTX())).wait();
    const cA = await pinRead(() =>
        escrow.getCommit(idA, { blockTag: acceptReceipt!.blockNumber })
    ) as any;
    console.log(`  accepted commitId=${idA} -- SLA deadline block ${cA.deadline}`);
    record("SLAEscrow", "accept()", acceptReceipt!);

    // ---- Step 6: SLAEscrow.commit() -- commit B (will be cancelled) ----------

    STEP(6, "SLAEscrow.commit() -- path B (cancel)");

    const hashB = ethers.keccak256(ethers.toUtf8Bytes(`bench-B-${Date.now()}`));
    const idB   = await escrow.nextCommitId() as bigint;

    const commitBReceipt = await (await escrow.connect(signer).commit(
        benchQuoteId, hashB, bundler.address, BENCH_COLL_WEI as any, BENCH_SLA,
        UTX({ value: BENCH_FEE_WEI + protocolFee })
    )).wait();
    const cB0 = await pinRead(() =>
        escrow.getCommit(idB, { blockTag: commitBReceipt!.blockNumber })
    ) as any;
    console.log(`  commitId=${idB} -- acceptDeadline block ${cB0.acceptDeadline}`);
    record("SLAEscrow", "commit() [cancel path]", commitBReceipt!);

    // ---- Step 7: Wait for cancel(B) and claimRefund(A) windows --------------

    STEP(7, "Waiting for cancel + refund windows");

    // cancel(B) opens at: cB0.acceptDeadline + 1
    // claimRefund(A) opens at: cA.deadline + SETTLEMENT_GRACE(10) + REFUND_GRACE(5) + 4 buffer
    const cancelBlock  = Number(cB0.acceptDeadline) + 1;
    const refundBlock  = Number(cA.deadline) + 10 + 5 + 4;
    const waitUntil    = Math.max(cancelBlock, refundBlock);
    const approxSecs   = (waitUntil - (await ethers.provider.getBlockNumber())) * 2;

    console.log(`  cancel(B) opens   : block ${cancelBlock}`);
    console.log(`  claimRefund(A) opens: block ${refundBlock}`);
    console.log(`  waiting until     : block ${waitUntil} (~${approxSecs}s)`);

    await waitForBlock(ethers.provider, waitUntil, "cancel + refund");

    // ---- Step 8: SLAEscrow.cancel() -----------------------------------------

    STEP(8, "SLAEscrow.cancel()");

    const cancelReceipt = await (await escrow.connect(signer).cancel(idB, UTX())).wait();
    console.log(`  cancelled commitId=${idB}`);
    record("SLAEscrow", "cancel()", cancelReceipt!);

    // ---- Step 9: SLAEscrow.claimRefund() ------------------------------------

    STEP(9, "SLAEscrow.claimRefund()");

    let claimRefundReceipt!: ethers.ContractTransactionReceipt | null;
    for (let attempt = 0; ; attempt++) {
        try {
            claimRefundReceipt = await (await escrow.connect(signer).claimRefund(idA, UTX())).wait();
            break;
        } catch (e: any) {
            if (attempt >= 5) throw e;
            console.log(`  attempt ${attempt + 1} reverted -- waiting 2 blocks for RPC sync`);
            userNonce--;
            await waitForBlock(ethers.provider, await ethers.provider.getBlockNumber() + 2, "sync");
        }
    }
    console.log(`  refund claimed for commitId=${idA}`);
    record("SLAEscrow", "claimRefund()", claimRefundReceipt!);

    // ---- Step 10: SLAEscrow.claimPayout() -----------------------------------

    STEP(10, "SLAEscrow.claimPayout()");

    const pending = await pinRead(() =>
        escrow.pendingWithdrawals(signer.address, { blockTag: claimRefundReceipt!.blockNumber })
    ) as bigint;
    const claimPayoutReceipt = await (await escrow.connect(signer).claimPayout(UTX())).wait();
    console.log(`  claimed ${eth(pending)}`);
    record("SLAEscrow", "claimPayout()", claimPayoutReceipt!);

    // ---- Step 11: SLAEscrow.withdraw() (bundler) ----------------------------

    STEP(11, "SLAEscrow.withdraw()");

    // Bundler's idle: deposit(2x COLL) - lockAndRelease(commitA's COLL) -- after SLA miss the
    // collateral was slashed (subtracted from deposited), so idle = depositedAmount - slashedAmount.
    // Whatever is left from the reset drain + new deposit.
    const idleNow = await escrow.idleBalance(bundler.address) as bigint;
    if (idleNow > 0n) {
        const withdrawReceipt = await (await escrow.connect(bundler).withdraw(idleNow, BTX())).wait();
        console.log(`  withdrew ${eth(idleNow)}`);
        record("SLAEscrow", "withdraw()", withdrawReceipt!);
    } else {
        console.log(`  bundler idle = 0 (all collateral was slashed) -- skipping withdraw()`);
        console.log(`  NOTE: withdraw() gas not captured this run.`);
        console.log(`        From previous demo runs: ~38,000-40,000 units.`);
    }

    // ---- Final: print table --------------------------------------------------

    printTable();

    console.log("\n  Network:  " + deployment.network + " (chainId " + chainId + ")");
    console.log("  Date:     " + new Date().toISOString());
    console.log("  Commit:   run 'git rev-parse --short HEAD' for the contract version\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
