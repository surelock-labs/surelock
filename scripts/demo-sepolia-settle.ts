// MPT proof validation on Base Sepolia -- settle() happy path
// Usage: npm run demo:sepolia:settle
import { ethers, upgrades } from "hardhat";
import type { Wallet } from "ethers";
import {
    register, deposit, accept, settle, claimPayout,
    getIdleBalance, getCommit,
    buildBlockHeaderRlp, buildReceiptProof, withRetry,
} from "@surelock-labs/bundler";
import { commitOp } from "@surelock-labs/router";

const SEP  = "-".repeat(64);
const STEP = (n: string, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const ok   = (s: string) => console.log(`  v ${s}`);
const info = (k: string, v: string) => console.log(`  ${k.padEnd(22)}: ${v}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";

const DEMO_FEE_WEI    = ethers.parseUnits("5000", "gwei");
const DEMO_COLL_WEI   = DEMO_FEE_WEI + 1n;
const DEMO_SLA_BLOCKS = 100;
const DEMO_BOND       = ethers.parseEther("0.0001");

async function drainPendingTxs(wallet: Wallet): Promise<void> {
    const provider = wallet.provider!;
    const latest  = await provider.getTransactionCount(wallet.address, "latest");
    const pending  = await provider.getTransactionCount(wallet.address, "pending");
    if (pending <= latest) return;
    const feeData = await provider.getFeeData();
    const maxFee = (feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei")) * 10n;
    const maxPrio = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
    console.log(`  Clearing ${pending - latest} stuck pending tx(s) for ${wallet.address}...`);
    for (let nonce = latest; nonce < pending; nonce++) {
        const tx = await wallet.sendTransaction({
            to: wallet.address, value: 0n, nonce,
            maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio,
        });
        await tx.wait();
        console.log(`  Cleared nonce ${nonce}`);
    }
}

async function main() {
    console.log("\n" + "=".repeat(64));
    console.log("  SureLock -- MPT settle() proof validation on Base Sepolia");
    console.log("=".repeat(64));

    // Direct JsonRpcProvider so Hardhat middleware doesn't interfere with nonces.
    const rpcUrl   = process.env["RPC_URL"]!;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const { chainId } = await provider.getNetwork();

    const signerPk  = process.env["PRIVATE_KEY"]!;
    const bundlerPk = process.env["BUNDLER_KEY"];
    if (!bundlerPk) throw new Error("BUNDLER_KEY env var required -- use: surelock exec --key deployer --bundler-key demo-bundler -- ...");
    const signerWallet  = new ethers.Wallet(signerPk, provider);
    const bundlerWallet = new ethers.Wallet(bundlerPk, provider);

    await drainPendingTxs(signerWallet);
    await drainPendingTxs(bundlerWallet);

    // Separate NonceManagers -- signer and bundler are different addresses.
    const signer  = new ethers.NonceManager(signerWallet);
    const bundler = new ethers.NonceManager(bundlerWallet);

    console.log(`\nNetwork  : chainId ${chainId}`);
    console.log(`User     : ${signerWallet.address}`);
    console.log(`Bundler  : ${bundlerWallet.address}`);
    console.log(`Balance  : ${eth(await provider.getBalance(signerWallet.address))}`);

    // -- 1. Deploy MockEntryPoint ---------------------------------------------

    STEP("1", "Deploy MockEntryPoint");

    const EPFactory = await ethers.getContractFactory("MockEntryPoint", signer);
    const mockEP    = await EPFactory.deploy();
    await mockEP.waitForDeployment();
    const epAddr = await mockEP.getAddress();
    ok(`MockEntryPoint -> ${epAddr}`);

    // -- 2. Deploy QuoteRegistry + SLAEscrow (throwaway) ----------------------

    STEP("2", "Deploy throwaway QuoteRegistry + SLAEscrow (ENTRY_POINT = MockEntryPoint)");

    const RegFactory = await ethers.getContractFactory("QuoteRegistry", signer);
    const registry   = await RegFactory.deploy(signerWallet.address, DEMO_BOND);
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    ok(`QuoteRegistry -> ${registryAddr}`);

    const EscrowFactory = await ethers.getContractFactory("SLAEscrow", signer);
    const escrow = await upgrades.deployProxy(
        EscrowFactory,
        [registryAddr, signerWallet.address],
        { kind: "uups", constructorArgs: [epAddr] },
    );
    await escrow.waitForDeployment();
    const escrowAddr = await escrow.getAddress();
    ok(`SLAEscrow     -> ${escrowAddr}`);
    info("ENTRY_POINT (mock)", epAddr);

    // -- 3. Bundler registers + deposits collateral (SDK) ---------------------

    STEP("3", "Bundler registers offer, deposits collateral");

    const needed = DEMO_BOND + DEMO_COLL_WEI + ethers.parseEther("0.002");
    const bundlerBal = await provider.getBalance(bundlerWallet.address);
    if (bundlerBal < needed)
        throw new Error(`Insufficient bundler balance: have ${eth(bundlerBal)}, need ${eth(needed)}`);
    ok(`Bundler balance sufficient (${eth(bundlerBal)})`);

    const offer = await register(bundler, registryAddr, {
        feePerOp:      DEMO_FEE_WEI,
        slaBlocks:     DEMO_SLA_BLOCKS,
        collateralWei: DEMO_COLL_WEI,
        lifetime:      302_400,
    });
    ok(`Offer registered  quoteId=${offer.quoteId}`);

    await deposit(bundler, escrowAddr, DEMO_COLL_WEI);
    const idle = await getIdleBalance(provider, escrowAddr, bundlerWallet.address);
    ok(`Collateral deposited  idle=${eth(idle)}`);

    // -- 4. User commits (router SDK) ----------------------------------------

    STEP("4", "User commits a UserOp");

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes(`surelock-mpt-test-${Date.now()}`));
    const { commitId, blockNumber: commitBlock } = await commitOp(signer, escrowAddr, offer, userOpHash);

    const c0 = await getCommit(provider, escrowAddr, commitId, commitBlock);
    info("commitId", commitId.toString());
    info("userOpHash", userOpHash.slice(0, 18) + "...");
    info("acceptDeadline", `block ${c0.acceptDeadline}`);

    // -- 5. Bundler accepts (SDK) --------------------------------------------

    STEP("5", "Bundler accepts (locks collateral, starts SLA clock)");

    await accept(bundler, escrowAddr, commitId);

    const c1 = await getCommit(provider, escrowAddr, commitId);
    info("SLA deadline", `block ${c1.deadline}`);
    info("collateral locked", eth(c1.collateralLocked));
    ok("Commit is ACTIVE");

    // -- 6. Emit UserOperationEvent on Sepolia --------------------------------

    STEP("6", "Bundler calls MockEntryPoint.handleOp() -- mines the event on-chain");

    const handleTx   = await (mockEP as any).connect(bundler).handleOp(userOpHash);
    const handleRcpt = await handleTx.wait();

    const inclusionBlock: number = handleRcpt!.blockNumber;
    const txHash: string         = handleRcpt!.hash;
    info("txHash", txHash);
    info("inclusionBlock", inclusionBlock.toString());
    ok("UserOperationEvent mined on Base Sepolia");

    // -- Step A: Build block header RLP ---------------------------------------

    STEP("A", "buildBlockHeaderRlp -- verifying Base Sepolia header encodes correctly");

    const rpcProvider = { send: (m: string, p: unknown[]) => provider.send(m, p) };
    let blockHeaderRlp: string;
    try {
        blockHeaderRlp = await withRetry(() => buildBlockHeaderRlp(rpcProvider, inclusionBlock));
        ok(`keccak256(RLP) == blockhash(${inclusionBlock})  <- header encoding correct`);
    } catch (e: any) {
        console.error(`\n  x buildBlockHeaderRlp FAILED:\n    ${e.message}`);
        process.exit(1);
    }

    // -- Step B: Build receipt MPT proof -------------------------------------

    STEP("B", "buildReceiptProof -- verifying receipt trie encodes correctly");

    let proofNodes: Uint8Array[];
    let txIndex: number;
    try {
        const proof = await withRetry(() => buildReceiptProof(rpcProvider, inclusionBlock, txHash));
        proofNodes  = proof.proofNodes;
        txIndex     = proof.txIndex;
        ok(`receiptsRoot matches  (${proofNodes.length} node(s), txIndex=${txIndex})`);
    } catch (e: any) {
        console.error(`\n  x buildReceiptProof FAILED:\n    ${e.message}`);
        process.exit(1);
    }

    // -- Step C: settle() on-chain (SDK) --------------------------------------

    STEP("C", "settle() -- on-chain MPT verification against real blockhash()");

    const proofHex = proofNodes.map(n => ethers.hexlify(n));

    let settleRcpt: Awaited<ReturnType<typeof settle>>;
    try {
        settleRcpt = await settle(bundler, escrowAddr, commitId, BigInt(inclusionBlock), blockHeaderRlp, proofHex, txIndex);
    } catch (e: any) {
        console.error(`\n  x settle() REVERTED:\n    ${e.message}`);
        console.error("  Steps A and B passed but the on-chain verifier rejected the proof.");
        process.exit(1);
    }

    // Pin reads to the settle block -- load-balanced RPCs may return stale "latest".
    const c2 = await getCommit(provider, escrowAddr, commitId, settleRcpt!.blockNumber);
    if (!c2.settled) {
        console.error(`\n  x settle() tx mined (block ${settleRcpt!.blockNumber}) but commit.settled is still false`);
        process.exit(1);
    }
    ok(`commit.settled         = ${c2.settled}`);
    ok(`commit.inclusionBlock  = ${c2.inclusionBlock}`);

    STEP("7", "Cleanup -- bundler claims settled fee from throwaway escrow");

    const paid = await claimPayout(bundler, escrowAddr, settleRcpt!.blockNumber);
    if (paid > 0n) ok(`Bundler claimed ${gwei(paid)}`);
    else console.log("  (no pending payout -- nothing to claim)");

    // -- Final summary --------------------------------------------------------

    console.log("\n" + "=".repeat(64));
    console.log("  MPT settle() proof path -- BASE SEPOLIA RESULT");
    console.log("=".repeat(64));
    console.log(`\n  v Step A  buildBlockHeaderRlp  PASS`);
    console.log(`  v Step B  buildReceiptProof    PASS`);
    console.log(`  v Step C  settle() on-chain    PASS`);
    console.log(`\n  The MPT settle path works correctly on Base Sepolia.`);
    console.log(`  SLA enforcement verified: bundler settled commitId=${commitId}.`);
    console.log("\n" + "=".repeat(64) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
