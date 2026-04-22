import { ethers } from "ethers";
import { REGISTRY_ABI, ESCROW_ABI } from "@surelock-labs/protocol";

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

export async function readEscrowConstants(
  provider: ethers.Provider,
  escrowAddress: string,
): Promise<EscrowConstants> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
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
): Promise<RegistryConstants> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
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
