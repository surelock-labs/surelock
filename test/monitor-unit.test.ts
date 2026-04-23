import { expect } from "chai";
import { checkActiveCommit } from "../packages/bundler/src/monitor";
import type { CommitInfo } from "@surelock-labs/protocol";

function activeCommit(deadline: bigint): CommitInfo {
  return {
    commitId:         1n,
    user:             "0x" + "11".repeat(20),
    feePaid:          1_000_000_000n,
    bundler:          "0x" + "22".repeat(20),
    collateralLocked: 1_000_000_001n,
    deadline,
    settled:          false,
    refunded:         false,
    quoteId:          1n,
    userOpHash:       "0x" + "aa".repeat(32),
    inclusionBlock:   0n,
    accepted:         true,
    cancelled:        false,
    acceptDeadline:   0n,
    slaBlocks:        10,
  };
}

describe("checkActiveCommit REFUND_WINDOW_OPEN alert", () => {
  const REFUND_OPEN_BLOCK = (deadline: bigint): bigint => deadline + 15n + 1n;

  it("message describes slash semantics, never 'release'", () => {
    const commit = activeCommit(100n);
    const alerts = checkActiveCommit(commit, REFUND_OPEN_BLOCK(100n));
    const refundAlert = alerts.find(a => a.type === "REFUND_WINDOW_OPEN");
    expect(refundAlert).to.exist;
    expect(refundAlert!.message).to.match(/slash/i);
    expect(refundAlert!.message).to.not.match(/\brelease\b/i);
  });

  it("message mentions the user (collateral flows to the user, not the bundler)", () => {
    const commit = activeCommit(200n);
    const alerts = checkActiveCommit(commit, REFUND_OPEN_BLOCK(200n));
    const refundAlert = alerts.find(a => a.type === "REFUND_WINDOW_OPEN")!;
    expect(refundAlert.message).to.match(/to the user/i);
  });

  it("no REFUND_WINDOW_OPEN alert before the refund window opens", () => {
    const commit = activeCommit(500n);
    const alerts = checkActiveCommit(commit, 500n + 10n);
    const refundAlert = alerts.find(a => a.type === "REFUND_WINDOW_OPEN");
    expect(refundAlert).to.be.undefined;
  });
});
