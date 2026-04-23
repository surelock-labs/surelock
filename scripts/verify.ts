/// Sourcify verification (bytecode match, no API key). Reads deployments/{chainId}.json.
/// Usage: npm run verify -- --network baseSepolia
///
/// Basescan is a separate path -- run hardhat verify:etherscan per contract with
/// BASESCAN_API_KEY and the contract's constructor args. Registry takes
/// (owner, initialBond); SLAEscrow impl takes (entryPoint); Timelock takes
/// (minDelay, proposers, executors, admin); SLAEscrow proxy has no args.

import { run, network, ethers } from "hardhat";
import { loadDeployment } from "./deployment";

async function main() {
    const { chainId } = await ethers.provider.getNetwork();
    const deployment = loadDeployment(chainId);
    console.log(`Verifying deployment on ${deployment.network} (chainId ${chainId})`);
    console.log(`  QuoteRegistry : ${deployment.registry}`);
    console.log(`  SLAEscrow     : ${deployment.escrow}`);
    console.log(`  SLAEscrow impl: ${deployment.escrowImpl}`);
    if (deployment.timelock) console.log(`  Timelock      : ${deployment.timelock}`);
    console.log();

    const base = network.name === "baseMainnet"
        ? "https://basescan.org"
        : "https://sepolia.basescan.org";

    // QuoteRegistry has no constructor args
    console.log("Verifying QuoteRegistry...");
    await run("verify:sourcify", { address: deployment.registry });
    console.log("v QuoteRegistry verified");

    // SLAEscrow proxy (no constructor args -- proxy is minimal)
    console.log("Verifying SLAEscrow proxy...");
    await run("verify:sourcify", { address: deployment.escrow });
    console.log("v SLAEscrow proxy verified");

    // SLAEscrow implementation (constructor arg: entryPoint address)
    if (deployment.escrowImpl) {
        console.log("Verifying SLAEscrow implementation...");
        await run("verify:sourcify", { address: deployment.escrowImpl });
        console.log("v SLAEscrow implementation verified");
    }

    // TimelockController
    if (deployment.timelock) {
        console.log("Verifying TimelockController...");
        await run("verify:sourcify", { address: deployment.timelock });
        console.log("v TimelockController verified");
    }

    console.log(`\nView on Basescan (read-only -- separate from Sourcify verification):`);
    console.log(`  ${base}/address/${deployment.registry}`);
    console.log(`  ${base}/address/${deployment.escrow}`);
    if (deployment.escrowImpl) console.log(`  ${base}/address/${deployment.escrowImpl}`);
    if (deployment.timelock)   console.log(`  ${base}/address/${deployment.timelock}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
