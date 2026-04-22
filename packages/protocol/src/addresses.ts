export interface Deployment {
  registry: string;
  escrow: string;
  escrowImpl: string;
  timelock: string;
  feeRecipient: string;
  deployedAtBlock?: number;
}

/** Known deployments keyed by chainId. Mainnet (8453) not yet deployed. */
export const DEPLOYMENTS: Record<number, Deployment> = {
  /** Base Sepolia -- testnet deployment (2026-04-21, 4-wallet layout) */
  84532: {
    registry:        "0x8D15232a45903602411EF1494a10201Ad3d4EA47",
    escrow:          "0x508eB40826ce7042dB14242f278Bb4a9AbB0D82A",
    escrowImpl:      "0xe3a465972E8ab8f258d1718F48e2933d0B2117A5",
    timelock:        "0xd9Fa5FeA0B26ecA0e3B19a0A5FDaec8BaB76A4Ba",
    feeRecipient:    "0x2dcc542ed1208Ba04436942B5F35Cb5E71535c68",
    deployedAtBlock: 40481820,
  },
};
