import { ethers } from "ethers";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];

export interface Call3 {
  target:        string;
  allowFailure?: boolean;
  callData:      string;
}

export async function aggregate3(
  provider: ethers.Provider,
  calls: Call3[],
): Promise<string[]> {
  if (calls.length === 0) return [];
  const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const results = await mc.aggregate3.staticCall(
    calls.map(c => ({ target: c.target, allowFailure: c.allowFailure ?? false, callData: c.callData })),
  ) as Array<{ success: boolean; returnData: string }>;
  return results.map((r, i) => {
    if (!r.success) throw new Error(`aggregate3 sub-call ${i} reverted (target=${calls[i].target})`);
    return r.returnData;
  });
}
