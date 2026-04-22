// Unit tests for @surelock-labs/bundler proof helpers.
// No blockchain required -- uses a mock RpcProvider.

import { expect } from "chai";
import {
  buildBlockHeaderRlp,
  buildReceiptProof,
  withRetry,
  findUserOpLogIndex,
} from "../packages/bundler/src/proof";

// -- mock RpcProvider -----------------------------------------------------------

function makeRpc(handler: (method: string, params: unknown[]) => any) {
  return { send: (method: string, params: unknown[]) => Promise.resolve(handler(method, params)) };
}

// -- buildBlockHeaderRlp -------------------------------------------------------

describe("buildBlockHeaderRlp", () => {
  it("throws 'header not found' when block is null", async () => {
    const rpc = makeRpc(() => null);
    await expect(buildBlockHeaderRlp(rpc, 42)).to.be.rejectedWith(/header not found for block 42/);
  });

  it("throws 'header not found' when block is undefined", async () => {
    const rpc = makeRpc(() => undefined);
    await expect(buildBlockHeaderRlp(rpc, 99)).to.be.rejectedWith(/header not found for block 99/);
  });
});

// -- buildReceiptProof ---------------------------------------------------------

describe("buildReceiptProof", () => {
  it("throws retryable 'header not found' message when block is null", async () => {
    const rpc = makeRpc(() => null);
    await expect(buildReceiptProof(rpc, 100, "0xdeadbeef")).to.be.rejectedWith(
      /header not found: block 100 not yet available/,
    );
  });

  it("error message matches withRetry's isHeaderNotFound pattern", async () => {
    const rpc = makeRpc(() => null);
    let caught: Error | undefined;
    try {
      await buildReceiptProof(rpc, 7, "0x1234");
    } catch (e: any) {
      caught = e;
    }
    expect(caught).to.exist;
    // withRetry recognises this error and retries -- confirm the message contains the key phrase
    expect(caught!.message).to.match(/header not found/i);
  });

  it("throws when block has no transactions", async () => {
    const rpc = makeRpc(() => ({ transactions: [], receiptsRoot: "0x" + "ab".repeat(32) }));
    await expect(buildReceiptProof(rpc, 5, "0xabc")).to.be.rejectedWith(/no transactions/);
  });

  it("throws when txHash is not in the block", async () => {
    const rpc = makeRpc((method) => {
      if (method === "eth_getBlockByNumber")
        return { transactions: [{ hash: "0x111" }], receiptsRoot: "0x" + "aa".repeat(32) };
      return null;
    });
    await expect(buildReceiptProof(rpc, 5, "0xnothere")).to.be.rejectedWith(/not found in block/);
  });
});

// -- withRetry -----------------------------------------------------------------

describe("withRetry", () => {
  it("resolves immediately when fn succeeds on first try", async () => {
    const result = await withRetry(() => Promise.resolve(42), 3, 0);
    expect(result).to.equal(42);
  });

  it("retries on 'header not found' and succeeds on nth attempt", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error("header not found: block 10 not yet available");
      return Promise.resolve("ok");
    };
    const result = await withRetry(fn, 5, 0);
    expect(result).to.equal("ok");
    expect(calls).to.equal(3);
  });

  it("propagates non-retryable errors immediately without retrying", async () => {
    let calls = 0;
    const fn = () => { calls++; throw new Error("execution reverted"); };
    await expect(withRetry(fn, 5, 0)).to.be.rejectedWith(/execution reverted/);
    expect(calls).to.equal(1);
  });

  it("throws after exhausting all retries", async () => {
    let calls = 0;
    const fn = () => { calls++; throw new Error("header not found: lagging node"); };
    await expect(withRetry(fn, 3, 0)).to.be.rejectedWith(/header not found/);
    expect(calls).to.equal(4); // initial + 3 retries
  });

  it("retries when error is nested in ethers RPC wrapper", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) {
        const e: any = new Error("outer");
        e.info = { error: { message: "header not found in lagging replica" } };
        throw e;
      }
      return Promise.resolve("nested-ok");
    };
    const result = await withRetry(fn, 3, 0);
    expect(result).to.equal("nested-ok");
    expect(calls).to.equal(2);
  });
});

// -- findUserOpLogIndex --------------------------------------------------------

describe("findUserOpLogIndex", () => {
  const TOPIC0 = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
  const HASH   = "0xaaaa000000000000000000000000000000000000000000000000000000000000";

  it("returns null for empty log array", () => {
    expect(findUserOpLogIndex([], HASH)).to.be.null;
  });

  it("finds matching log at correct index", () => {
    const logs = [
      { topics: ["0x0001", "0x0002"] },
      { topics: [TOPIC0, HASH] },
      { topics: [TOPIC0, "0xother"] },
    ];
    expect(findUserOpLogIndex(logs, HASH)).to.equal(1);
  });

  it("returns null when hash is present but topic0 does not match", () => {
    const logs = [{ topics: ["0xwrong", HASH] }];
    expect(findUserOpLogIndex(logs, HASH)).to.be.null;
  });

  it("is case-insensitive on both topic0 and userOpHash", () => {
    const logs = [{ topics: [TOPIC0.toUpperCase(), HASH.toUpperCase()] }];
    expect(findUserOpLogIndex(logs, HASH.toLowerCase())).to.equal(0);
  });
});
