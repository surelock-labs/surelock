import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { mine, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry } from "../typechain-types";
import { selectBest, Offer } from "@surelock-labs/router";

const MIN_BOND     = ethers.parseEther("0.0001");
const MAX_BOND     = ethers.parseEther("10");
const MIN_LIFETIME = 302_400;
const MAX_LIFETIME = 3_888_000;
const MAX_SLA_BLOCKS = 1_000;
const ONE_GWEI     = ethers.parseUnits("1", "gwei");
const COLLATERAL   = ethers.parseEther("0.01");

describe("QuoteRegistry", () => {
  let registry: QuoteRegistry;
  let owner: any, bundler1: any, bundler2: any, stranger: any;

  beforeEach(async () => {
    [owner, bundler1, bundler2, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("QuoteRegistry");
    registry = await Factory.deploy(owner.address, MIN_BOND);
  });

  // -- constructor ------------------------------------------------------------

  describe("constructor", () => {
    it("reverts when initialBond < MIN_BOND", async () => {
      const Factory = await ethers.getContractFactory("QuoteRegistry");
      await expect(Factory.deploy(owner.address, MIN_BOND - 1n))
        .to.be.revertedWith("initialBond < MIN_BOND");
    });

    it("reverts when initialBond > MAX_BOND", async () => {
      const Factory = await ethers.getContractFactory("QuoteRegistry");
      await expect(Factory.deploy(owner.address, MAX_BOND + 1n))
        .to.be.revertedWith("initialBond > MAX_BOND");
    });

    it("renounceOwnership reverts with RenounceOwnershipDisabled", async () => {
      await expect(registry.connect(owner).renounceOwnership())
        .to.be.revertedWithCustomError(registry, "RenounceOwnershipDisabled");
    });
  });

  // -- State machine ----------------------------------------------------------

  describe("state machine", () => {
    it("NOT_EXIST: getOffer returns zero struct, isActive=false for quoteId=0", async () => {
      const o = await registry.getOffer(0n);
      expect(o.bundler).to.equal(ethers.ZeroAddress);
      expect(o.feePerOp).to.equal(0n);
      expect(await registry.isActive(0n)).to.be.false;
    });

    it("NOT_EXIST: isActive=false for non-existent quoteId", async () => {
      expect(await registry.isActive(999n)).to.be.false;
    });

    it("ACTIVE: after register, isActive=true; bond=registrationBond; registeredAt=register block", async () => {
      const blockBefore = await ethers.provider.getBlockNumber();
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const o = await registry.getOffer(1n);
      expect(await registry.isActive(1n)).to.be.true;
      expect(o.bond).to.equal(MIN_BOND);
      // register() mined in the very next block -> registeredAt = blockBefore + 1.
      expect(o.registeredAt).to.equal(BigInt(blockBefore) + 1n);
    });

    it("EXPIRED: after mining MIN_LIFETIME+1 blocks, isActive=false; bond still > 0", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await mine(MIN_LIFETIME + 1);
      expect(await registry.isActive(1n)).to.be.false;
      const o = await registry.getOffer(1n);
      // bond is preserved across ACTIVE->EXPIRED (only deregister/deregisterExpired clear it)
      expect(o.bond).to.equal(MIN_BOND);
    });

    it("DEREGISTERED: after deregister, bond=0, isActive=false (terminal)", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.isActive(1n)).to.be.false;
      const o = await registry.getOffer(1n);
      expect(o.bond).to.equal(0n);
    });

    it("ACTIVE at registeredAt + lifetime (boundary); EXPIRED at +1", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const o = await registry.getOffer(1n);
      // Mine to the exact boundary block: registeredAt + lifetime
      const current = await ethers.provider.getBlockNumber();
      const boundary = Number(o.registeredAt) + MIN_LIFETIME;
      await mine(boundary - current);
      // isActive uses <=, so exactly at the boundary the offer is still active
      expect(await registry.isActive(1n)).to.be.true;
      await mine(1);
      expect(await registry.isActive(1n)).to.be.false;
    });

    it("ACTIVE->EXPIRED is a one-way door (renew blocks it once expired)", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await mine(MIN_LIFETIME + 1);
      await expect(
        registry.connect(bundler1).renew(1n)
      ).to.be.revertedWithCustomError(registry, "AlreadyExpired");
    });
  });

  // -- register() -------------------------------------------------------------

  describe("register", () => {
    it("stores offer correctly and emits OfferRegistered(quoteId, bundler, expiry)", async () => {
      // expiry = uint64(block.number) + uint64(lifetime); register mines in the next block.
      const expectedExpiry = BigInt(await ethers.provider.getBlockNumber()) + 1n + BigInt(MIN_LIFETIME);
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND })
      ).to.emit(registry, "OfferRegistered")
        .withArgs(1n, bundler1.address, expectedExpiry);

      const o = await registry.getOffer(1n);
      expect(o.quoteId).to.equal(1n);
      expect(o.bundler).to.equal(bundler1.address);
      expect(o.feePerOp).to.equal(ONE_GWEI);
      expect(o.slaBlocks).to.equal(10);
      expect(o.collateralWei).to.equal(COLLATERAL);
      expect(o.lifetime).to.equal(MIN_LIFETIME);
      expect(o.bond).to.equal(MIN_BOND);
    });

    it("quoteId starts at 1 and increments", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.nextQuoteId()).to.equal(3n);
    });

    it("reverts IncorrectBond if msg.value != registrationBond", async () => {
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: 1n })
      ).to.be.revertedWithCustomError(registry, "IncorrectBond");
    });

    it("reverts if slaBlocks=0", async () => {
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 0, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWith("slaBlocks must be > 0");
    });

    it("reverts if feePerOp=0", async () => {
      await expect(
        registry.connect(bundler1).register(0n, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWith("feePerOp must be > 0");
    });

    it("reverts if collateralWei <= feePerOp", async () => {
      await expect(
        registry.connect(bundler1).register(COLLATERAL, 10, ONE_GWEI, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWith("collateralWei must be > feePerOp");
    });

    it("reverts if lifetime < MIN_LIFETIME", async () => {
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME - 1, { value: MIN_BOND })
      ).to.be.revertedWith("lifetime < MIN_LIFETIME");
    });

    it("reverts if lifetime > MAX_LIFETIME", async () => {
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MAX_LIFETIME + 1, { value: MIN_BOND })
      ).to.be.revertedWith("lifetime > MAX_LIFETIME");
    });

    it("reverts if slaBlocks > MAX_SLA_BLOCKS", async () => {
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, MAX_SLA_BLOCKS + 1, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
    });

    it("reverts if feePerOp > uint96.max (ValueTooLarge)", async () => {
      const tooBig = BigInt(2 ** 96);
      await expect(
        registry.connect(bundler1).register(tooBig, 10, tooBig + 1n, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("reverts if collateralWei > uint96.max (ValueTooLarge)", async () => {
      const tooBig = BigInt(2 ** 96);
      await expect(
        registry.connect(bundler1).register(ONE_GWEI, 10, tooBig, MIN_LIFETIME, { value: MIN_BOND })
      ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("allows same bundler to register multiple offers", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 1, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).register(ONE_GWEI * 2n, 2, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const offers = await registry.list();
      expect(offers).to.have.length(2);
      expect(offers[0].bundler).to.equal(bundler1.address);
      expect(offers[1].bundler).to.equal(bundler1.address);
    });
  });

  // -- deregister() -----------------------------------------------------------

  describe("deregister", () => {
    beforeEach(async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
    });

    it("NotOfferOwner if caller != bundler", async () => {
      await expect(registry.connect(stranger).deregister(1n))
        .to.be.revertedWithCustomError(registry, "NotOfferOwner")
        .withArgs(1n, stranger.address);
    });

    it("AlreadyDeregistered if called twice", async () => {
      await registry.connect(bundler1).deregister(1n);
      await expect(registry.connect(bundler1).deregister(1n))
        .to.be.revertedWithCustomError(registry, "AlreadyDeregistered");
    });

    it("OfferNotFound for non-existent quoteId", async () => {
      await expect(registry.connect(bundler1).deregister(999n))
        .to.be.revertedWithCustomError(registry, "OfferNotFound");
    });

    it("deregister moves bond to pendingBonds; claimBond() delivers ETH to bundler", async () => {
      // deregister moves bond to pendingBonds; claimBond() transfers ETH
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.pendingBonds(bundler1.address)).to.equal(MIN_BOND);

      const balBefore = await ethers.provider.getBalance(bundler1.address);
      const tx = await registry.connect(bundler1).claimBond();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(bundler1.address);
      expect(balAfter + gasCost - balBefore).to.equal(MIN_BOND);
    });

    it("emits OfferDeactivated(quoteId, bundler, 0)", async () => {
      await expect(registry.connect(bundler1).deregister(1n))
        .to.emit(registry, "OfferDeactivated")
        .withArgs(1n, bundler1.address, 0);
    });

    it("works on EXPIRED offers too (not just ACTIVE)", async () => {
      await mine(MIN_LIFETIME + 1);
      expect(await registry.isActive(1n)).to.be.false;
      // reason=0 (voluntary deregister) even though offer is already EXPIRED.
      await expect(registry.connect(bundler1).deregister(1n))
        .to.emit(registry, "OfferDeactivated")
        .withArgs(1n, bundler1.address, 0);
    });
  });

  // -- deregisterExpired() -------------------------------------------------------

  describe("deregisterExpired", () => {
    beforeEach(async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
    });

    it("NotExpired if called on ACTIVE offer", async () => {
      await expect(registry.connect(stranger).deregisterExpired(1n))
        .to.be.revertedWithCustomError(registry, "NotExpired");
    });

    it("succeeds on EXPIRED offer, returns bond to bundler", async () => {
      // deregisterExpired moves bond to pendingBonds; bundler calls claimBond() to receive ETH
      await mine(MIN_LIFETIME + 1);
      await registry.connect(stranger).deregisterExpired(1n);
      expect(await registry.pendingBonds(bundler1.address)).to.equal(MIN_BOND);

      const balBefore = await ethers.provider.getBalance(bundler1.address);
      const tx = await registry.connect(bundler1).claimBond();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(bundler1.address);
      expect(balAfter + gasCost - balBefore).to.equal(MIN_BOND);
    });

    it("emits OfferDeactivated(quoteId, bundler, 1)", async () => {
      await mine(MIN_LIFETIME + 1);
      await expect(registry.connect(stranger).deregisterExpired(1n))
        .to.emit(registry, "OfferDeactivated")
        .withArgs(1n, bundler1.address, 1);
    });

    it("permissionless (stranger can call)", async () => {
      await mine(MIN_LIFETIME + 1);
      await expect(registry.connect(stranger).deregisterExpired(1n)).to.not.be.reverted;
    });

    it("reverts AlreadyDeregistered when called twice", async () => {
      await mine(MIN_LIFETIME + 1);
      await registry.connect(stranger).deregisterExpired(1n);
      await expect(registry.connect(stranger).deregisterExpired(1n))
        .to.be.revertedWithCustomError(registry, "AlreadyDeregistered");
    });
  });

  // -- renew() ----------------------------------------------------------------

  describe("renew", () => {
    beforeEach(async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
    });

    it("resets registeredAt, extends TTL", async () => {
      await mine(100);
      const before = await registry.getOffer(1n);
      const blockBeforeRenew = await ethers.provider.getBlockNumber();
      await registry.connect(bundler1).renew(1n);
      const after = await registry.getOffer(1n);
      // renew() mined in the very next block -> registeredAt = blockBeforeRenew + 1.
      expect(after.registeredAt).to.equal(BigInt(blockBeforeRenew) + 1n);
    });

    it("NotOfferOwner if wrong caller", async () => {
      await expect(registry.connect(stranger).renew(1n))
        .to.be.revertedWithCustomError(registry, "NotOfferOwner");
    });

    it("AlreadyExpired if offer is expired", async () => {
      await mine(MIN_LIFETIME + 1);
      await expect(registry.connect(bundler1).renew(1n))
        .to.be.revertedWithCustomError(registry, "AlreadyExpired");
    });

    it("AlreadyDeregistered if bond=0", async () => {
      await registry.connect(bundler1).deregister(1n);
      await expect(registry.connect(bundler1).renew(1n))
        .to.be.revertedWithCustomError(registry, "AlreadyDeregistered");
    });

    it("emits OfferRenewed(quoteId, bundler, newExpiry)", async () => {
      const blockBeforeRenew = await ethers.provider.getBlockNumber();
      const expectedExpiry   = BigInt(blockBeforeRenew) + 1n + BigInt(MIN_LIFETIME);
      await expect(registry.connect(bundler1).renew(1n))
        .to.emit(registry, "OfferRenewed")
        .withArgs(1n, bundler1.address, expectedExpiry);
    });
    it("renew() only updates registeredAt -- economics unchanged after renew", async () => {
      const before = await registry.getOffer(1n);
      await mine(100);
      await registry.connect(bundler1).renew(1n);
      const after = await registry.getOffer(1n);
      // Economics must not change
      expect(after.feePerOp).to.equal(before.feePerOp);
      expect(after.collateralWei).to.equal(before.collateralWei);
      expect(after.slaBlocks).to.equal(before.slaBlocks);
      expect(after.bond).to.equal(before.bond);
      expect(after.lifetime).to.equal(before.lifetime);
      expect(after.bundler).to.equal(before.bundler);
      // Only the TTL anchor moves
      expect(after.registeredAt).to.be.gt(before.registeredAt);
    });
    it("renew at exactly the expiry block succeeds (isActive boundary is inclusive)", async () => {
      // isActive() = block.number <= registeredAt + lifetime
      // The boundary block is the last block where renew() is allowed.
      const offer = await registry.getOffer(1n);
      const expiryBlock = offer.registeredAt + BigInt(MIN_LIFETIME);
      const current = BigInt(await ethers.provider.getBlockNumber());
      await mine(Number(expiryBlock - current - 1n));
      // Next tx mines at expiryBlock = registeredAt + lifetime -- still active
      await expect(registry.connect(bundler1).renew(1n)).to.not.be.reverted;
    });
  });

  // -- claimBond() ------------------------------------------------------------

  describe("claimBond", () => {
    it("NoBondPending if nothing to claim", async () => {
      await expect(registry.connect(bundler1).claimBond())
        .to.be.revertedWithCustomError(registry, "NoBondPending");
    });
    it("bundler B cannot claim bundler A's pending bond", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.pendingBonds(bundler1.address)).to.equal(MIN_BOND);
      // bundler2 has no pending bond; claimBond reverts rather than touching bundler1's credit
      await expect(registry.connect(bundler2).claimBond())
        .to.be.revertedWithCustomError(registry, "NoBondPending");
      expect(await registry.pendingBonds(bundler1.address)).to.equal(MIN_BOND);
    });

    it("claimBondTo: sends bond to explicit recipient", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      const balBefore = await ethers.provider.getBalance(stranger.address);
      await registry.connect(bundler1).claimBondTo(stranger.address);
      const balAfter = await ethers.provider.getBalance(stranger.address);
      expect(balAfter - balBefore).to.equal(MIN_BOND);
      expect(await registry.pendingBonds(bundler1.address)).to.equal(0n);
    });

    it("claimBondTo: reverts on ZeroAddress", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      await expect(registry.connect(bundler1).claimBondTo(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("contract caller registers and deregisters; bond lands in pendingBonds (pull-only model)", async () => {
      // Deploy a contract bundler whose receive() always reverts
      const ReverterFactory = await ethers.getContractFactory("ReverterReceiver");
      const reverter = await ReverterFactory.deploy();
      const reverterAddr = await reverter.getAddress();

      // Fund the reverter using hardhat_setBalance (can't sendTransaction because receive() reverts)
      await ethers.provider.send("hardhat_setBalance", [
        reverterAddr, "0x" + ethers.parseEther("1").toString(16),
      ]);

      // Register as the reverter contract (via low-level call)
      const registryAddr = await registry.getAddress();
      const iface = new ethers.Interface([
        "function register(uint256,uint32,uint256,uint32) payable returns (uint256)",
      ]);
      const calldata = iface.encodeFunctionData("register", [ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME]);
      await reverter.execute(registryAddr, MIN_BOND, calldata);

      expect(await registry.isActive(1n)).to.be.true;

      // deregister() is pull-only: bond moves to pendingBonds, no push attempted
      const deregCalldata = new ethers.Interface(["function deregister(uint256)"]).encodeFunctionData("deregister", [1n]);
      await reverter.execute(registryAddr, 0n, deregCalldata);

      expect(await registry.pendingBonds(reverterAddr)).to.equal(MIN_BOND);
      expect(await registry.totalTracked()).to.equal(MIN_BOND);
    });

    it("claimBondTo: reverts atomically when recipient's receive() reverts; state unchanged", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);

      const ReverterFactory = await ethers.getContractFactory("ReverterReceiver");
      const reverter = await ReverterFactory.deploy();

      const pendingBefore = await registry.pendingBonds(bundler1.address);
      const trackedBefore = await registry.totalTracked();

      // OZ sendValue propagates the revert -- whole tx reverts atomically
      await expect(
        registry.connect(bundler1).claimBondTo(await reverter.getAddress() as any)
      ).to.be.reverted;

      expect(await registry.pendingBonds(bundler1.address)).to.equal(pendingBefore);
      expect(await registry.totalTracked()).to.equal(trackedBefore);
    });
  });

  // -- setBond() --------------------------------------------------------------

  describe("setBond", () => {
    it("owner can change bond", async () => {
      const newBond = ethers.parseEther("0.001");
      await registry.connect(owner).setBond(newBond);
      expect(await registry.registrationBond()).to.equal(newBond);
    });

    it("non-owner reverts", async () => {
      await expect(registry.connect(stranger).setBond(MIN_BOND))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });

    it("cannot set below MIN_BOND", async () => {
      await expect(registry.connect(owner).setBond(MIN_BOND - 1n))
        .to.be.revertedWith("newBond < MIN_BOND");
    });

    it("cannot set above MAX_BOND", async () => {
      await expect(registry.connect(owner).setBond(MAX_BOND + 1n))
        .to.be.revertedWith("newBond > MAX_BOND");
    });

    it("emits BondUpdated(oldBond, newBond)", async () => {
      const newBond = ethers.parseEther("0.001");
      await expect(registry.connect(owner).setBond(newBond))
        .to.emit(registry, "BondUpdated")
        .withArgs(MIN_BOND, newBond);
    });
    it("setBond() is not retroactive -- existing registration refunds old bond; new registration requires new bond", async () => {
      // Register under old bond
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const newBond = MIN_BOND * 2n;
      await registry.connect(owner).setBond(newBond);
      // Deregister: bundler gets back the original bond amount, not newBond
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.pendingBonds(bundler1.address)).to.equal(MIN_BOND);
      // New registration with old bond value now reverts
      await expect(
        registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
      ).to.be.revertedWithCustomError(registry, "IncorrectBond");
      // New registration with new bond value succeeds
      await expect(
        registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: newBond }),
      ).to.not.be.reverted;
    });
  });

  // -- ETH accounting (BondConservation invariant) ----------------------------

  describe("ETH accounting (BondConservation invariant)", () => {
    it("balance == totalTracked after registration (no force-sent ETH)", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const bal = await ethers.provider.getBalance(await registry.getAddress());
      const tracked = await registry.totalTracked();
      expect(bal).to.equal(tracked);
    });

    it("totalTracked == sum of bonds after registration", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.totalTracked()).to.equal(MIN_BOND * 2n);
    });

    it("totalTracked decreases after deregister + claimBond", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      // deregister moves to pendingBonds -- totalTracked still tracks the pending bond
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.totalTracked()).to.equal(MIN_BOND * 2n);
      // claimBond transfers ETH and decrements totalTracked
      await registry.connect(bundler1).claimBond();
      expect(await registry.totalTracked()).to.equal(MIN_BOND);
    });
  });

  // -- sweepExcess ------------------------------------------------------------

  describe("sweepExcess", () => {
    it("transfers force-sent ETH excess to owner", async () => {
      // Register one offer so totalTracked == MIN_BOND
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const addr = await registry.getAddress();

      // Force-set balance to MIN_BOND + excess (simulates selfdestruct/direct send)
      const excess = ethers.parseEther("1");
      await setBalance(addr, MIN_BOND + excess);

      // sweepExcess sends excess to owner
      await registry.connect(owner).sweepExcess();

      // Contract balance is back down to exactly totalTracked
      const balAfter = await ethers.provider.getBalance(addr);
      const tracked  = await registry.totalTracked();
      expect(balAfter).to.equal(tracked);
      expect(tracked).to.equal(MIN_BOND);
    });

    it("no-op when balance == totalTracked: owner balance unchanged, contract balance unchanged", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const addr = await registry.getAddress();

      const ownerBalBefore    = await ethers.provider.getBalance(owner.address);
      const contractBalBefore = await ethers.provider.getBalance(addr);

      await registry.connect(owner).sweepExcess();

      // Nothing moved: owner paid only gas, contract balance unchanged
      const ownerBalAfter    = await ethers.provider.getBalance(owner.address);
      const contractBalAfter = await ethers.provider.getBalance(addr);
      expect(contractBalAfter).to.equal(contractBalBefore);
      expect(ownerBalAfter).to.be.lt(ownerBalBefore); // gas only, no ETH received
      expect(contractBalAfter).to.equal(await registry.totalTracked());
    });

    it("non-owner cannot sweepExcess", async () => {
      await expect(registry.connect(stranger).sweepExcess()).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  // -- list() / listActivePage() / listPage() --------------------------------

  describe("list / listActivePage / listPage", () => {
    it("list() returns empty array when no offers", async () => {
      expect(await registry.list()).to.have.length(0);
    });

    it("list() returns only active offers", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      const offers = await registry.list();
      expect(offers).to.have.length(1);
      expect(offers[0].bundler).to.equal(bundler2.address);
    });

    it("list() filters out expired and deregistered", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await mine(MIN_LIFETIME + 1);
      const offers = await registry.list();
      expect(offers).to.have.length(0);
    });

    it("listActivePage() paginates active-only, offset=0 returns empty", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const page0 = await registry.listActivePage(0, 10);
      expect(page0).to.have.length(0);
      const page1 = await registry.listActivePage(1, 10);
      expect(page1).to.have.length(2);
    });

    it("listActivePage() beyond end returns empty", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const page = await registry.listActivePage(100, 10);
      expect(page).to.have.length(0);
    });

    it("listPage() returns all offers regardless of state, offset=0 returns empty", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      const page0 = await registry.listPage(0, 10);
      expect(page0).to.have.length(0);
      const page1 = await registry.listPage(1, 10);
      expect(page1).to.have.length(2);
    });

    it("listPage() beyond end returns empty", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const page = await registry.listPage(100, 10);
      expect(page).to.have.length(0);
    });
    it("listPage(offset, 0) returns empty array regardless of offers", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.listPage(1, 0)).to.have.length(0);
    });
    it("listActivePage(offset, 0) returns empty array regardless of offers", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.listActivePage(1, 0)).to.have.length(0);
    });
    it("listActivePage skips deregistered offers in the middle (sparse active range)", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(stranger).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      // Deregister the middle offer
      await registry.connect(bundler2).deregister(2n);
      const page = await registry.listActivePage(1, 10);
      expect(page).to.have.length(2);
      const bundlers = page.map((o: any) => o.bundler);
      expect(bundlers).to.include(bundler1.address);
      expect(bundlers).to.include(stranger.address);
      expect(bundlers).to.not.include(bundler2.address);
    });
  });

  // -- listRoutable() ---------------------------------------------------------

  describe("listRoutable", () => {
    let escrowAddr: string;

    beforeEach(async () => {
      const EscrowFactory = await ethers.getContractFactory("SLAEscrowTestable");
      const escrow = await upgrades.deployProxy(
        EscrowFactory,
        [await registry.getAddress(), owner.address],
        { kind: "uups" },
      );
      escrowAddr = await escrow.getAddress();
    });

    it("reverts when escrow is zero address", async () => {
      await expect(registry.listRoutable(ethers.ZeroAddress))
        .to.be.revertedWith("escrow is zero address");
    });

    it("returns empty when no offers are registered", async () => {
      const routable = await registry.listRoutable(escrowAddr);
      expect(routable).to.have.length(0);
    });

    it("excludes offers where bundler has no idle collateral", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const routable = await registry.listRoutable(escrowAddr);
      expect(routable).to.have.length(0);
    });

    it("includes offer when bundler has sufficient idle collateral", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      // Deposit enough collateral in the escrow so idleBalance(bundler1) >= COLLATERAL
      const escrow = await ethers.getContractAt("SLAEscrowTestable", escrowAddr);
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      const routable = await registry.listRoutable(escrowAddr);
      expect(routable).to.have.length(1);
      expect(routable[0].bundler).to.equal(bundler1.address);
    });

    it("excludes expired offer even when bundler has sufficient collateral", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const escrow = await ethers.getContractAt("SLAEscrowTestable", escrowAddr);
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await mine(MIN_LIFETIME + 1);
      const routable = await registry.listRoutable(escrowAddr);
      expect(routable).to.have.length(0);
    });

    it("excludes deregistered offer even when bundler has sufficient collateral", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      const escrow = await ethers.getContractAt("SLAEscrowTestable", escrowAddr);
      await escrow.connect(bundler1).deposit({ value: COLLATERAL });
      await registry.connect(bundler1).deregister(1n);
      const routable = await registry.listRoutable(escrowAddr);
      expect(routable).to.have.length(0);
    });

    it("reverts with InvalidEscrow when escrow address has no idleBalanceBatch", async () => {
      // Register an offer so the bundlers array is non-empty (forces the escrow call)
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      // A plain EOA has no code -- caught by the code-size pre-check
      await expect(registry.listRoutable(bundler1.address))
        .to.be.revertedWithCustomError(registry, "InvalidEscrow");
    });

    it("reverts with InvalidEscrow when idleBalanceBatch returns wrong-length array", async () => {
      // Register exactly 1 offer (bundlers.length = 1 in the staticcall)
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      // BadIdleBalanceBatch always returns 2 elements regardless of input length
      const MockFactory = await ethers.getContractFactory("BadIdleBalanceBatch");
      const mock = await MockFactory.deploy();
      // 1 input vs 2 output -> length mismatch -> InvalidEscrow
      await expect(registry.listRoutable(await mock.getAddress()))
        .to.be.revertedWithCustomError(registry, "InvalidEscrow");
    });
  });

  // -- activeCount ------------------------------------------------------------

  describe("activeCount", () => {
    it("returns 0 when registry is empty", async () => {
      expect(await registry.activeCount()).to.equal(0n);
    });

    it("increments with each registration", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.activeCount()).to.equal(1n);
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.activeCount()).to.equal(2n);
    });

    it("decrements on deregister", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      expect(await registry.activeCount()).to.equal(1n);
    });

    it("matches list().length", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler2).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      await registry.connect(bundler1).deregister(1n);
      const count  = await registry.activeCount();
      const listed = await registry.list();
      expect(count).to.equal(BigInt(listed.length));
    });

    it("returns 0 after all offers expire (time-based)", async () => {
      await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
      expect(await registry.activeCount()).to.equal(1n);
      await mine(MIN_LIFETIME + 1);
      expect(await registry.activeCount()).to.equal(0n);
    });
  });
});

// --- router.ts unit tests (pure functions, no Hardhat needed) ----------------

describe("selectBest (router)", () => {
  const makeOffer = (overrides: Partial<Offer> = {}): Offer => ({
    quoteId: 0n,
    bundler: "0xbundler",
    feePerOp: 1_000n,
    slaBlocks: 2,
    collateralWei: 10_000n,
    active: true,
    ...overrides,
  });

  it("returns null for empty list", () => {
    expect(selectBest([], "cheapest")).to.be.null;
  });

  it("returns null when all filtered out", () => {
    const offers = [makeOffer({ feePerOp: 5_000n })];
    expect(selectBest(offers, "cheapest", { maxFee: 1_000n })).to.be.null;
  });

  it("returns the single matching offer", () => {
    const o = makeOffer();
    expect(selectBest([o], "cheapest")).to.deep.equal(o);
  });

  it("picks lowest fee", () => {
    const cheap = makeOffer({ quoteId: 0n, feePerOp: 500n });
    const pricey = makeOffer({ quoteId: 1n, feePerOp: 2_000n });
    expect(selectBest([pricey, cheap], "cheapest")?.feePerOp).to.equal(500n);
  });

  it("breaks fee tie by fastest slaBlocks", () => {
    const fast = makeOffer({ quoteId: 0n, feePerOp: 500n, slaBlocks: 1 });
    const slow = makeOffer({ quoteId: 1n, feePerOp: 500n, slaBlocks: 5 });
    expect(selectBest([slow, fast], "cheapest")?.slaBlocks).to.equal(1);
  });

  it("respects maxFee filter", () => {
    const offers = [
      makeOffer({ quoteId: 0n, feePerOp: 500n }),
      makeOffer({ quoteId: 1n, feePerOp: 1_500n }),
    ];
    const result = selectBest(offers, "cheapest", { maxFee: 1_000n });
    expect(result?.feePerOp).to.equal(500n);
  });

  it("respects maxSlaBlocks filter", () => {
    const offers = [
      makeOffer({ quoteId: 0n, slaBlocks: 1 }),
      makeOffer({ quoteId: 1n, slaBlocks: 10 }),
    ];
    expect(selectBest(offers, "cheapest", { maxSlaBlocks: 3 })?.slaBlocks).to.equal(1);
  });

  it("respects minCollateral filter", () => {
    const offers = [
      makeOffer({ quoteId: 0n, feePerOp: 100n, collateralWei: 1_000n }),
      makeOffer({ quoteId: 1n, feePerOp: 200n, collateralWei: 50_000n }),
    ];
    const result = selectBest(offers, "cheapest", { minCollateral: 10_000n });
    expect(result?.quoteId).to.equal(1n);
  });

  it("skips inactive offers", () => {
    const offers = [
      makeOffer({ quoteId: 0n, active: false, feePerOp: 100n }),
      makeOffer({ quoteId: 1n, active: true,  feePerOp: 500n }),
    ];
    expect(selectBest(offers, "cheapest")?.quoteId).to.equal(1n);
  });
});
