/**
 * Integration test for SLAEscrow.settle() A10 inclusion proof.
 *
 * Tests the full end-to-end proof verification pipeline:
 *   1. Deploy MockEntryPoint + SLAEscrow wired to it
 *   2. Register offer, deposit collateral, commit a UserOp
 *   3. Call MockEntryPoint.handleOp(userOpHash) -- mines a real block with a real receipt
 *   4. Build the RLP block header and MPT receipt proof from Hardhat JSON-RPC data
 *   5. Call settle() -- must pass all 4 verification steps in _verifyReceiptProof
 *
 * If this test passes, the on-chain MPT proof verifier is confirmed correct against
 * a real Hardhat block (Prague hardfork headers, EIP-1559 type-2 receipts).
 */

import { ethers } from "hardhat";
import { expect } from "chai";
import { buildBlockHeaderRlp, buildReceiptProof } from "./helpers/buildSettleProof";

const ONE_GWEI   = ethers.parseUnits("1", "gwei");
const COLLATERAL = ethers.parseEther("0.1");
const MIN_BOND   = ethers.parseEther("0.0001");

describe("SLAEscrow -- settle (A10 inclusion proof)", () => {
    let owner: any, bundler: any, user: any;
    let mockEP: any;
    let registry: any, escrow: any;

    beforeEach(async () => {
        [owner, bundler, user] = await ethers.getSigners();

        // Deploy MockEntryPoint
        const EPFactory = await ethers.getContractFactory("MockEntryPoint");
        mockEP = await EPFactory.deploy();
        const epAddr = await mockEP.getAddress();

        // Deploy QuoteRegistry
        const RegFactory = await ethers.getContractFactory("QuoteRegistry");
        registry = await RegFactory.deploy(owner.address, MIN_BOND);

        // Deploy SLAEscrow (implementation + proxy) wired to MockEntryPoint
        const EscrowFactory = await ethers.getContractFactory("SLAEscrow");
        const { upgrades } = await import("hardhat");
        escrow = await upgrades.deployProxy(
            EscrowFactory,
            [await registry.getAddress(), owner.address],
            { kind: "uups", constructorArgs: [epAddr] },
        );
    });

    it("settles with a real MPT receipt proof (A10)", async () => {
        // -- 1. Register offer and deposit collateral ------------------------
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        // -- 2. User commits -------------------------------------------------
        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("test-op-a10"));
        await escrow.connect(user).commit(
            qid, ethers.keccak256(ethers.toUtf8Bytes("test-op-a10")), bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        // -- 3. Bundler calls MockEntryPoint.handleOp -- mines a real block --
        const tx = await mockEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;
        const txHash: string = receipt.hash;

        // -- 4. Build block header RLP + MPT receipt proof ------------------
        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            txHash,
        );

        // -- 5. settle ------------------------------------------------------
        await expect(
            escrow.connect(bundler).settle(
                commitId,
                inclusionBlock,
                blockHeaderRlp,
                proofNodes,
                txIndex,
            ),
        ).to.emit(escrow, "Settled").withArgs(commitId, ONE_GWEI);

        // Commit should be finalized
        const commit = await escrow.getCommit(commitId);
        expect(commit.settled).to.be.true;
    });

    it("reverts with wrong userOpHash in proof", async () => {
        // Register + deposit + commit with a different hash than what we emit
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("real-op"));
        const wrongHash  = ethers.keccak256(ethers.toUtf8Bytes("fake-op"));

        // Commit with the real hash
        await escrow.connect(user).commit(
            qid, ethers.keccak256(ethers.toUtf8Bytes("real-op")), bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        await escrow.connect(bundler).accept(0n);

        // Emit the wrong hash on-chain
        const tx = await mockEP.connect(bundler).handleOp(wrongHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;

        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            receipt.hash,
        );

        await expect(
            escrow.connect(bundler).settle(
                0n, inclusionBlock, blockHeaderRlp, proofNodes, txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInclusionProof");
    });

    it("reverts BlockHashUnavailable when inclusionBlock is > 256 blocks ago (MPT reliability)", async () => {
        // Use slaBlocks=300 so the settlement window (deadline+10 blocks) stays open
        // after we mine 258 extra blocks to age out the inclusionBlock.
        //
        // Timeline (all block numbers relative to accept block B):
        //   B      -- accept()
        //   B+1    -- handleOp() mined -> inclusionBlock
        //   B+259  -- after hardhat_mine(258) -> inclusionBlock is 258 blocks old (> 256)
        //   deadline        = B + 300
        //   deadline + SETTLEMENT_GRACE = B + 310
        //   B+259 <= B+310  v  still within settle window
        //   blockhash(B+1)  = 0  (> 256 blocks ago)  -> BlockHashUnavailable
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("stale-block-mpt-op"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 300,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        // Bundler emits the UserOp event -- mines a real block
        const tx = await mockEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;
        const txHash: string = receipt.hash;

        // Build valid block header RLP + MPT proof BEFORE aging the block out
        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            txHash,
        );

        // Age out the inclusionBlock: mine 258 more blocks efficiently
        // (hardhat_mine skips timestamps/state -- does not fund any account)
        await ethers.provider.send("hardhat_mine", ["0x" + (258).toString(16)]);

        // Even with a perfectly valid proof, blockhash(inclusionBlock)==0 now
        await expect(
            escrow.connect(bundler).settle(
                commitId,
                inclusionBlock,
                blockHeaderRlp,
                proofNodes,
                txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "BlockHashUnavailable");
    });

    it("succeeds when inclusionBlock is exactly 256 blocks ago (blockhash boundary -- last valid block)", async () => {
        // EVM BLOCKHASH opcode: returns hash for blocks [block.number-256, block.number-1].
        // When settle() executes at block B+256, blockhash(B) is still available.
        // This test confirms the boundary is inclusive on the valid side.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("boundary-256-ok"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 300,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        const tx = await mockEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;
        const txHash: string = receipt.hash;

        // Build proof BEFORE aging the block
        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            txHash,
        );

        // Mine 255 more blocks so that settle() executes at inclusionBlock+256
        // (gap = 256 -- still within the 256-block BLOCKHASH window)
        await ethers.provider.send("hardhat_mine", ["0x" + (255).toString(16)]);

        await expect(
            escrow.connect(bundler).settle(
                commitId,
                inclusionBlock,
                blockHeaderRlp,
                proofNodes,
                txIndex,
            ),
        ).to.emit(escrow, "Settled").withArgs(commitId, ONE_GWEI);
    });

    it("reverts BlockHashUnavailable when inclusionBlock is exactly 257 blocks ago (blockhash boundary+1)", async () => {
        // When settle() executes at block B+257, blockhash(B) returns 0.
        // This test confirms the boundary is exclusive on the invalid side.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 300, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("boundary-257-fail"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 300,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        const tx = await mockEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;
        const txHash: string = receipt.hash;

        // Build proof BEFORE aging the block
        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            txHash,
        );

        // Mine 256 more blocks so that settle() executes at inclusionBlock+257
        // (gap = 257 -- one past the 256-block BLOCKHASH window -> returns 0)
        await ethers.provider.send("hardhat_mine", ["0x" + (256).toString(16)]);

        await expect(
            escrow.connect(bundler).settle(
                commitId,
                inclusionBlock,
                blockHeaderRlp,
                proofNodes,
                txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "BlockHashUnavailable");
    });

    it("reverts InvalidInclusionProof when UserOperationEvent.success=false (A1)", async () => {
        // A bundler includes a UserOp whose callData reverts. ERC-4337 handleOps()
        // does NOT revert -- it emits UserOperationEvent{success:false} and charges gas.
        // SLAEscrow must reject settle() for such a proof.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("failed-op-a1"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        // Emit success=false -- simulates a reverted UserOp execution
        const tx = await mockEP.connect(bundler).handleFailedOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;

        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            receipt.hash,
        );

        // Must reject -- bundler cannot earn fee for a reverted op
        await expect(
            escrow.connect(bundler).settle(
                commitId, inclusionBlock, blockHeaderRlp, proofNodes, txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInclusionProof");
    });

    it("reverts with tampered block header", async () => {
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("tamper-op"));
        await escrow.connect(user).commit(
            qid, ethers.keccak256(ethers.toUtf8Bytes("tamper-op")), bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        await escrow.connect(bundler).accept(0n);

        const tx = await mockEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;

        const provider = ethers.provider;
        let blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            receipt.hash,
        );

        // Flip one byte in the header
        const bytes = Array.from(ethers.getBytes(blockHeaderRlp));
        bytes[10] ^= 0xff;
        blockHeaderRlp = ethers.hexlify(new Uint8Array(bytes));

        await expect(
            escrow.connect(bundler).settle(
                0n, inclusionBlock, blockHeaderRlp, proofNodes, txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInclusionProof");
    });

    it("reverts InclusionBeforeAccept when inclusionBlock is before accept block (Finding 4)", async () => {
        // A10: bundler earns fee only for inclusion within the SLA window (after accept).
        // settle() now enforces inclusionBlock >= acceptBlock = deadline - slaBlocks.
        // Attack path closed: a bundler cannot claim payment for a UserOp included
        // before the SLA agreement was established.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("finding4-pre-accept"));

        // Step 1: UserOp included on-chain BEFORE the SLA commit exists (block B)
        const includeTx = await mockEP.connect(bundler).handleOp(userOpHash);
        const includeReceipt = await includeTx.wait();
        const inclusionBlock: number = includeReceipt.blockNumber;

        // Build valid MPT proof while block is fresh
        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            includeReceipt.hash,
        );

        // Step 2: user commits (block B+1), bundler accepts (block B+2)
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        const acceptTx = await escrow.connect(bundler).accept(commitId);
        const acceptReceipt = await acceptTx.wait();
        const acceptBlock: number = acceptReceipt.blockNumber;

        expect(inclusionBlock).to.be.lessThan(acceptBlock,
            "test setup: inclusionBlock must be before acceptBlock");

        // Step 3: settle with pre-accept inclusionBlock must revert
        await expect(
            escrow.connect(bundler).settle(
                commitId,
                inclusionBlock,
                blockHeaderRlp,
                proofNodes,
                txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "InclusionBeforeAccept");
    });

    it("settle() by third party: payout still credits snapshotted bundler, not caller", async () => {
        // settle() is permissionless (A9) -- any address may submit the proof.
        // Fee always flows to the snapshotted bundler regardless of caller.
        const [,,,thirdParty] = await ethers.getSigners();
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("third-party-op"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        const tx = await mockEP.connect(thirdParty).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;

        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            receipt.hash,
        );

        await expect(
            escrow.connect(thirdParty).settle(
                commitId, inclusionBlock, blockHeaderRlp, proofNodes, txIndex,
            ),
        ).to.emit(escrow, "Settled").withArgs(commitId, ONE_GWEI);

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(thirdParty.address)).to.equal(0n);
    });

    it("reverts InvalidInclusionProof when UserOperationEvent is from wrong entryPoint", async () => {
        // Proof with a log emitted by an impostor contract (not the configured entryPoint).
        // The MPT proof is structurally valid but the log address does not match entryPoint.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("wrong-emitter-op"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        await escrow.connect(bundler).accept(commitId);

        // Deploy a second MockEntryPoint (the impostor -- address differs from configured entryPoint)
        const EPFactory = await ethers.getContractFactory("MockEntryPoint");
        const impostorEP = await EPFactory.deploy();

        // Emit the correct userOpHash from the impostor, not the configured entryPoint
        const tx = await impostorEP.connect(bundler).handleOp(userOpHash);
        const receipt = await tx.wait();
        const inclusionBlock: number = receipt.blockNumber;

        const provider = ethers.provider;
        const blockHeaderRlp = await buildBlockHeaderRlp(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
        );
        const { proofNodes, txIndex } = await buildReceiptProof(
            { send: (m: string, p: unknown[]) => provider.send(m, p) },
            inclusionBlock,
            receipt.hash,
        );

        await expect(
            escrow.connect(bundler).settle(
                commitId, inclusionBlock, blockHeaderRlp, proofNodes, txIndex,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInclusionProof");
    });

    it("reverts BlockHashUnavailable when inclusionBlock == block.number (current block)", async () => {
        // blockhash(block.number) is always 0 in EVM -- the current block's hash is
        // not yet sealed at execution time. This differs from the > 256-blocks-old case.
        const qid = await registry.connect(bundler).register.staticCall(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await registry.connect(bundler).register(
            ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND },
        );
        await escrow.connect(bundler).deposit({ value: COLLATERAL });

        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("current-block-op"));
        await escrow.connect(user).commit(
            qid, userOpHash, bundler.address, COLLATERAL, 10,
            { value: ONE_GWEI },
        );
        const commitId = 0n;
        const acceptTx = await escrow.connect(bundler).accept(commitId);
        const acceptReceipt = await acceptTx.wait();
        const acceptBlock: number = acceptReceipt!.blockNumber;

        // With Hardhat automining, the settle tx is the next tx and mines block acceptBlock+1.
        // Passing inclusionBlock = acceptBlock+1 means block.number == inclusionBlock when
        // settle() executes, so blockhash(inclusionBlock) == 0 -> BlockHashUnavailable.
        // The check fires before _verifyReceiptProof, so dummy proof args are fine.
        const currentBlock = acceptBlock + 1;
        await expect(
            escrow.connect(bundler).settle(
                commitId,
                currentBlock,
                "0x",
                [],
                0,
            ),
        ).to.be.revertedWithCustomError(escrow, "BlockHashUnavailable");
    });
});
