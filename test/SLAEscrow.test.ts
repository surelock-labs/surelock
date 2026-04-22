import { expect }    from "chai";
import { ethers, upgrades } from "hardhat";
import { mine }       from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow } from "../typechain-types";
import {
  deployEscrow,
  ONE_GWEI,
  COLLATERAL,
  SLA_BLOCKS,
  MIN_BOND,
  assertSettled,
  assertRefunded,
  bundlerNet,
  userRefundAmount,
  mineToRefundable,
  assertBalanceInvariant,
} from "./helpers/fixtures";

// -- local constants -----------------------------------------------------------
const ONE_ETH      = ethers.parseEther("1");

// -- local helpers -------------------------------------------------------------
async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
  return ethers.provider.getBalance(await escrow.getAddress());
}


// -- base fixture --------------------------------------------------------------
// This test file uses its own deploy() to preserve bundler1/bundler2/user1/user2
// names.  The underlying deployment goes through deployEscrow() so the
// initialize() arg list is centralised there.
async function deploy() {
  const [owner, bundler1, bundler2, user1, user2, feeRecipient, stranger] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = await Registry.deploy(owner.address, MIN_BOND);

  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = (await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" },
  )) as unknown as SLAEscrow;

  await registry.connect(bundler1).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: MIN_BOND });
  const QUOTE_ID = 1n;
  const OFFER    = await registry.getOffer(QUOTE_ID);

  return { escrow, registry, owner, bundler1, bundler2, user1, user2,
           feeRecipient, stranger, QUOTE_ID, OFFER };
}

// -----------------------------------------------------------------------------
describe("SLAEscrow", () => {

  // -- deploy ------------------------------------------------------------------
  describe("initialize", () => {
    it("reverts on zero registry address", async () => {
      const [,,,,,feeR] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SLAEscrowTestable");
      await expect(upgrades.deployProxy(F, [ethers.ZeroAddress, feeR.address], { kind: "uups" }))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });
    it("reverts on zero feeRecipient", async () => {
      const { registry } = await deploy();
      const F = await ethers.getContractFactory("SLAEscrowTestable");
      await expect(upgrades.deployProxy(F, [await registry.getAddress(), ethers.ZeroAddress], { kind: "uups" }))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  // -- setFeeRecipient ----------------------------------------------------------
  describe("setFeeRecipient", () => {
    it("reverts when caller is not the owner", async () => {
      const { escrow, stranger, bundler1 } = await deploy();
      await expect(escrow.connect(stranger).setFeeRecipient(bundler1.address))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
    it("reverts on zero address", async () => {
      const { escrow, owner } = await deploy();
      await expect(escrow.connect(owner).setFeeRecipient(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
    it("reverts when setting feeRecipient to address(this)", async () => {
      const { escrow, owner } = await deploy();
      const escrowAddress_ = await escrow.getAddress();
      await expect(escrow.connect(owner).setFeeRecipient(escrowAddress_))
        .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
    it("updates feeRecipient and emits FeeRecipientUpdated", async () => {
      const { escrow, owner, feeRecipient, stranger } = await deploy();
      await expect(escrow.connect(owner).setFeeRecipient(stranger.address))
        .to.emit(escrow, "FeeRecipientUpdated")
        .withArgs(feeRecipient.address, stranger.address);
      expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });
    it("feeRecipient rotation: old feeRecipient loses cancel rights after rotation", async () => {
      const { escrow, owner, bundler1, user1, feeRecipient, stranger, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });

      await escrow.connect(user1).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("rotate-op")),
        OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks,
        { value: OFFER.feePerOp },
      );

      // Mine past accept window so feeRecipient is authorized to cancel
      await mine(Number(await escrow.ACCEPT_GRACE_BLOCKS()) + 1);

      // Rotate: old=feeRecipient, new=stranger
      await escrow.connect(owner).setFeeRecipient(stranger.address);

      // Old feeRecipient can no longer cancel
      await expect(escrow.connect(feeRecipient).cancel(0n))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");

      // New feeRecipient (stranger) can cancel
      await expect(escrow.connect(stranger).cancel(0n)).to.not.be.reverted;
    });
  });

  // -- deposit ------------------------------------------------------------------
  describe("deposit", () => {
    it("reverts on zero value", async () => {
      const { escrow, bundler1 } = await deploy();
      await expect(escrow.connect(bundler1).deposit({ value: 0 }))
        .to.be.revertedWithCustomError(escrow, "ZeroDeposit");
    });
    it("records deposited balance and emits event", async () => {
      const { escrow, bundler1 } = await deploy();
      await expect(escrow.connect(bundler1).deposit({ value: ONE_ETH }))
        .to.emit(escrow, "Deposited").withArgs(bundler1.address, ONE_ETH);
      expect(await escrow.deposited(bundler1.address)).to.equal(ONE_ETH);
    });
    it("is additive across multiple calls", async () => {
      const { escrow, bundler1 } = await deploy();
      await escrow.connect(bundler1).deposit({ value: ONE_ETH });
      await escrow.connect(bundler1).deposit({ value: ONE_ETH });
      expect(await escrow.deposited(bundler1.address)).to.equal(ONE_ETH * 2n);
    });
  });

  // -- withdraw -----------------------------------------------------------------
  describe("withdraw", () => {
    it("reverts when requesting more than idle balance", async () => {
      const { escrow, bundler1 } = await deploy();
      await escrow.connect(bundler1).deposit({ value: ONE_ETH });
      await expect(escrow.connect(bundler1).withdraw(ONE_ETH + 1n))
        .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });
    it("succeeds for exactly the idle balance", async () => {
      const { escrow, bundler1 } = await deploy();
      await escrow.connect(bundler1).deposit({ value: ONE_ETH });
      await expect(escrow.connect(bundler1).withdraw(ONE_ETH))
        .to.emit(escrow, "Withdrawn").withArgs(bundler1.address, ONE_ETH);
      expect(await escrow.deposited(bundler1.address)).to.equal(0n);
    });
    it("cannot withdraw locked collateral", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      // Accept locks collateral -- withdraw must now revert
      await escrow.connect(bundler1).accept(0n);
      await expect(escrow.connect(bundler1).withdraw(COLLATERAL))
        .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });
    it("can withdraw only the unlocked portion when some is locked", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: ONE_ETH });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      // Accept locks collateral -- unlocked portion is ONE_ETH - COLLATERAL
      await escrow.connect(bundler1).accept(0n);
      await expect(escrow.connect(bundler1).withdraw(ONE_ETH - COLLATERAL))
        .to.emit(escrow, "Withdrawn").withArgs(bundler1.address, ONE_ETH - COLLATERAL);
    });
    it("CEI: reentrancy during withdraw is blocked by state update", async () => {
      const { escrow, registry } = await deploy();
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress(), await registry.getAddress());
      const addr = await attacker.getAddress();
      await ethers.provider.send("hardhat_setBalance", [addr, "0x" + (ONE_ETH * 3n).toString(16)]);
      await attacker.doDeposit({ value: ONE_ETH });
      await attacker.attackWithdraw(ONE_ETH);
      expect(await escrow.deposited(addr)).to.equal(0n);
      // CEI proof: receive() fires exactly once on the withdraw; re-entry into
      // settle() is caught by try/catch without a second ETH transfer.
      expect(await attacker.attackCount()).to.equal(1n);
    });
  });

  // -- commit -------------------------------------------------------------------
  describe("commit", () => {
    it("reverts if offer is inactive", async () => {
      const { escrow, registry, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: OFFER.collateralWei });
      await registry.connect(bundler1).deregister(QUOTE_ID);
      await expect(
        escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp })
      ).to.be.revertedWithCustomError(escrow, "OfferInactive");
    });
    it("reverts when fee is too low", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await expect(
        escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: ONE_GWEI - 1n })
      ).to.be.revertedWithCustomError(escrow, "WrongFee");
    });
    it("reverts when fee is too high", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await expect(
        escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: ONE_GWEI + 1n })
      ).to.be.revertedWithCustomError(escrow, "WrongFee");
    });
    it("reverts when bundler has insufficient idle collateral -- on accept, not commit", async () => {
      // commit() no longer checks collateral -- accept() does
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      // bundler has no deposit at all
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op1"));
      const acceptGrace = await escrow.ACCEPT_GRACE_BLOCKS();
      const expectedAcceptDeadline =
        BigInt(await ethers.provider.getBlockNumber()) + 1n + BigInt(acceptGrace);
      await expect(
        escrow.connect(user1).commit(QUOTE_ID, userOpHash, OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp })
      ).to.emit(escrow, "CommitCreated")
        .withArgs(0n, QUOTE_ID, user1.address, OFFER.bundler, userOpHash, expectedAcceptDeadline);
      // accept() reverts because bundler has no deposit
      await expect(escrow.connect(bundler1).accept(0n))
        .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
    });
    it("reserves fee and emits CommitCreated (collateral locked by accept(), not commit())", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op1"));
      const acceptGrace = await escrow.ACCEPT_GRACE_BLOCKS();
      const tx = await escrow.connect(user1).commit(
        QUOTE_ID, userOpHash, OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp }
      );
      const receipt = await tx.wait();
      const expectedAcceptDeadline = BigInt(receipt!.blockNumber) + BigInt(acceptGrace);
      await expect(tx).to.emit(escrow, "CommitCreated")
        .withArgs(0n, QUOTE_ID, user1.address, OFFER.bundler, userOpHash, expectedAcceptDeadline);
      // Collateral not locked yet -- locked only after accept()
      expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
      // Now accept: collateral is locked
      await escrow.connect(bundler1).accept(0n);
      expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
      expect(await escrow.idleBalance(bundler1.address)).to.equal(0n);
    });
    it("stores deadline = block.number + slaBlocks", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      // deadline is 0 before accept
      const cBefore = await escrow.getCommit(0n);
      expect(cBefore.deadline).to.equal(0n);
      // accept sets deadline = acceptBlock + slaBlocks
      const acceptTx = await escrow.connect(bundler1).accept(0n);
      const acceptReceipt = await acceptTx.wait();
      const acceptBlock = BigInt(acceptReceipt!.blockNumber);
      const c = await escrow.getCommit(0n);
      expect(c.deadline).to.equal(acceptBlock + 2n);
    });
    it("three concurrent commits succeed; two accepts lock collateral; third accept reverts InsufficientCollateral", async () => {
      const { escrow, bundler1, user1, user2, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      // Third commit succeeds (no collateral check at commit time)
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op3")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      // Accept the first two -- locks 2xCOLLATERAL
      await escrow.connect(bundler1).accept(0n);
      await escrow.connect(bundler1).accept(1n);
      // Third accept reverts: bundler's deposit is exhausted
      await expect(escrow.connect(bundler1).accept(2n))
        .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
    });
    it("with PROTOCOL_FEE_WEI set, msg.value must include it", async () => {
      // deploy a separate escrow with 100 wei protocol fee
      const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
      const reg  = await (await ethers.getContractFactory("QuoteRegistry")).deploy(owner.address, MIN_BOND);
      const Esc  = await ethers.getContractFactory("SLAEscrowTestable");
      const esc  = (await upgrades.deployProxy(Esc, [await reg.getAddress(), feeRecipient.address], { kind: "uups" })) as unknown as SLAEscrow;
      await esc.connect(owner).setProtocolFeeWei(100n);
      await reg.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: MIN_BOND });
      await esc.connect(bundler).deposit({ value: COLLATERAL });
      const offer = await reg.getOffer(1n);
      // value = feePerOp only -> WrongFee
      await expect(
        esc.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("op1")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp })
      ).to.be.revertedWithCustomError(esc, "WrongFee");
      // value = feePerOp + protocolFee -> success
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op1"));
      const acceptGrace = await esc.ACCEPT_GRACE_BLOCKS();
      const expectedAcceptDeadline =
        BigInt(await ethers.provider.getBlockNumber()) + 1n + BigInt(acceptGrace);
      await expect(
        esc.connect(user).commit(1n, userOpHash, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp + 100n })
      ).to.emit(esc, "CommitCreated")
        .withArgs(0n, 1n, user.address, offer.bundler, userOpHash, expectedAcceptDeadline);
    });

    // -- zero userOpHash -----------------------------------------------------------
    // bytes32(0) is never a valid ERC-4337 userOpHash (keccak256 preimage resistance).
    // Accepting a zero-hash commit would guarantee a bundler SLA miss and slash,
    // making it a cheap bundler-griefing / collateral extraction attack.
    it("zero userOpHash: commit reverts InvalidUserOpHash", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await expect(
        escrow.connect(user1).commit(
          QUOTE_ID, ethers.ZeroHash, OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks,
          { value: OFFER.feePerOp },
        ),
      ).to.be.revertedWithCustomError(escrow, "InvalidUserOpHash");
    });
  });

  // -- settle --------------------------------------------------------------------
  describe("settle", () => {
    async function setup() {
      const ctx = await deploy();
      await ctx.escrow.connect(ctx.bundler1).deposit({ value: COLLATERAL });
      await ctx.escrow.connect(ctx.user1).commit(
        ctx.QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), ctx.OFFER.bundler, ctx.OFFER.collateralWei, ctx.OFFER.slaBlocks, { value: ctx.OFFER.feePerOp }
      );
      await ctx.escrow.connect(ctx.bundler1).accept(0n);
      return { ...ctx, COMMIT_ID: 0n };
    }

    it("settle is permissionless -- a stranger can settle, fee still goes to bundler", async () => {
      const { escrow, bundler1, stranger, COMMIT_ID } = await setup();
      // stranger can call settle; fee credited to c.bundler (bundler1), not stranger
      await expect((escrow as any).connect(stranger)["settle(uint256)"](COMMIT_ID))
        .to.emit(escrow, "Settled").withArgs(COMMIT_ID, ONE_GWEI);
      expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
      expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
    });
    it("reverts when deadline has passed", async () => {
      const { escrow, bundler1, COMMIT_ID } = await setup();
      const c = await escrow.getCommit(COMMIT_ID);
      const sg = Number(await escrow.SETTLEMENT_GRACE_BLOCKS());
      // Mine past deadline + SETTLEMENT_GRACE_BLOCKS so settle window is closed
      await mine(Number(c.deadline) - await ethers.provider.getBlockNumber() + sg + 1);
      await expect((escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });
    it("succeeds at exactly the deadline block", async () => {
      const { escrow, bundler1, COMMIT_ID } = await setup();
      const c = await escrow.getCommit(COMMIT_ID);
      await mine(Number(c.deadline) - await ethers.provider.getBlockNumber() - 1);
      await expect((escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID))
        .to.emit(escrow, "Settled").withArgs(COMMIT_ID, ONE_GWEI);
    });
    it("queues full fee into pendingWithdrawals[bundler] -- no platform cut", async () => {
      const { escrow, bundler1, feeRecipient, COMMIT_ID } = await setup();
      const tx = await (escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID);
      // bundler gets full feePerOp; feeRecipient gets 0 (protocolFeeWei=0 default)
      await assertSettled(tx, escrow, COMMIT_ID, bundlerNet(ONE_GWEI));
      expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
    it("no direct ETH transfer on settle (contract balance unchanged)", async () => {
      const { escrow, bundler1, COMMIT_ID } = await setup();
      const balBefore = await contractBalance(escrow);
      await (escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID);
      expect(await contractBalance(escrow)).to.equal(balBefore);
    });
    it("unlocks collateral after settle", async () => {
      const { escrow, bundler1, COMMIT_ID } = await setup();
      await (escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID);
      expect(await escrow.idleBalance(bundler1.address)).to.equal(COLLATERAL);
    });
    it("reverts when already settled (AlreadyFinalized)", async () => {
      const { escrow, bundler1, COMMIT_ID } = await setup();
      await (escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID);
      await expect((escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });
    it("reverts when already refunded (AlreadyFinalized)", async () => {
      const { escrow, bundler1, user1, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      await escrow.connect(user1).claimRefund(COMMIT_ID);
      await expect((escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });
    it("settle makes no external calls: reentrancy vector does not exist", async () => {
      const { escrow, registry, user1 } = await deploy();
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress(), await registry.getAddress());
      const addr = await attacker.getAddress();
      await ethers.provider.send("hardhat_setBalance", [addr, "0x" + (ONE_ETH * 3n).toString(16)]);
      await attacker.doRegister(ONE_GWEI, 2, COLLATERAL, { value: MIN_BOND });
      const attackerQuoteId = 2n;
      await attacker.doDeposit({ value: COLLATERAL });
      const offer = await registry.getOffer(attackerQuoteId);
      await escrow.connect(user1).commit(attackerQuoteId, ethers.keccak256(ethers.toUtf8Bytes("opAA")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
      const COMMIT_ID = 0n;
      // bundler for this commit is the attacker contract; it accepts via acceptCommit
      await attacker.acceptCommit(COMMIT_ID);
      await attacker.setTarget(COMMIT_ID, 0);
      await attacker.attackSettle(COMMIT_ID);
      expect(await attacker.attackCount()).to.equal(0n);
      expect((await escrow.getCommit(COMMIT_ID)).settled).to.be.true;
      // Attacker is the bundler; settle credits exactly feePerOp = ONE_GWEI.
      expect(await escrow.pendingWithdrawals(addr)).to.equal(ONE_GWEI);
    });
    it("PROTOCOL_FEE_WEI is credited to feeRecipient at commit time, not settle time", async () => {
      const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
      const reg  = await (await ethers.getContractFactory("QuoteRegistry")).deploy(owner.address, MIN_BOND);
      const Esc  = await ethers.getContractFactory("SLAEscrowTestable");
      const esc  = (await upgrades.deployProxy(Esc, [await reg.getAddress(), feeRecipient.address], { kind: "uups" })) as unknown as SLAEscrow;
      await esc.connect(owner).setProtocolFeeWei(100n);
      await reg.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: MIN_BOND });
      await esc.connect(bundler).deposit({ value: COLLATERAL });
      const offer = await reg.getOffer(1n);
      // commit -- feeRecipient gets 100 wei at commit time
      await esc.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("op1")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp + 100n });
      expect(await esc.pendingWithdrawals(feeRecipient.address)).to.equal(100n);
      // accept to move to ACTIVE
      await esc.connect(bundler).accept(0n);
      // settle -- feeRecipient gets nothing more; bundler gets full feePerOp
      await (esc as any).connect(bundler)["settle(uint256)"](0n);
      expect(await esc.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
      expect(await esc.pendingWithdrawals(feeRecipient.address)).to.equal(100n); // unchanged
    });
  });

  // -- claimRefund ---------------------------------------------------------------
  describe("claimRefund", () => {
    async function setup() {
      const ctx = await deploy();
      await ctx.escrow.connect(ctx.bundler1).deposit({ value: COLLATERAL });
      await ctx.escrow.connect(ctx.user1).commit(
        ctx.QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), ctx.OFFER.bundler, ctx.OFFER.collateralWei, ctx.OFFER.slaBlocks, { value: ctx.OFFER.feePerOp }
      );
      await ctx.escrow.connect(ctx.bundler1).accept(0n);
      return { ...ctx, COMMIT_ID: 0n };
    }

    it("stranger cannot call claimRefund -- reverts Unauthorized (T12: CLIENT/BUNDLER/feeRecipient only)", async () => {
      const { escrow, stranger, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      await expect(escrow.connect(stranger).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");
    });
    it("reverts before deadline", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      await expect(escrow.connect(user1).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "NotExpired");
    });
    it("reverts at exactly the deadline block", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      const c = await escrow.getCommit(COMMIT_ID);
      await mine(Number(c.deadline) - await ethers.provider.getBlockNumber() - 1);
      await expect(escrow.connect(user1).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "NotExpired");
    });
    it("reverts during grace period (deadline+1 to deadline+GRACE)", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      const c = await escrow.getCommit(COMMIT_ID);
      await mine(Number(c.deadline) - await ethers.provider.getBlockNumber());
      await expect(escrow.connect(user1).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "NotExpired");
    });
    it("succeeds at deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1 and emits Refunded", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      const tx = await escrow.connect(user1).claimRefund(COMMIT_ID);
      await assertRefunded(tx, escrow, COMMIT_ID, userRefundAmount(ONE_GWEI, COLLATERAL));
    });
    it("queues full feePaid+collateral to user -- protocol receives nothing (T10: 100% slash to CLIENT)", async () => {
      const { escrow, user1, feeRecipient, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      await escrow.connect(user1).claimRefund(COMMIT_ID);
      expect(await escrow.pendingWithdrawals(user1.address))
        .to.equal(userRefundAmount(ONE_GWEI, COLLATERAL));
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
    it("no direct ETH transfer on claimRefund (contract balance unchanged)", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      const balBefore = await contractBalance(escrow);
      await escrow.connect(user1).claimRefund(COMMIT_ID);
      expect(await contractBalance(escrow)).to.equal(balBefore);
    });
    it("slashes bundler: deposited reduced to 0", async () => {
      const { escrow, bundler1, user1, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      await escrow.connect(user1).claimRefund(COMMIT_ID);
      expect(await escrow.deposited(bundler1.address)).to.equal(0n);
      expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
    });
    it("reverts when already settled (AlreadyFinalized)", async () => {
      const { escrow, bundler1, user1, COMMIT_ID } = await setup();
      await (escrow as any).connect(bundler1)["settle(uint256)"](COMMIT_ID);
      await mineToRefundable(escrow, COMMIT_ID);
      await expect(escrow.connect(user1).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });
    it("reverts when already refunded (AlreadyFinalized)", async () => {
      const { escrow, user1, COMMIT_ID } = await setup();
      await mineToRefundable(escrow, COMMIT_ID);
      await escrow.connect(user1).claimRefund(COMMIT_ID);
      await expect(escrow.connect(user1).claimRefund(COMMIT_ID))
        .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });
    it("claimRefund makes no external calls: reentrancy vector does not exist", async () => {
      const { escrow, bundler1, QUOTE_ID, OFFER, registry } = await deploy();
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress(), await registry.getAddress());
      const addr = await attacker.getAddress();
      await ethers.provider.send("hardhat_setBalance", [addr, "0x" + (ONE_ETH * 3n).toString(16)]);
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      const attackerSigner = await ethers.getImpersonatedSigner(addr);
      await escrow.connect(attackerSigner).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("opBB")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp }
      );
      // bundler1 is OFFER.bundler; accept to move to ACTIVE
      await escrow.connect(bundler1).accept(0n);
      await attacker.setTarget(0n, 1);
      await mineToRefundable(escrow, 0n);
      await attacker.attackClaimRefund(0n);
      expect(await attacker.attackCount()).to.equal(0n);
      expect((await escrow.getCommit(0n)).refunded).to.be.true;
      // Attacker is the CLIENT; refund credits feePaid + collateralLocked (100% slash).
      expect(await escrow.pendingWithdrawals(addr)).to.equal(ONE_GWEI + COLLATERAL);
    });
  });

  // -- claimPayout ---------------------------------------------------------------
  describe("claimPayout", () => {
    it("reverts when nothing is owed", async () => {
      const { escrow, stranger } = await deploy();
      await expect(escrow.connect(stranger).claimPayout())
        .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
    it("bundler receives full feePerOp after settle", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      const balBefore = await ethers.provider.getBalance(bundler1.address);
      const tx      = await escrow.connect(bundler1).claimPayout();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      expect(await ethers.provider.getBalance(bundler1.address))
        .to.equal(balBefore + ONE_GWEI - gasCost);
    });
    it("feeRecipient receives 0 from settle when protocolFeeWei=0", async () => {
      const { escrow, bundler1, user1, feeRecipient, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
    it("user receives full feePaid + collateral after claimRefund", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await mineToRefundable(escrow, 0n);
      await escrow.connect(user1).claimRefund(0n);
      const expected  = userRefundAmount(ONE_GWEI, COLLATERAL);
      const balBefore = await ethers.provider.getBalance(user1.address);
      const tx      = await escrow.connect(user1).claimPayout();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      expect(await ethers.provider.getBalance(user1.address))
        .to.equal(balBefore + expected - gasCost);
    });
    it("emits PayoutClaimed with correct amount", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      await expect(escrow.connect(bundler1).claimPayout())
        .to.emit(escrow, "PayoutClaimed").withArgs(bundler1.address, ONE_GWEI);
    });
    it("clears pendingWithdrawals and reverts on second call", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      await escrow.connect(bundler1).claimPayout();
      await expect(escrow.connect(bundler1).claimPayout())
        .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
    it("accumulated payouts from multiple settles can be claimed in one call", async () => {
      const { escrow, bundler1, user1, user2, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await escrow.connect(bundler1).accept(1n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](1n);
      expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI * 2n);
    });
    it("CEI: reentrancy during claimPayout is blocked", async () => {
      const { escrow, bundler1, QUOTE_ID, OFFER, registry } = await deploy();
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress(), await registry.getAddress());
      const addr = await attacker.getAddress();
      await ethers.provider.send("hardhat_setBalance", [addr, "0x" + (ONE_ETH * 3n).toString(16)]);
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      const attackerSigner = await ethers.getImpersonatedSigner(addr);
      await escrow.connect(attackerSigner).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("opCC")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp }
      );
      // bundler1 is OFFER.bundler; accept to move to ACTIVE
      await escrow.connect(bundler1).accept(0n);
      await mineToRefundable(escrow, 0n);
      await attacker.attackClaimRefund(0n);
      // Attacker is the CLIENT; refund credits feePaid + collateralLocked (100% slash).
      expect(await escrow.pendingWithdrawals(addr)).to.equal(ONE_GWEI + COLLATERAL);
      await attacker.setTarget(0n, 2);
      await attacker.attackClaimPayout();
      // CEI proof: receive() fires exactly once on the claimPayout transfer;
      // the re-entrant claimPayout() call reverts because pending was zeroed first.
      expect(await attacker.attackCount()).to.equal(1n);
      expect(await escrow.pendingWithdrawals(addr)).to.equal(0n);
    });
  });

  // -- version -------------------------------------------------------------------
  describe("version", () => {
    it("returns version 0.8", async () => {
      const { escrow } = await deploy();
      expect(await escrow.version()).to.equal("0.8");
    });
  });

  // -- setProtocolFeeWei ---------------------------------------------------------
  describe("setProtocolFeeWei", () => {
    it("owner can change PROTOCOL_FEE_WEI", async () => {
      const { escrow, owner } = await deploy();
      await escrow.connect(owner).setProtocolFeeWei(500n);
      expect(await escrow.protocolFeeWei()).to.equal(500n);
    });
    it("reverts when caller is not the owner", async () => {
      const { escrow, stranger } = await deploy();
      await expect(escrow.connect(stranger).setProtocolFeeWei(500n))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
    it("reverts when newFee > MAX_PROTOCOL_FEE_WEI (0.001 ether)", async () => {
      const { escrow, owner } = await deploy();
      const max = await escrow.MAX_PROTOCOL_FEE_WEI();
      await expect(escrow.connect(owner).setProtocolFeeWei(max + 1n))
        .to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
    });
    it("accepts MAX_PROTOCOL_FEE_WEI exactly", async () => {
      const { escrow, owner } = await deploy();
      const max = await escrow.MAX_PROTOCOL_FEE_WEI();
      await escrow.connect(owner).setProtocolFeeWei(max);
      expect(await escrow.protocolFeeWei()).to.equal(max);
    });
    it("accepts 0 (fee off)", async () => {
      const { escrow, owner } = await deploy();
      await escrow.connect(owner).setProtocolFeeWei(500n);
      await escrow.connect(owner).setProtocolFeeWei(0n);
      expect(await escrow.protocolFeeWei()).to.equal(0n);
    });
    it("emits ProtocolFeeUpdated with old and new values", async () => {
      const { escrow, owner } = await deploy();
      await expect(escrow.connect(owner).setProtocolFeeWei(500n))
        .to.emit(escrow, "ProtocolFeeUpdated")
        .withArgs(0n, 500n);
    });
  });

  // -- setRegistry ---------------------------------------------------------------
  describe("setRegistry", () => {
    it("owner can change REGISTRY", async () => {
      const { escrow, owner } = await deploy();
      const Reg = await ethers.getContractFactory("QuoteRegistry");
      const reg2 = await Reg.deploy(owner.address, MIN_BOND);
      const reg2Addr = await reg2.getAddress();
      await escrow.connect(owner).setRegistry(reg2Addr);
      expect(await escrow.registry()).to.equal(reg2Addr);
    });
    it("reverts when caller is not the owner", async () => {
      const { escrow, stranger, registry } = await deploy();
      await expect(escrow.connect(stranger).setRegistry(await registry.getAddress()))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
    it("reverts on zero address", async () => {
      const { escrow, owner } = await deploy();
      await expect(escrow.connect(owner).setRegistry(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
    it("reverts on EOA (non-contract) address", async () => {
      const { escrow, owner, stranger } = await deploy();
      await expect(escrow.connect(owner).setRegistry(stranger.address))
        .to.be.revertedWithCustomError(escrow, "InvalidRegistry");
    });
    it("emits RegistryUpdated with old and new addresses", async () => {
      const { escrow, registry, owner } = await deploy();
      const Reg = await ethers.getContractFactory("QuoteRegistry");
      const reg2 = await Reg.deploy(owner.address, MIN_BOND);
      const reg2Addr = await reg2.getAddress();
      await expect(escrow.connect(owner).setRegistry(reg2Addr))
        .to.emit(escrow, "RegistryUpdated")
        .withArgs(await registry.getAddress(), reg2Addr);
    });
  });

  // -- balance invariant ---------------------------------------------------------
  describe("balance invariant", () => {
    it("invariant holds across deposit -> commit -> settle -> claimPayout", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();

      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await assertBalanceInvariant(escrow, [bundler1.address], [], 0n);

      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await assertBalanceInvariant(escrow, [bundler1.address], [], ONE_GWEI);

      await escrow.connect(bundler1).accept(0n);
      // fee is still floating (not yet in pendingWithdrawals); collateral now locked in deposited
      await assertBalanceInvariant(escrow, [bundler1.address], [], ONE_GWEI);

      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      await assertBalanceInvariant(escrow, [bundler1.address], [bundler1.address], 0n);

      await escrow.connect(bundler1).claimPayout();
      await assertBalanceInvariant(escrow, [bundler1.address], [], 0n);
    });

    it("invariant holds across deposit -> commit -> claimRefund -> claimPayout", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();

      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks, { value: OFFER.feePerOp });
      await escrow.connect(bundler1).accept(0n);
      await mineToRefundable(escrow, 0n);

      await escrow.connect(user1).claimRefund(0n);
      // bundler deposited->0; full amount goes to user (no protocol cut)
      await assertBalanceInvariant(escrow, [bundler1.address], [user1.address], 0n);

      await escrow.connect(user1).claimPayout();
      await assertBalanceInvariant(escrow, [bundler1.address], [], 0n);
      expect(await contractBalance(escrow)).to.equal(0n);
    });

    it("invariant holds with multiple bundlers and mixed outcomes", async () => {
      const { escrow, registry, bundler1, bundler2, user1, user2, QUOTE_ID, OFFER } = await deploy();

      await registry.connect(bundler2).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: MIN_BOND });
      const QUOTE_2 = 2n;
      const OFFER_2 = await registry.getOffer(QUOTE_2);

      await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
      await escrow.connect(bundler2).deposit({ value: COLLATERAL });

      await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")), OFFER.bundler,   OFFER.collateralWei,   OFFER.slaBlocks,   { value: OFFER.feePerOp });
      await escrow.connect(user2).commit(QUOTE_2,  ethers.keccak256(ethers.toUtf8Bytes("op2")), OFFER_2.bundler, OFFER_2.collateralWei, OFFER_2.slaBlocks, { value: OFFER_2.feePerOp });

      await escrow.connect(bundler1).accept(0n);
      await escrow.connect(bundler2).accept(1n);

      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);
      await mineToRefundable(escrow, 1n);
      await escrow.connect(user2).claimRefund(1n);

      await assertBalanceInvariant(
        escrow,
        [bundler1.address, bundler2.address],
        [bundler1.address, user2.address],
        0n,
      );
    });
  });

  // -- already-settled hash re-commitment (Finding 1) ---------------------------
  //
  // commit() now checks retiredHashes[userOpHash] before recording any effects.
  // A hash that has been settled can never be re-committed -- the attack path
  // (commit -> accept -> unsettleable -> claimRefund -> extract collateral) is closed.
  describe("already-settled hash re-commitment", () => {
    it("re-commit of settled hash reverts UserOpHashRetired", async () => {
      const { escrow, bundler1, user1, QUOTE_ID, OFFER } = await deploy();
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });

      const hash = ethers.keccak256(ethers.toUtf8Bytes("finding1-hash"));

      // settle once
      await escrow.connect(user1).commit(
        QUOTE_ID, hash, OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks,
        { value: OFFER.feePerOp },
      );
      await escrow.connect(bundler1).accept(0n);
      await (escrow as any).connect(bundler1)["settle(uint256)"](0n);

      expect(await escrow.retiredHashes(hash)).to.be.true;

      // re-commit same hash -- must revert
      await expect(
        escrow.connect(user1).commit(
          QUOTE_ID, hash, OFFER.bundler, OFFER.collateralWei, OFFER.slaBlocks,
          { value: OFFER.feePerOp },
        ),
      ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
    });
  });
});
