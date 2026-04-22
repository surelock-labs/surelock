// Settle path demo: bundler includes the UserOp via the real EntryPoint, then settle()
// verifies it via MPT receipt proof. Deploys a throwaway MinimalAccount as userOp.sender.
import { ethers } from "hardhat";
import type { Wallet, JsonRpcProvider } from "ethers";
import {
    register, deposit, accept, settle, withdraw, claimPayout, deregister, claimBond,
    getIdleBalance, getCommit, fetchPendingCommits,
    buildBlockHeaderRlp, buildReceiptProof, computeUserOpHash, withRetry,
} from "@surelock-labs/bundler";
import { fetchQuotes, commitOp, cancel, claimRefund } from "@surelock-labs/router";
import { loadDeployment } from "./deployment";

const SEP  = "-".repeat(64);
const STEP = (n: string, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const ok   = (s: string) => console.log(`  v ${s}`);
const info = (k: string, v: string) => console.log(`  ${k.padEnd(22)}: ${v}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";

/** Wait until the chain has advanced past targetBlock (blockhash available). */
async function waitForNextBlock(provider: JsonRpcProvider, targetBlock: number): Promise<void> {
    process.stdout.write(`  Waiting for block ${targetBlock + 1} (blockhash available)...`);
    while (true) {
        const cur = await provider.getBlockNumber();
        if (cur > targetBlock) { process.stdout.write(` done (block ${cur})\n`); return; }
        process.stdout.write(".");
        await new Promise(r => setTimeout(r, 1500));
    }
}

// ERC-4337 v0.6 canonical EntryPoint
const EP_V6 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const EP_ABI = [
    "function depositTo(address account) external payable",
    "function getNonce(address sender, uint192 key) external view returns (uint256)",
    "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary) external",
];

const DEMO_FEE_WEI    = ethers.parseUnits("5000", "gwei");
const DEMO_COLL_WEI   = DEMO_FEE_WEI + 1n;
const DEMO_SLA_BLOCKS = 100;

async function drainPendingTxs(wallet: Wallet): Promise<void> {
    const provider = wallet.provider!;
    const latest  = await provider.getTransactionCount(wallet.address, "latest");
    const pending  = await provider.getTransactionCount(wallet.address, "pending");
    if (pending <= latest) return;
    const feeData = await provider.getFeeData();
    const maxFee  = (feeData.maxFeePerGas  ?? ethers.parseUnits("1", "gwei")) * 10n;
    const maxPrio = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
    console.log(`  Clearing ${pending - latest} stuck pending tx(s) for ${wallet.address}...`);
    for (let nonce = latest; nonce < pending; nonce++) {
        const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio });
        await tx.wait();
        console.log(`  Cleared nonce ${nonce}`);
    }
}

async function main() {
    console.log("\n" + "=".repeat(64));
    console.log("  SureLock -- real EntryPoint settle() demo");
    console.log("=".repeat(64));

    const rpcUrl    = process.env["RPC_URL"]!;
    const provider  = new ethers.JsonRpcProvider(rpcUrl);
    const { chainId } = await provider.getNetwork();
    const deployment  = loadDeployment(chainId);

    const signerPk  = process.env["PRIVATE_KEY"]!;
    const bundlerPk = process.env["BUNDLER_KEY"];
    if (!bundlerPk) throw new Error("BUNDLER_KEY env var required");
    const signerWallet  = new ethers.Wallet(signerPk, provider);
    const bundlerWallet = new ethers.Wallet(bundlerPk, provider);

    await drainPendingTxs(signerWallet);
    await drainPendingTxs(bundlerWallet);

    const signer  = new ethers.NonceManager(signerWallet);
    const bundler = new ethers.NonceManager(bundlerWallet);

    console.log(`\nNetwork  : ${deployment.network ?? "unknown"} (chainId ${chainId})`);
    console.log(`Escrow   : ${deployment.escrow}`);
    console.log(`Registry : ${deployment.registry}`);
    console.log(`EntryPt  : ${EP_V6}`);
    console.log(`User     : ${signerWallet.address}`);
    console.log(`Bundler  : ${bundlerWallet.address}`);

    // -- 0. Reset state -------------------------------------------------------

    STEP("0", "Reset state");

    await claimPayout(signer, deployment.escrow);
    const idleInit = await getIdleBalance(provider, deployment.escrow, bundlerWallet.address);
    if (idleInit > 0n) await withdraw(bundler, deployment.escrow, idleInit);

    const active = await fetchQuotes(provider, deployment.registry);
    const stale  = active.find(o => o.bundler.toLowerCase() === bundlerWallet.address.toLowerCase());
    if (stale) await deregister(bundler, deployment.registry, stale.quoteId);
    const bond = await claimBond(bundler, deployment.registry);
    if (bond > 0n) ok(`Claimed stale bond: ${eth(bond)}`);

    // Recover any stuck commits belonging to either party.
    const escrowView = await ethers.getContractAt("SLAEscrow", deployment.escrow);
    const curBlock = BigInt(await provider.getBlockNumber());
    const nextId   = BigInt(await escrowView.nextCommitId());
    const feeRecipient = (await escrowView.feeRecipient() as string).toLowerCase();
    for (let id = 0n; id < nextId; id++) {
        const c = await getCommit(provider, deployment.escrow, id);
        if (c.settled || c.refunded || c.cancelled) continue;
        const isOurs = c.user.toLowerCase() === signerWallet.address.toLowerCase()
                    || c.bundler.toLowerCase() === bundlerWallet.address.toLowerCase()
                    || signerWallet.address.toLowerCase() === feeRecipient;
        if (!isOurs) continue;
        if (!c.accepted && curBlock > c.acceptDeadline) {
            await cancel(signer, deployment.escrow, id);
            console.log(`  Cancelled stale PROPOSED commitId=${id}`);
        } else if (c.accepted && c.deadline > 0n && curBlock > c.deadline + 15n) {
            await claimRefund(signer, deployment.escrow, id);
            console.log(`  Claimed refund for stale ACTIVE commitId=${id}`);
        }
    }
    await claimPayout(signer, deployment.escrow);
    ok("State clean");

    // -- 1. Register offer + deposit collateral --------------------------------

    STEP("1", "Register offer + deposit collateral");

    const offer = await register(bundler, deployment.registry, {
        feePerOp:      DEMO_FEE_WEI,
        slaBlocks:     DEMO_SLA_BLOCKS,
        collateralWei: DEMO_COLL_WEI,
        lifetime:      302_400,
    });
    ok(`Offer registered  quoteId=${offer.quoteId}`);

    await deposit(bundler, deployment.escrow, DEMO_COLL_WEI);
    ok(`Collateral deposited  idle=${eth(await getIdleBalance(provider, deployment.escrow, bundlerWallet.address))}`);

    // -- 2. Deploy MinimalAccount + pre-fund at EntryPoint --------------------
    // MinimalAccount is an always-validate ERC-4337 v0.6 smart wallet (demo only).
    // Bundler pays for both to avoid draining the user's testnet balance.

    STEP("2", "Deploy MinimalAccount, pre-fund at real EntryPoint");

    const AcctFactory = await ethers.getContractFactory("MinimalAccount", bundler);
    const acct        = await AcctFactory.deploy(EP_V6);
    await acct.waitForDeployment();
    const acctAddr = await acct.getAddress();
    ok(`MinimalAccount -> ${acctAddr}`);

    const ep      = new ethers.Contract(EP_V6, EP_ABI, bundler);
    const prefund = ethers.parseUnits("200000", "gwei");
    await (await ep.depositTo(acctAddr, { value: prefund })).wait();
    ok(`Deposited ${gwei(prefund)} to EntryPoint for MinimalAccount`);

    // -- 3. User commits to real escrow ---------------------------------------

    STEP("3", "User commits to real SLAEscrow");

    const feeData  = await provider.getFeeData();
    const maxFee   = feeData.maxFeePerGas  ?? ethers.parseUnits("2", "gwei");
    const maxPrio  = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
    const nonce    = await ep.getNonce(acctAddr, 0n);
    const userOp   = {
        sender:                acctAddr,
        nonce,
        initCode:              "0x",
        callData:              "0x",
        callGasLimit:          50_000n,
        verificationGasLimit:  80_000n,
        preVerificationGas:    21_000n,
        maxFeePerGas:          maxFee,
        maxPriorityFeePerGas:  maxPrio,
        paymasterAndData:      "0x",
        signature:             "0x",
    };
    const userOpHash = computeUserOpHash(userOp, EP_V6, chainId);
    info("userOpHash", userOpHash.slice(0, 18) + "...");

    const { commitId: userCommitId, blockNumber: commitBlock } = await commitOp(signer, deployment.escrow, offer, userOpHash);
    info("commitId", userCommitId.toString());
    info("commitBlock", commitBlock.toString());

    // -- 4. Bundler discovers and accepts -------------------------------------
    // In production the bundler watches CommitCreated events via watchCommits().
    // Here we scan from commitBlock so the bundler side is independent of step 3.

    STEP("4", "Bundler discovers commit and accepts");

    const pending = await fetchPendingCommits(provider, deployment.escrow, bundlerWallet.address, commitBlock);
    if (pending.length === 0) throw new Error("Bundler: no pending commits found");
    const { commitId } = pending[0];
    info("discovered commitId", commitId.toString());

    const acceptRcpt = await accept(bundler, deployment.escrow, commitId);
    const c1 = await getCommit(provider, deployment.escrow, commitId, acceptRcpt.blockNumber);
    info("SLA deadline", `block ${c1.deadline}`);
    ok("Commit ACTIVE");

    // -- 5. Submit real UserOp through EntryPoint ----------------------------

    STEP("5", "handleOps() on real ERC-4337 v0.6 EntryPoint");

    const handleTx   = await (ep as any).handleOps([userOp], bundlerWallet.address);
    const handleRcpt = await handleTx.wait();
    const inclusionBlock: number = handleRcpt!.blockNumber;
    const txHash: string         = handleRcpt!.hash;
    info("txHash", txHash);
    info("inclusionBlock", inclusionBlock.toString());
    ok("UserOperationEvent mined by the real EntryPoint");

    // blockhash(N) is unavailable in block N itself -- must wait for N+1.
    await waitForNextBlock(provider, inclusionBlock);

    // -- A. Build block header RLP -------------------------------------------

    STEP("A", "buildBlockHeaderRlp");

    const rpcProvider = { send: (m: string, p: unknown[]) => provider.send(m, p) };
    const blockHeaderRlp = await withRetry(() => buildBlockHeaderRlp(rpcProvider, inclusionBlock));
    ok(`keccak256(RLP) == blockhash(${inclusionBlock})`);

    // -- B. Build receipt MPT proof ------------------------------------------

    STEP("B", "buildReceiptProof");

    const { proofNodes, txIndex } = await withRetry(() => buildReceiptProof(rpcProvider, inclusionBlock, txHash));
    ok(`receiptsRoot matches  (${proofNodes.length} node(s), txIndex=${txIndex})`);

    // -- C. settle() on real SLAEscrow ---------------------------------------

    STEP("C", "settle() on real SLAEscrow -- MPT verification against blockhash()");

    const proofHex = proofNodes.map(n => ethers.hexlify(n));
    let settleRcpt: Awaited<ReturnType<typeof settle>>;
    try {
        settleRcpt = await settle(bundler, deployment.escrow, commitId, BigInt(inclusionBlock), blockHeaderRlp, proofHex, txIndex);
    } catch (e: any) {
        console.error(`\n  x settle() REVERTED: ${e.message}`);
        process.exit(1);
    }

    const c2 = await getCommit(provider, deployment.escrow, commitId, settleRcpt!.blockNumber);
    if (!c2.settled) {
        console.error(`\n  x settle() mined but commit.settled is still false`);
        process.exit(1);
    }
    ok(`commit.settled         = ${c2.settled}`);
    ok(`commit.inclusionBlock  = ${c2.inclusionBlock}`);

    // -- 6. Cleanup ----------------------------------------------------------

    STEP("6", "Cleanup");

    try {
        const paid = await claimPayout(bundler, deployment.escrow, settleRcpt!.blockNumber);
        if (paid > 0n) ok(`Bundler claimed ${gwei(paid)}`);
        const idleEnd = await getIdleBalance(provider, deployment.escrow, bundlerWallet.address);
        if (idleEnd > 0n) {
            await withdraw(bundler, deployment.escrow, idleEnd);
            ok(`Withdrew bundler idle: ${eth(idleEnd)}`);
        }
        await deregister(bundler, deployment.registry, offer.quoteId);
        const reclaimed = await claimBond(bundler, deployment.registry);
        if (reclaimed > 0n) ok(`Claimed bond: ${eth(reclaimed)}`);
        await claimPayout(signer, deployment.escrow);
    } catch (e: any) {
        console.log(`  (cleanup partial -- ${e.shortMessage ?? e.message}; re-run step 0 to finish)`);
    }

    // -- Summary -------------------------------------------------------------

    console.log("\n" + "=".repeat(64));
    console.log(`  RESULT -- real EntryPoint settle() on ${deployment.network ?? `chainId ${chainId}`}`);
    console.log("=".repeat(64));
    console.log(`\n  v Step A  buildBlockHeaderRlp  PASS`);
    console.log(`  v Step B  buildReceiptProof    PASS`);
    console.log(`  v Step C  settle() on-chain    PASS`);
    console.log(`\n  commitId=${commitId} is now SETTLED in the permanent SLAEscrow.`);
    console.log(`  Run 'surelock --rpc <network> stats' to confirm Settled count > 0.`);
    console.log("\n" + "=".repeat(64) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
