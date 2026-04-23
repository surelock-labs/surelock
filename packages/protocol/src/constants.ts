import { ethers } from "ethers";
import { REGISTRY_ABI, ESCROW_ABI } from "./abis";
import { aggregate3 } from "./multicall";

export interface EscrowConstants {
  version:               string;
  entryPoint:            string;
  acceptGraceBlocks:     bigint;
  settlementGraceBlocks: bigint;
  refundGraceBlocks:     bigint;
  maxSlaBlocks:          number;
  maxProtocolFeeWei:     bigint;
  protocolFeeWei:        bigint;
  feeRecipient:          string;
}

export interface RegistryConstants {
  minBond:          bigint;
  maxBond:          bigint;
  maxSlaBlocks:     number;
  registrationBond: bigint;
}

// multicall defaults to true; pass false on chains without Multicall3 deployed at 0xcA11bde0...
export interface ReadOptions { multicall?: boolean; }

export async function readEscrowConstants(
  provider: ethers.Provider,
  escrowAddress: string,
  opts: ReadOptions = {},
): Promise<EscrowConstants> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const abi = ethers.AbiCoder.defaultAbiCoder();

  if (opts.multicall !== false) {
    const fns: Array<[string, string]> = [
      ["version",              "string"],
      ["entryPoint",           "address"],
      ["ACCEPT_GRACE_BLOCKS",  "uint64"],
      ["SETTLEMENT_GRACE_BLOCKS","uint64"],
      ["REFUND_GRACE_BLOCKS",  "uint64"],
      ["MAX_SLA_BLOCKS",       "uint32"],
      ["MAX_PROTOCOL_FEE_WEI", "uint256"],
      ["protocolFeeWei",       "uint256"],
      ["feeRecipient",         "address"],
    ];
    const results = await aggregate3(provider,
      fns.map(([fn]) => ({ target: escrowAddress, callData: escrow.interface.encodeFunctionData(fn, []) })));
    const [
      version, entryPoint, acceptGraceBlocks, settlementGraceBlocks, refundGraceBlocks,
      maxSlaBlocks, maxProtocolFeeWei, protocolFeeWei, feeRecipient,
    ] = results.map((data, i) => abi.decode([fns[i][1]], data)[0]);
    return {
      version,
      entryPoint,
      acceptGraceBlocks:     BigInt(acceptGraceBlocks),
      settlementGraceBlocks: BigInt(settlementGraceBlocks),
      refundGraceBlocks:     BigInt(refundGraceBlocks),
      maxSlaBlocks:          Number(maxSlaBlocks),
      maxProtocolFeeWei:     BigInt(maxProtocolFeeWei),
      protocolFeeWei:        BigInt(protocolFeeWei),
      feeRecipient,
    };
  }

  const [
    version, entryPoint, acceptGraceBlocks, settlementGraceBlocks, refundGraceBlocks,
    maxSlaBlocks, maxProtocolFeeWei, protocolFeeWei, feeRecipient,
  ] = await Promise.all([
    escrow.version() as Promise<string>,
    escrow.entryPoint() as Promise<string>,
    escrow.ACCEPT_GRACE_BLOCKS() as Promise<bigint>,
    escrow.SETTLEMENT_GRACE_BLOCKS() as Promise<bigint>,
    escrow.REFUND_GRACE_BLOCKS() as Promise<bigint>,
    escrow.MAX_SLA_BLOCKS() as Promise<bigint>,
    escrow.MAX_PROTOCOL_FEE_WEI() as Promise<bigint>,
    escrow.protocolFeeWei() as Promise<bigint>,
    escrow.feeRecipient() as Promise<string>,
  ]);
  return {
    version,
    entryPoint,
    acceptGraceBlocks:     BigInt(acceptGraceBlocks),
    settlementGraceBlocks: BigInt(settlementGraceBlocks),
    refundGraceBlocks:     BigInt(refundGraceBlocks),
    maxSlaBlocks:          Number(maxSlaBlocks),
    maxProtocolFeeWei:     BigInt(maxProtocolFeeWei),
    protocolFeeWei:        BigInt(protocolFeeWei),
    feeRecipient,
  };
}

export async function readRegistryConstants(
  provider: ethers.Provider,
  registryAddress: string,
  opts: ReadOptions = {},
): Promise<RegistryConstants> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  const abi = ethers.AbiCoder.defaultAbiCoder();

  if (opts.multicall !== false) {
    const fns: Array<[string, string]> = [
      ["MIN_BOND",         "uint256"],
      ["MAX_BOND",         "uint256"],
      ["MAX_SLA_BLOCKS",   "uint32"],
      ["registrationBond", "uint256"],
    ];
    const results = await aggregate3(provider,
      fns.map(([fn]) => ({ target: registryAddress, callData: registry.interface.encodeFunctionData(fn, []) })));
    const [minBond, maxBond, maxSlaBlocks, registrationBond] = results.map((d, i) => abi.decode([fns[i][1]], d)[0]);
    return {
      minBond:          BigInt(minBond),
      maxBond:          BigInt(maxBond),
      maxSlaBlocks:     Number(maxSlaBlocks),
      registrationBond: BigInt(registrationBond),
    };
  }

  const [minBond, maxBond, maxSlaBlocks, registrationBond] = await Promise.all([
    registry.MIN_BOND() as Promise<bigint>,
    registry.MAX_BOND() as Promise<bigint>,
    registry.MAX_SLA_BLOCKS() as Promise<bigint>,
    registry.registrationBond() as Promise<bigint>,
  ]);
  return {
    minBond:          BigInt(minBond),
    maxBond:          BigInt(maxBond),
    maxSlaBlocks:     Number(maxSlaBlocks),
    registrationBond: BigInt(registrationBond),
  };
}
