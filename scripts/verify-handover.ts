import { ethers } from "hardhat";
import { loadDeployment } from "./deployment";

const PROPOSER_ROLE      = ethers.id("PROPOSER_ROLE");
const EXECUTOR_ROLE      = ethers.id("EXECUTOR_ROLE");
const CANCELLER_ROLE     = ethers.id("CANCELLER_ROLE");
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

async function main() {
    const multisig = process.env["MULTISIG"];
    const deployer = process.env["DEPLOYER"];
    if (!multisig) throw new Error("MULTISIG env var required (the Safe that should hold PROPOSER_ROLE)");
    if (!deployer) throw new Error("DEPLOYER env var required (the EOA that should have renounced)");
    if (multisig.toLowerCase() === deployer.toLowerCase()) {
        throw new Error("MULTISIG and DEPLOYER must be distinct: they are the take-over Safe and the renouncing EOA, respectively");
    }

    const { chainId } = await ethers.provider.getNetwork();
    const dep = loadDeployment(chainId);
    const registry = await ethers.getContractAt("QuoteRegistry", dep.registry);
    const escrow   = await ethers.getContractAt("SLAEscrow",     dep.escrow);
    const timelock = await ethers.getContractAt("TimelockController", dep.timelock);

    console.log(`\nHandover audit  (chainId ${chainId})`);
    console.log(`  QuoteRegistry : ${dep.registry}`);
    console.log(`  SLAEscrow     : ${dep.escrow}`);
    console.log(`  Timelock      : ${dep.timelock}`);
    console.log(`  Multisig (exp): ${multisig}`);
    console.log(`  Deployer (exp): ${deployer}\n`);

    const checks: Array<[string, boolean, string]> = [];
    const regOwner = (await registry.owner() as string).toLowerCase();
    checks.push(["QuoteRegistry.owner() == timelock",
        regOwner === dep.timelock.toLowerCase(),
        `got ${regOwner}`]);
    const escOwner = (await escrow.owner() as string).toLowerCase();
    checks.push(["SLAEscrow.owner() == timelock",
        escOwner === dep.timelock.toLowerCase(),
        `got ${escOwner}`]);

    const multiHasProp = await timelock.hasRole(PROPOSER_ROLE, multisig) as boolean;
    checks.push(["multisig has PROPOSER_ROLE", multiHasProp, ""]);
    const multiHasCanceller = await timelock.hasRole(CANCELLER_ROLE, multisig) as boolean;
    checks.push(["multisig has CANCELLER_ROLE", multiHasCanceller, ""]);
    const depHasProp = await timelock.hasRole(PROPOSER_ROLE, deployer) as boolean;
    checks.push(["deployer does NOT have PROPOSER_ROLE", !depHasProp, ""]);
    const depHasAdmin = await timelock.hasRole(DEFAULT_ADMIN_ROLE, deployer) as boolean;
    checks.push(["deployer does NOT have DEFAULT_ADMIN_ROLE", !depHasAdmin, ""]);
    const depHasCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer) as boolean;
    checks.push(["deployer does NOT have CANCELLER_ROLE", !depHasCanceller, ""]);
    const anyoneExec = await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress) as boolean;
    checks.push(["zero-address has EXECUTOR_ROLE (anyone can execute)", anyoneExec, ""]);

    let failed = 0;
    for (const [name, ok, note] of checks) {
        console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${note ? " -- " + note : ""}`);
        if (!ok) failed++;
    }

    console.log("");
    if (failed > 0) {
        console.error(`==> ${failed} check(s) failed. Handover incomplete -- DO NOT ship to mainnet.`);
        process.exit(1);
    }
    console.log("==> Handover complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
