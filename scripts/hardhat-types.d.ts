// Ambient declaration -- the hardhat module re-exports ethers and upgrades
// at runtime via @nomicfoundation/hardhat-ethers + @openzeppelin/hardhat-upgrades.
// Those plugins normally augment the "hardhat" module type, but the
// augmentation requires pulling hardhat.config.ts into the tsconfig include,
// which transitively drags in typechain-types and breaks typechecking.
// Declaring the surface we actually use keeps tsc clean without that pull-in.
declare module "hardhat" {
  import type * as ethersNs from "ethers";
  // hardhat-ethers returns `HardhatEthersSigner` which is `ethers.Signer & { address: string }`.
  type HHSigner = ethersNs.Signer & { address: string; provider: ethersNs.Provider };
  export const ethers: typeof ethersNs & {
    provider: ethersNs.JsonRpcProvider;
    getSigners: () => Promise<HHSigner[]>;
    getContractAt: (name: string, address: string, signer?: ethersNs.Signer) => Promise<ethersNs.Contract>;
    getContractFactory: (name: string, signer?: ethersNs.Signer) => Promise<ethersNs.ContractFactory>;
  };
  export const upgrades: {
    deployProxy: (factory: ethersNs.ContractFactory, args: unknown[], opts?: Record<string, unknown>) => Promise<ethersNs.Contract>;
    upgradeProxy: (proxy: string | ethersNs.Contract, factory: ethersNs.ContractFactory) => Promise<ethersNs.Contract>;
    erc1967: {
      getImplementationAddress: (proxy: string) => Promise<string>;
      getAdminAddress: (proxy: string) => Promise<string>;
    };
  };
  export const network: {
    name: string;
    config: Record<string, unknown>;
  };
  export const run: (task: string, args?: Record<string, unknown>) => Promise<unknown>;
}
