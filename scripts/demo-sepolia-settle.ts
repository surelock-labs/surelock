/**
 * MPT proof validation on Base Sepolia -- settle() happy path
 *
 * Tests the full SLAEscrow.settle() proof path against real Sepolia block data.
 * Deploys fresh contracts (MockEntryPoint + SLAEscrow) isolated from the
 * production deployment so no real ERC-4337 account is needed.
 *
 * What this actually tests:
 *   Step A -- buildBlockHeaderRlp: does keccak256(RLP) == blockhash() on Base Sepolia?
 *             Fails with "hash mismatch" if any header field is missing or wrong.
 *   Step B -- buildReceiptProof:   does the receipt trie root match block.receiptsRoot?
 *             Fails with "receiptsRoot mismatch" if receipt RLP encoding is wrong.
 *   Step C -- settle():            does the on-chain MPT verifier accept the proof?
 *             Fails with a custom error if any of the 4 verification steps fail.
 *
 * If all three pass, the MPT settle path works on Base Sepolia.
 *
 * Usage:
 *   npm run demo:sepolia:settle
 */
import { ethers, upgrades } from "hardhat";
import {
    buildBlockHeaderRlp,
    buildReceiptProof,
    withRetry,
} from "@surelock-labs/bundler";

const SEP  = "-".repeat(64);
const STEP = (n: string, s: string) => console.log(`\n[${n}] ${s}\n${SEP}`);
const ok   = (s: string) => console.log(`  v ${s}`);
const info = (k: string, v: string) => console.log(`  ${k.padEnd(22)}: ${v}`);
const eth  = (wei: bigint) => ethers.formatEther(wei) + " ETH";
const gwei = (wei: bigint) => ethers.formatUnits(wei, "gwei") + " gwei";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// withRetry from the bundler package only checks the top-level error message.
// pinRead also checks e.info.error.message, which is where ethers buries the
// underlying JSON-RPC "block not found" on load-balanced nodes.
async function pinRead<T>(fn: () => Promise<T>, retries = 6, delayMs = 2000): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e: any) {
            if (i >= retries) throw e;
            const s = `${String(e)} ${JSON.stringify(e?.info ?? {})}`;
            if (!/header not found|block not found/i.test(s)) throw e;
            await sleep(delayMs);
        }
    }
}

const DEMO_FEE_WEI      = ethers.parseUnits("5000", "gwei"); // 5000 gwei -- above bundler break-even (~2700 gwei at 0.01 gwei basefee)
const DEMO_COLL_WEI     = DEMO_FEE_WEI + 1n;                // strictly > feePerOp (T8); minimal for testnet
const DEMO_SLA_BLOCKS   = 100;                               // generous -- settle before deadline
const DEMO_BOND         = ethers.parseEther("0.0001");

/**
 * Clear any stuck pending transactions by sending 0-ETH self-transfers at each
 * stuck nonce with aggressively high gas. Necessary after failed runs that left
 * pending txs in the mempool at nonces Hardhat would re-use.
 */
async function drainPendingTxs(wallet: ethers.Wallet): Promise<void> {
    const provider = wallet.provider!;
    const latest  = await provider.getTransactionCount(wallet.address, "latest");
    const pending  = await provider.getTransactionCount(wallet.address, "pending");
    if (pending <= latest) return;
    const feeData = await provider.getFeeData();
    // 10x current maxFeePerGas to reliably replace any stuck tx
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

    // Bypass HardhatEthersProvider for transactions -- use a direct JsonRpcProvider
    // so Hardhat middleware doesn't interfere with nonce management.
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

    const UT = (extra: Record<string, any> = {}) => extra;
    const BT = (extra: Record<string, any> = {}) => extra;

    // -- 1. Deploy MockEntryPoint ---------------------------------------------

    STEP("1", "Deploy MockEntryPoint");

    const EPFactory = await ethers.getContractFactory("MockEntryPoint", signer);
    const mockEP    = await EPFactory.deploy(UT());
    await mockEP.waitForDeployment();
    const epAddr = await mockEP.getAddress();
    ok(`MockEntryPoint -> ${epAddr}`);

    // -- 2. Deploy QuoteRegistry + SLAEscrow ---------------------------------

    STEP("2", "Deploy QuoteRegistry + SLAEscrow (ENTRY_POINT = MockEntryPoint)");

    const RegFactory = await ethers.getContractFactory("QuoteRegistry", signer);
    const registry   = await RegFactory.deploy(signerWallet.address, DEMO_BOND, UT());
    await registry.waitForDeployment();
    ok(`QuoteRegistry -> ${await registry.getAddress()}`);

    const EscrowFactory = await ethers.getContractFactory("SLAEscrow", signer);
    const escrow = await upgrades.deployProxy(
        EscrowFactory,
        [await registry.getAddress(), signerWallet.address],
        { kind: "uups", constructorArgs: [epAddr] },
    );
    await escrow.waitForDeployment();
    ok(`SLAEscrow     -> ${await escrow.getAddress()}`);
    info("ENTRY_POINT (mock)", epAddr);

    // -- 3. Fund bundler and register offer -----------------------------------

    STEP("3", "Fund bundler, register offer, deposit collateral");

    const needed = DEMO_BOND + DEMO_COLL_WEI + ethers.parseEther("0.002");
    const bundlerBal = await provider.getBalance(bundlerWallet.address);
    if (bundlerBal < needed)
        throw new Error(`Insufficient bundler balance: have ${eth(bundlerBal)}, need ${eth(needed)}`);
    ok(`Bundler balance sufficient (${eth(bundlerBal)})`);

    const regTx = await (registry as any).connect(bundler).register(
        DEMO_FEE_WEI, DEMO_SLA_BLOCKS, DEMO_COLL_WEI, 302_400,
        BT({ value: DEMO_BOND }),
    );
    const regRcpt  = await regTx.wait();
    const regEvent = regRcpt?.logs
        .map((l: any) => { try { return (registry as any).interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === "OfferRegistered");
    const quoteId  = regEvent?.args?.quoteId as bigint;
    ok(`Offer registered  quoteId=${quoteId}`);

    await (await (escrow as any).connect(bundler).deposit(BT({ value: DEMO_COLL_WEI }))).wait();
    ok(`Collateral deposited  idle=${eth(BigInt(await (escrow as any).idleBalance(bundlerWallet.address)))}`);

    // -- 4. User commits ------------------------------------------------------

    STEP("4", "User commits a UserOp");

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes(`surelock-mpt-test-${Date.now()}`));
    const commitId   = BigInt(await pinRead(() => (escrow as any).nextCommitId()));

    const commitTx   = await (escrow as any).connect(signer).commit(
        quoteId, userOpHash, bundlerWallet.address, DEMO_COLL_WEI, DEMO_SLA_BLOCKS,
        UT({ value: DEMO_FEE_WEI, gasLimit: 400_000 }),
    );
    const commitRcpt = await commitTx.wait();

    const c0 = await pinRead(() =>
        (escrow as any).getCommit(commitId, { blockTag: commitRcpt!.blockNumber }),
    );
    info("commitId", commitId.toString());
    info("userOpHash", userOpHash.slice(0, 18) + "...");
    info("acceptDeadline", `block ${c0.acceptDeadline}`);

    // -- 5. Bundler accepts ---------------------------------------------------

    STEP("5", "Bundler accepts (locks collateral, starts SLA clock)");

    const acceptTx   = await (escrow as any).connect(bundler).accept(commitId, BT({ gasLimit: 300_000 }));
    const acceptRcpt = await acceptTx.wait();

    const c1 = await pinRead(() =>
        (escrow as any).getCommit(commitId, { blockTag: acceptRcpt!.blockNumber }),
    );
    info("SLA deadline", `block ${c1.deadline}`);
    info("collateral locked", eth(BigInt(c1.collateralLocked)));
    ok("Commit is ACTIVE");

    // -- 6. Emit UserOperationEvent on Sepolia --------------------------------

    STEP("6", "Bundler calls MockEntryPoint.handleOp() -- mines the event on-chain");

    const handleTx   = await (mockEP as any).connect(bundler).handleOp(userOpHash, BT({ gasLimit: 200_000 }));
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
        console.error("\n  The MPT settle path will NOT work on Base Sepolia.");
        console.error("  Check buildBlockHeaderRlp for missing hardfork fields.");
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
        console.error("\n  The MPT settle path will NOT work on Base Sepolia.");
        console.error("  Check encodeReceipt() for the Base Sepolia receipt type.");
        process.exit(1);
    }

    // -- Step C: settle() on-chain --------------------------------------------

    STEP("C", "settle() -- on-chain MPT verification against real blockhash()");

    const proofHex = proofNodes.map(n => ethers.hexlify(n));

    let settleRcpt: any;
    try {
        const settleTx = await (escrow as any).connect(bundler).settle(
            commitId,
            inclusionBlock,
            blockHeaderRlp,
            proofHex,
            txIndex,
            BT({ gasLimit: 800_000 }),
        );
        settleRcpt = await settleTx.wait();
    } catch (e: any) {
        console.error(`\n  x settle() REVERTED:\n    ${e.message}`);
        console.error("\n  Steps A and B passed but the on-chain verifier rejected the proof.");
        console.error("  Check _verifyReceiptProof in SLAEscrow.sol.");
        process.exit(1);
    }

    const settledEvent = settleRcpt?.logs
        .map((l: any) => { try { return (escrow as any).interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === "Settled");

    if (!settledEvent) {
        console.error("  x settle() did not emit Settled event.");
        process.exit(1);
    }

    const c2 = await pinRead(() =>
        (escrow as any).getCommit(commitId, { blockTag: settleRcpt!.blockNumber }),
    );

    ok(`Settled event emitted  bundlerNet=${gwei(BigInt(settledEvent.args.bundlerNet))}`);
    ok(`commit.settled         = ${c2.settled}`);
    ok(`commit.inclusionBlock  = ${c2.inclusionBlock}`);

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
