import { HardhatUserConfig, task, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import * as path from "path";
import { sync as globSync } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
dotenv.config();

// Production contracts live in contracts/ (paths.sources).
// Test-helper contracts (contracts/test/) are added here so Hardhat compiles both.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, hre, runSuper) => {
  const base: string[] = await runSuper();
  const helpers = [
    ...globSync(path.join(hre.config.paths.root, "playground/contracts/**/*.sol")),
    ...globSync(path.join(hre.config.paths.root, "test/contracts/**/*.sol")),
  ];
  return [...base, ...helpers];
});

task("play", "Start a playground REPL with w pre-initialized").setAction(async () => {
  const repl = await import("repl")
  const { init } = await import("./playground")
  console.log("Initializing playground...")
  const w = await init()
  console.log("Ready -- use `w` to interact with the contracts.")
  const r = repl.start({ prompt: "play> ", useGlobal: false })
  r.context.w = w
  await new Promise<void>(resolve => r.on("exit", resolve))
})

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  paths: {
    sources: "contracts",
  },
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true },
  },
  networks: {
    hardhat: {
      // Large initial balances so multi-file test runs don't deplete accounts
      // (1,000,000 ETH per account; Hardhat default is 10,000 ETH)
      accounts: {
        count: 20,
        accountsBalance: "1000000000000000000000000",
      },
    },
    localhost: {
      url: process.env["HARDHAT_LOCALHOST_URL"] ?? "http://127.0.0.1:8545",
      ...(accounts.length ? { accounts } : {}),
    },
    baseSepolia: {
      url: process.env.RPC_URL ?? "",
      accounts,
      chainId: 84532,
    },
    baseMainnet: {
      url: process.env.RPC_URL_MAINNET ?? "",
      accounts,
      chainId: 8453,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
