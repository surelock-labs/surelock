import { AbiCoder, keccak256 } from "ethers";

export const ENTRY_POINT_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

// v0.6 UserOperation. Signature is omitted -- not part of userOpHash.
export interface UserOperation {
  sender:                string;
  nonce:                 bigint | number;
  initCode:              string;
  callData:              string;
  callGasLimit:          bigint | number;
  verificationGasLimit:  bigint | number;
  preVerificationGas:    bigint | number;
  maxFeePerGas:          bigint | number;
  maxPriorityFeePerGas:  bigint | number;
  paymasterAndData:      string;
}

// v0.6 only -- v0.7 packs gas fields differently and uses a different hash.
export function computeUserOpHash(
  op: UserOperation,
  entryPoint: string,
  chainId: bigint | number,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  const inner = keccak256(coder.encode(
    ["address","uint256","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","bytes32"],
    [
      op.sender, op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.callGasLimit, op.verificationGasLimit, op.preVerificationGas,
      op.maxFeePerGas, op.maxPriorityFeePerGas,
      keccak256(op.paymasterAndData),
    ],
  ));
  return keccak256(coder.encode(["bytes32","address","uint256"], [inner, entryPoint, chainId]));
}
