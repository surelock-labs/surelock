import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ERC-4337 EntryPoint address. Default: v0.6 canonical deployment.
// Override via ENTRY_POINT env var.
const ENTRY_POINT: string = process['env']['ENTRY_POINT'] || "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";


async function main() {
    const [deployer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();

    // -- Pending nonce check ---------------------------------------------------
    const confirmedNonce = await ethers.provider.getTransactionCount(deployer.address, "latest");
    const pendingNonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
    if (pendingNonce > confirmedNonce) {
        const stuck = pendingNonce - confirmedNonce;
        console.error(
            `[!]  Deployer has ${stuck} pending transaction${stuck > 1 ? "s" : ""}. ` +
            `Wait for them to confirm before deploying.`
        );
        process.exit(1);
    }

    // feeRecipient: use FEE_RECIPIENT env var; warn and fall back to deployer if not set
    const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;
    const isLive = network.name !== "localhost" && network.name !== "hardhat";
    if (!process.env.FEE_RECIPIENT && isLive) {
        console.warn("[!]  FEE_RECIPIENT not set -- defaulting to deployer address.");
        console.warn("   Set FEE_RECIPIENT in .env to a dedicated wallet or multisig before mainnet.\n");
    }

    const deployedAtBlock = await ethers.provider.getBlockNumber();

    console.log(`Network:      ${network.name} (chainId ${chainId})`);
    console.log(`Deployer:     ${deployer.address}`);
    console.log(`Balance:      ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
    console.log(`feeRecipient: ${feeRecipient}`);
    console.log(`entryPoint:   ${ENTRY_POINT}`);
    console.log();

    // Base Sepolia (and some other L2 testnets) reject eth_estimateGas calls that
    // don't include an explicit gas limit (block gas limit ~400M is rejected as
    // "intrinsic gas too high"). Hardhat-ethers signers don't forward the network
    // `gas` config to estimateGas, so we pass explicit overrides on live networks.
    const gasOverride = isLive ? { gasLimit: 8_000_000 } : {};

    // -- QuoteRegistry ---------------------------------------------------------
    // Initial bond 0.01 ETH -- signal-of-intent deposit, within [MIN_BOND, MAX_BOND].
    const initialBond = ethers.parseEther("0.01");
    const RegistryFactory = await ethers.getContractFactory("QuoteRegistry");
    const registry = await RegistryFactory.deploy(deployer.address, initialBond, gasOverride);
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    console.log(`QuoteRegistry -> ${registryAddr}`);

    // -- SLAEscrow (UUPS proxy) ------------------------------------------------
    const EscrowFactory = await ethers.getContractFactory("SLAEscrow");
    const escrow = await upgrades.deployProxy(
        EscrowFactory,
        [registryAddr, feeRecipient],
        { kind: "uups", constructorArgs: [ENTRY_POINT], txOverrides: gasOverride }
    );
    await escrow.waitForDeployment();
    const escrowAddr = await escrow.getAddress();
    console.log(`SLAEscrow (proxy) -> ${escrowAddr}`);
    // Read implementation address with retries -- live nodes may need time to index the proxy
    let escrowImpl = "unknown";
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            escrowImpl = await upgrades.erc1967.getImplementationAddress(escrowAddr);
            break;
        } catch {
            if (attempt < 5) {
                console.log(`  impl lookup attempt ${attempt}/5 failed, retrying in 3s...`);
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
    }
    if (escrowImpl === "unknown") {
        // Fallback: read raw ERC-1967 impl storage slot
        const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
        const raw = await ethers.provider.getStorage(escrowAddr, IMPL_SLOT);
        const parsed = "0x" + raw.slice(-40);
        if (parsed !== "0x" + "0".repeat(40)) {
            escrowImpl = ethers.getAddress(parsed);
        } else {
            console.warn("[!]  Could not resolve SLAEscrow implementation address -- continuing with 'unknown'.");
        }
    }
    console.log(`SLAEscrow (impl)  -> ${escrowImpl}`);

    // -- TimelockController ----------------------------------------------------
    // minDelay: 48h on mainnet. Override with TIMELOCK_DELAY env var (seconds).
    // Deployer is initial proposer/admin -- replace with Safe multisig before mainnet.
    const timelockDelay = parseInt(process.env.TIMELOCK_DELAY ?? (48 * 3600).toString(), 10);
    const TimelockFactory = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockFactory.deploy(
        timelockDelay,
        [deployer.address],       // proposers (replace with multisig before mainnet)
        [ethers.ZeroAddress],     // executors: anyone can execute after delay
        deployer.address,         // admin: can add multisig as proposer, then renounce
        gasOverride,
    );
    await timelock.waitForDeployment();
    const timelockAddr = await timelock.getAddress();
    console.log(`TimelockController -> ${timelockAddr} (delay: ${timelockDelay}s)`);

    // Wait for all pending transactions to confirm before transferOwnership.
    // Add an extra 6s buffer after confirmation: Base Sepolia's sequencer can
    // hold transactions in its internal queue briefly after they appear confirmed
    // in eth_getTransactionCount, causing "replacement transaction underpriced"
    // if we send immediately. The buffer lets the sequencer flush.
    for (let i = 0; i < 30; i++) {
        const confirmed = await ethers.provider.getTransactionCount(deployer.address, "latest");
        const pending   = await ethers.provider.getTransactionCount(deployer.address, "pending");
        if (pending === confirmed) break;
        console.log(`  waiting for ${pending - confirmed} pending tx(s) to confirm...`);
        await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, 6000)); // sequencer flush buffer

    // Use explicit nonces to bypass Hardhat's internal nonce cache, which can
    // drift on live L2 chains where the sequencer processes txs out-of-band.
    const baseNonce = await ethers.provider.getTransactionCount(deployer.address, "pending");

    // Transfer both contract ownerships to the timelock (T22: both must be timelock-governed)
    const tx1 = await (escrow as any).transferOwnership(timelockAddr, { nonce: baseNonce, ...gasOverride });
    await tx1.wait();
    console.log(`SLAEscrow ownership -> ${timelockAddr}`);
    const tx2 = await (registry as any).transferOwnership(timelockAddr, { nonce: baseNonce + 1, ...gasOverride });
    await tx2.wait();
    console.log(`QuoteRegistry ownership -> ${timelockAddr}`);

    // Post-deploy assertion -- retry a few times to allow RPC state to settle
    let escrowOwner = "", registryOwner = "";
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        escrowOwner   = await (escrow as any).owner();
        registryOwner = await (registry as any).owner();
        if (escrowOwner === timelockAddr && registryOwner === timelockAddr) break;
    }
    if (escrowOwner !== timelockAddr || registryOwner !== timelockAddr) {
        throw new Error(`Ownership transfer failed: escrow=${escrowOwner} registry=${registryOwner}`);
    }
    console.log(`v Both contracts owned by timelock`);

    // -- Write addresses -------------------------------------------------------
    const deploymentsDir = path.join(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const record = {
        chainId:            chainId.toString(),
        network:            network.name,
        registry:           registryAddr,
        escrow:             escrowAddr,
        escrowImpl:         escrowImpl,
        timelock:           timelockAddr,
        timelockDelay:      timelockDelay,
        feeRecipient:       feeRecipient,
        entryPoint:         ENTRY_POINT,
        deployedAt:         new Date().toISOString(),
        deployedAtBlock:    deployedAtBlock,
        deployer:           deployer.address,
    };

    const outFile = path.join(deploymentsDir, `${chainId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log(`\nAddresses written -> deployments/${chainId}.json`);

    if (isLive) {
        console.log("\nNext step -- verify on Sourcify:");
        console.log(`  npm run verify -- --network ${network.name}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
