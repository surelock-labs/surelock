// Category 6: Registry interaction attacks -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }           from "hardhat";
import { mine, setBalance }           from "@nomicfoundation/hardhat-network-helpers";
import { anyValue }                   from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
    MIN_BOND,
    MIN_LIFETIME,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");

const MAX_SLA_BLOCKS = 1000n;
const MAX_UINT96     = (1n << 96n) - 1n;
const SLA_BLOCKS     = 10;

async function deploy() {
    const [owner, bundler1, bundler2, user1, user2, feeRecipient, stranger] =
        await ethers.getSigners();

    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;

    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
        Escrow,
        [await registry.getAddress(), feeRecipient.address],
        { kind: "uups" }
    )) as unknown as SLAEscrow;

    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    return { escrow, registry, owner, bundler1, bundler2, user1, user2, feeRecipient, stranger, sg, rg };
}

async function deployWithOffer() {
    const ctx = await deploy();
    const { registry, bundler1 } = ctx;
    await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
    const QUOTE_ID = 1n;
    return { ...ctx, QUOTE_ID };
}

async function passDeadline(deadline: bigint, sg: bigint, rg: bigint) {
    const current = BigInt(await ethers.provider.getBlockNumber());
    const target = deadline + sg + rg + 1n;
    if (target > current) await mine(Number(target - current));
}

// -----------------------------------------------------------------------------
describe("Cat-6 . Registry interaction attacks", () => {

    // -- 1. deregister / ownership ------------------------------------------
    describe("deregister -- ownership checks", () => {
        it("cat6-01: stranger cannot deregister bundler1's offer", async () => {
            const { registry, bundler1, stranger } = await deployWithOffer();
            await expect(
                registry.connect(stranger).deregister(1n),
            ).to.be.revertedWithCustomError(registry, "NotOfferOwner");
        });

        it("cat6-02: bundler2 cannot deregister bundler1's offer", async () => {
            const { registry, bundler2 } = await deployWithOffer();
            await expect(
                registry.connect(bundler2).deregister(1n),
            ).to.be.revertedWithCustomError(registry, "NotOfferOwner");
        });

        it("cat6-03: NotOfferOwner carries correct quoteId and caller", async () => {
            const { registry, bundler2 } = await deployWithOffer();
            await expect(registry.connect(bundler2).deregister(1n))
                .to.be.revertedWithCustomError(registry, "NotOfferOwner")
                .withArgs(1n, bundler2.address);
        });

        it("cat6-04: deregister non-existent quoteId reverts OfferNotFound", async () => {
            const { registry, stranger } = await deploy();
            await expect(
                registry.connect(stranger).deregister(999n),
            ).to.be.revertedWithCustomError(registry, "OfferNotFound");
        });

        it("cat6-05: deregister quoteId=0 (sentinel) reverts OfferNotFound", async () => {
            const { registry, bundler1 } = await deploy();
            // quoteId 0 is the sentinel -- registeredAt == 0
            await expect(
                registry.connect(bundler1).deregister(0n),
            ).to.be.revertedWithCustomError(registry, "OfferNotFound");
        });

        it("cat6-06: owner can deregister their own offer", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            await expect(registry.connect(bundler1).deregister(1n))
                .to.emit(registry, "OfferDeactivated")
                .withArgs(1n, bundler1.address, 0);
            expect(await registry.isActive(1n)).to.be.false;
        });

        it("cat6-07: deregistering already-inactive offer reverts AlreadyDeregistered", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            await registry.connect(bundler1).deregister(1n);
            await expect(registry.connect(bundler1).deregister(1n))
                .to.be.revertedWithCustomError(registry, "AlreadyDeregistered");
        });
    });

    // -- 2. register -- validation -------------------------------------------
    describe("register -- input validation", () => {
        it("cat6-08: register with slaBlocks = 0 reverts", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, 0, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            ).to.be.revertedWith("slaBlocks must be > 0");
        });

        it("cat6-09: register with slaBlocks = MAX_SLA_BLOCKS + 1 reverts", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, Number(MAX_SLA_BLOCKS + 1n), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
        });

        it("cat6-10: register with slaBlocks = MAX_SLA_BLOCKS (boundary) succeeds", async () => {
            const { registry, bundler1 } = await deploy();
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, Number(MAX_SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, bundler1.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-11: register with slaBlocks = 1 (minimum) succeeds", async () => {
            const { registry, bundler1 } = await deploy();
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, 1, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, bundler1.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-12: register with feePerOp near type(uint96).max succeeds (collat = fee+1)", async () => {
            const { registry, bundler1 } = await deploy();
            // T8 requires collateral strictly > fee. Use fee = MAX_UINT96 - 1 so coll = fee + 1 fits.
            const fee = MAX_UINT96 - 1n;
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                registry.connect(bundler1).register(fee, 10, fee + 1n, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, bundler1.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-13: register with feePerOp = type(uint96).max + 1 reverts ValueTooLarge", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(MAX_UINT96 + 1n, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.be.revertedWithCustomError(registry, "ValueTooLarge")
                .withArgs("feePerOp", MAX_UINT96 + 1n);
        });

        it("cat6-14: register with collateralWei = type(uint96).max succeeds", async () => {
            const { registry, bundler1 } = await deploy();
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, 10, MAX_UINT96, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, bundler1.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-15: register with collateralWei = type(uint96).max + 1 reverts ValueTooLarge", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(ONE_GWEI, 10, MAX_UINT96 + 1n, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.be.revertedWithCustomError(registry, "ValueTooLarge")
                .withArgs("collateralWei", MAX_UINT96 + 1n);
        });

        it("cat6-16: register with feePerOp = 0 reverts (zero-fee offers banned)", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(0, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            ).to.be.revertedWith("feePerOp must be > 0");
        });

        it("cat6-17: register with collateralWei = 0 and fee = 0 reverts (zero-fee offers banned)", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(0, 10, 0, MIN_LIFETIME, { value: MIN_BOND }),
            ).to.be.revertedWith("feePerOp must be > 0");
        });
    });

    // -- 3. nextQuoteId / multi-registration -------------------------------
    describe("nextQuoteId and multi-registration", () => {
        it("cat6-18: nextQuoteId starts at 1", async () => {
            const { registry } = await deploy();
            expect(await registry.nextQuoteId()).to.equal(1n);
        });

        it("cat6-19: nextQuoteId increments after each registration", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            expect(await registry.nextQuoteId()).to.equal(2n);
            await registry.connect(bundler1).register(ONE_GWEI, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            expect(await registry.nextQuoteId()).to.equal(3n);
        });

        it("cat6-20: same bundler registers multiple offers, all active", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await registry.connect(bundler1).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            const active = await registry.list();
            expect(active.length).to.equal(2);
        });

        it("cat6-21: different bundlers register offers; list() returns both", async () => {
            const { registry, bundler1, bundler2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            const active = await registry.list();
            expect(active.length).to.equal(2);
            const addresses = active.map((o) => o.bundler);
            expect(addresses).to.include(bundler1.address);
            expect(addresses).to.include(bundler2.address);
        });

        it("cat6-22: deregister one offer; list() returns only the remaining active one", async () => {
            const { registry, bundler1, bundler2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 2
            await registry.connect(bundler1).deregister(1n);
            const active = await registry.list();
            expect(active.length).to.equal(1);
            expect(active[0].bundler).to.equal(bundler2.address);
        });

        it("cat6-23: re-register after deregister assigns new quoteId", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await registry.connect(bundler1).deregister(1n);
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 2
            expect(await registry.nextQuoteId()).to.equal(3n);
            expect(await registry.isActive(1n)).to.be.false;
            expect(await registry.isActive(2n)).to.be.true;
        });

        it("cat6-24: OfferRegistered event carries correct quoteId, bundler, expiry", async () => {
            const { registry, bundler1 } = await deploy();
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }))
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, bundler1.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-25: OfferDeactivated event carries correct quoteId, bundler, reason", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            await expect(registry.connect(bundler1).deregister(1n))
                .to.emit(registry, "OfferDeactivated")
                .withArgs(1n, bundler1.address, 0);
        });
    });

    // -- 4. getOffer / list edge cases -------------------------------------
    describe("getOffer and list edge cases", () => {
        it("cat6-26: getOffer on active offer returns correct struct", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            const o = await registry.getOffer(1n);
            expect(o.quoteId).to.equal(1n);
            expect(o.bundler).to.equal(bundler1.address);
            expect(await registry.isActive(1n)).to.be.true;
        });

        it("cat6-27: getOffer on inactive (deregistered) offer returns it with active=false", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            await registry.connect(bundler1).deregister(1n);
            const o = await registry.getOffer(1n);
            expect(o.bond).to.equal(0n);
            expect(o.bundler).to.equal(bundler1.address);
        });

        it("cat6-28: getOffer on non-existent quoteId returns zero struct", async () => {
            const { registry } = await deploy();
            const o = await registry.getOffer(999n);
            expect(o.bundler).to.equal(ethers.ZeroAddress);
            expect(o.bond).to.equal(0n);
            expect(o.feePerOp).to.equal(0n);
        });

        it("cat6-29: list() with zero offers returns empty array", async () => {
            const { registry } = await deploy();
            const active = await registry.list();
            expect(active.length).to.equal(0);
        });

        it("cat6-30: list(10 registered, 5 deregistered) returns 5", async () => {
            const { registry, bundler1, bundler2 } = await deploy();
            for (let i = 0; i < 10; i++) {
                await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            }
            // deregister ids 1,3,5,7,9 (quoteIds start at 1)
            for (let i = 1; i <= 10; i += 2) {
                await registry.connect(bundler1).deregister(BigInt(i));
            }
            const active = await registry.list();
            expect(active.length).to.equal(5);
        });

        it("cat6-31: list() only returns offers whose active flag is true", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // 0
            await registry.connect(bundler1).register(ONE_GWEI, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // 1
            await registry.connect(bundler1).deregister(1n);
            const active = await registry.list();
            // list() only returns active offers -- verify all have bond > 0
            expect(active.every((o) => o.bond > 0n)).to.be.true;
        });

        it("cat6-32: offer data stored exactly as registered", async () => {
            const { registry, bundler1 } = await deploy();
            const fee  = ONE_GWEI * 3n;
            const sla  = 100;
            const col  = ethers.parseEther("0.05");
            await registry.connect(bundler1).register(fee, sla, col, MIN_LIFETIME, { value: MIN_BOND });
            const o = await registry.getOffer(1n);
            expect(o.feePerOp).to.equal(fee);
            expect(o.slaBlocks).to.equal(sla);
            expect(o.collateralWei).to.equal(col);
            expect(o.bundler).to.equal(bundler1.address);
        });
    });

    // -- 5. SLAEscrow constructor with bad registry -------------------------
    describe("SLAEscrow constructor -- ZeroAddress registry", () => {
        it("cat6-33: deploy SLAEscrow with address(0) registry reverts ZeroAddress", async () => {
            const { feeRecipient } = await deploy();
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            await expect(
                upgrades.deployProxy(Escrow, [ethers.ZeroAddress, feeRecipient.address], { kind: "uups" }),
            ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
        });

        // More straightforward version
        it("cat6-33b: deploy SLAEscrow with address(0) registry reverts (direct)", async () => {
            const { escrow, feeRecipient } = await deploy();
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            await expect(
                upgrades.deployProxy(Escrow, [ethers.ZeroAddress, feeRecipient.address], { kind: "uups" })
            ).to.be.revertedWithCustomError(escrow, "ZeroAddress")
              .withArgs("registry");
        });
    });

    // -- 6. commit to deregistered offer -----------------------------------
    describe("commit -- deregistered/inactive offer", () => {
        it("cat6-34: commit to deregistered offer reverts OfferInactive", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await registry.connect(bundler1).deregister(1n);
            await expect(
                escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, 0n, SLA_BLOCKS, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive").withArgs(1n);
        });

        it("cat6-35: commit to non-existent quoteId reverts OfferInactive", async () => {
            const { escrow, user1, bundler1 } = await deploy();
            // value=1000 reverts OfferInactive -- no FeeTooSmall check exists with PROTOCOL_FEE_WEI=0
            await expect(
                escrow.connect(user1).commit(999n, ethers.randomBytes(32), bundler1.address, 0n, 1, { value: 1000n }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive").withArgs(999n);
        });
    });

    // -- 7. commit succeeds after deregister (commit already existed) -------
    describe("settle / refund after bundler deregisters", () => {
        it("cat6-36: bundler deregisters after commit; settle still works", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            const commitId = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            // bundler accepts to move to ACTIVE state
            await escrow.connect(bundler1).accept(commitId);
            // bundler deregisters AFTER commit
            await registry.connect(bundler1).deregister(1n);
            await expect(escrow.connect(bundler1).settle(commitId))
                .to.emit(escrow, "Settled")
                .withArgs(commitId, ONE_GWEI);
        });

        it("cat6-37: bundler deregisters after commit; claimRefund works after deadline", async () => {
            const { escrow, registry, bundler1, user1, sg, rg } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            const userOpHash = ethers.randomBytes(32);
            const commitId = await escrow
                .connect(user1)
                .commit.staticCall(1n, userOpHash, bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            const tx = await escrow.connect(user1).commit(1n, userOpHash, bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await tx.wait();
            // bundler accepts to move to ACTIVE state
            await escrow.connect(bundler1).accept(commitId);
            // bundler deregisters
            await registry.connect(bundler1).deregister(1n);
            // advance past deadline + grace
            const commit = await escrow.getCommit(commitId);
            await passDeadline(commit.deadline, sg, rg);
            await expect(escrow.connect(user1).claimRefund(commitId))
                .to.emit(escrow, "Refunded")
                .withArgs(commitId, ONE_GWEI + COLLATERAL);
        });

        it("cat6-38: deregistered offer; new commit by user2 reverts OfferInactive", async () => {
            const { escrow, registry, bundler1, user1, user2 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            // user1 commits successfully
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            // bundler deregisters
            await registry.connect(bundler1).deregister(1n);
            // user2 tries to commit to same (now inactive) offer
            await expect(
                escrow.connect(user2).commit(1n, ethers.randomBytes(32), bundler1.address, 0n, SLA_BLOCKS, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });
    });

    // -- 8. zero-fee offer interactions (now banned) -------------------------
    describe("zero-fee offer interactions (banned by feePerOp > 0 requirement)", () => {
        it("cat6-39: register with zero fee reverts", async () => {
            const { registry, bundler1 } = await deploy();
            await expect(
                registry.connect(bundler1).register(0, 10, 0, MIN_LIFETIME, { value: MIN_BOND }),
            ).to.be.revertedWith("feePerOp must be > 0");
        });

        it("cat6-40: minimum-fee offer (1000 wei) with non-matching ETH reverts WrongFee", async () => {
            // Use 1000 wei feePerOp to test WrongFee (commit sends wrong amount)
            const { escrow, registry, bundler1, user1 } = await deploy();
            await registry.connect(bundler1).register(1000, 10, 1001, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: 1001n });
            await expect(
                escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, 1001n, SLA_BLOCKS, { value: 1001n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(1001n, 1000n);
        });

        it("cat6-41: minimum-fee offer (1000 wei) commit succeeds with correct ETH", async () => {
            const { escrow, registry, bundler1, user1 } = await deploy();
            await registry.connect(bundler1).register(1000, 10, 1001, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: 1001n });
            const uoh = ethers.hexlify(ethers.randomBytes(32));
            const accGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                escrow.connect(user1).commit(1n, uoh, bundler1.address, 1001n, SLA_BLOCKS, { value: 1000n }),
            )
                .to.emit(escrow, "CommitCreated")
                .withArgs(0n, 1n, user1.address, bundler1.address, uoh, blockBefore + 1n + accGrace);
        });

        it("cat6-42: 1-wei fee -> commit succeeds (PROTOCOL_FEE_WEI=0, any positive feePerOp works)", async () => {
            const { escrow, registry, bundler1, user1 } = await deploy();
            await registry.connect(bundler1).register(1, 10, 2, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: 2n });
            const uoh = ethers.hexlify(ethers.randomBytes(32));
            const accGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                escrow.connect(user1).commit(1n, uoh, bundler1.address, 2n, SLA_BLOCKS, { value: 1n }),
            )
                .to.emit(escrow, "CommitCreated")
                .withArgs(0n, 1n, user1.address, bundler1.address, uoh, blockBefore + 1n + accGrace);
        });
    });

    // -- 9. cross-bundler isolation -----------------------------------------
    describe("cross-bundler isolation", () => {
        it("cat6-43: bundler2's deposit is not consumed by bundler1's commit or accept", async () => {
            const { escrow, registry, bundler1, bundler2, user1 } = await deploy();
            await setBalance(bundler2.address, ethers.parseEther("100"));
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const b2Deposited = await escrow.deposited(bundler2.address);

            // commit() then accept() -- only bundler1's collateral is locked (two-phase)
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("cat6-43-op"));
            await escrow.connect(user1).commit(1n, userOp, bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(0n);

            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
            expect(await escrow.lockedOf(bundler2.address)).to.equal(0n);
            expect(await escrow.deposited(bundler2.address)).to.equal(b2Deposited);
        });

        it("cat6-44: lockedOf is tracked per bundler independently", async () => {
            const { escrow, registry, bundler1, bundler2, user1, user2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 0
            await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            await escrow.connect(bundler2).deposit({ value: COLLATERAL });
            const commitId = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            // bundler1 accepts to lock collateral (two-phase commit design)
            await escrow.connect(bundler1).accept(commitId);
            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
            expect(await escrow.lockedOf(bundler2.address)).to.equal(0n);
        });

        it("cat6-45: bundler1 deregistering does not affect bundler2's offer", async () => {
            const { registry, bundler1, bundler2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 0
            await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await registry.connect(bundler1).deregister(1n);
            const b2Offer = await registry.getOffer(2n);
            expect(await registry.isActive(2n)).to.be.true;
            expect(b2Offer.bundler).to.equal(bundler2.address);
        });
    });

    // -- 10. WrongFee on commit ---------------------------------------------
    describe("commit -- WrongFee", () => {
        it("cat6-46: commit with too little ETH reverts WrongFee", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            await expect(
                escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI - 1n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("cat6-47: commit with too much ETH reverts WrongFee", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            await expect(
                escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI + 1n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });
    });

    // -- 11. InsufficientCollateral -----------------------------------------
    describe("commit -- InsufficientCollateral", () => {
        it("cat6-48: accept when bundler has no deposit reverts InsufficientCollateral", async () => {
            const { escrow, bundler1, user1 } = await deployWithOffer();
            // bundler deposited nothing -- commit succeeds (PROPOSED), accept fails
            const commitId = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await expect(
                escrow.connect(bundler1).accept(commitId),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("cat6-49: accept when bundler deposit is fully locked reverts InsufficientCollateral", async () => {
            const { escrow, registry, bundler1, user1, user2 } = await deploy();
            // Offer requires COLLATERAL per commit; bundler deposits exactly one COLLATERAL
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            // First commit + accept locks all collateral
            const commitId1 = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(commitId1);
            // Second commit succeeds (PROPOSED), but accept fails -- deposit fully locked
            const commitId2 = await escrow
                .connect(user2)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user2).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await expect(
                escrow.connect(bundler1).accept(commitId2),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });
    });

    // -- 12. Multiple commits on same offer ---------------------------------
    describe("multiple commits on same offer", () => {
        it("cat6-50: two users commit to same offer, both commitIds are distinct", async () => {
            const { escrow, registry, bundler1, user1, user2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
            const id1 = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            const id2 = await escrow
                .connect(user2)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user2).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            expect(id1).to.not.equal(id2);
        });

        it("cat6-51: collateral locked doubles after two commits", async () => {
            const { escrow, registry, bundler1, user1, user2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
            const commitId1 = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(commitId1);
            const commitId2 = await escrow
                .connect(user2)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user2).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(commitId2);
            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL * 2n);
        });

        it("cat6-52: after settling commit #0, collateral drops back to single lock", async () => {
            const { escrow, registry, bundler1, user1, user2 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
            const commitId0 = await escrow
                .connect(user1)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(commitId0);
            const commitId1 = await escrow
                .connect(user2)
                .commit.staticCall(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user2).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(commitId1);
            await escrow.connect(bundler1).settle(commitId0);
            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
        });
    });

    // -- 13. Offer field boundary / storage fidelity ------------------------
    describe("offer field boundary and storage fidelity", () => {
        it("cat6-53: offer with MAX_SLA_BLOCKS stored correctly", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, Number(MAX_SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
            const o = await registry.getOffer(1n);
            expect(o.slaBlocks).to.equal(MAX_SLA_BLOCKS);
        });

        it("cat6-54: offer with MAX_UINT96 - 1 feePerOp stored correctly", async () => {
            const { registry, bundler1 } = await deploy();
            // Collateral must be strictly > fee, so use fee = MAX_UINT96 - 1, collat = MAX_UINT96.
            const fee = MAX_UINT96 - 1n;
            await registry.connect(bundler1).register(fee, 10, MAX_UINT96, MIN_LIFETIME, { value: MIN_BOND });
            const o = await registry.getOffer(1n);
            expect(o.feePerOp).to.equal(fee);
        });

        it("cat6-55: offer with MAX_UINT96 collateralWei stored correctly", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(1, 10, MAX_UINT96, MIN_LIFETIME, { value: MIN_BOND });
            const o = await registry.getOffer(1n);
            expect(o.collateralWei).to.equal(MAX_UINT96);
        });

        it("cat6-56: deregistered offer quoteId field remains intact", async () => {
            const { registry, bundler1 } = await deployWithOffer();
            await registry.connect(bundler1).deregister(1n);
            const o = await registry.getOffer(1n);
            expect(o.quoteId).to.equal(1n);
        });

        it("cat6-57: SLAEscrow is initialized with the deployed registry (registry pointer before any admin update)", async () => {
            const { escrow, registry } = await deployWithOffer();
            expect(await escrow.registry()).to.equal(await registry.getAddress());
        });
    });

    // -- 14. Edge cases -- roles and event indices ---------------------------
    describe("edge cases -- roles and indices", () => {
        it("cat6-58: stranger can register their own offer", async () => {
            const { registry, stranger } = await deploy();
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                registry.connect(stranger).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }),
            )
                .to.emit(registry, "OfferRegistered")
                .withArgs(1n, stranger.address, blockBefore + 1n + BigInt(MIN_LIFETIME));
        });

        it("cat6-59: bundler's own offer after re-register appears in list", async () => {
            const { registry, bundler1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await registry.connect(bundler1).deregister(1n);
            await registry.connect(bundler1).register(ONE_GWEI * 2n, 20, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 2
            const active = await registry.list();
            expect(active.length).to.equal(1);
            expect(active[0].quoteId).to.equal(2n);
        });

        it("cat6-60: commit stores the correct quoteId inside the Commit struct", async () => {
            const { escrow, registry, bundler1, user1 } = await deploy();
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 1
            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, MIN_LIFETIME, { value: MIN_BOND }); // id 2
            await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
            const commitId = await escrow
                .connect(user1)
                .commit.staticCall(2n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            await escrow.connect(user1).commit(2n, ethers.randomBytes(32), bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI });
            const c = await escrow.getCommit(commitId);
            expect(c.quoteId).to.equal(2n);
        });
    });

    // -- freezeRegistry -- one-way ratchet (T22 + A8 trust reduction) -----------
    describe("freezeRegistry -- one-way ratchet (T22, A8)", () => {
        it("cat6-61: registryFrozen defaults to false right after deploy", async () => {
            const { escrow } = await deploy();
            expect(await escrow.registryFrozen()).to.equal(false);
        });

        it("cat6-62: setRegistry succeeds before freeze, fails after freeze (R3)", async () => {
            const { escrow, owner } = await deploy();
            // Pre-freeze: owner can update REGISTRY to a contract address
            const Reg = await ethers.getContractFactory("QuoteRegistry");
            const reg2 = await Reg.deploy(owner.address, MIN_BOND);
            const reg2Addr = await reg2.getAddress();
            await escrow.connect(owner).setRegistry(reg2Addr);
            expect(await escrow.registry()).to.equal(reg2Addr);

            // Freeze
            await escrow.connect(owner).freezeRegistry();
            expect(await escrow.registryFrozen()).to.equal(true);

            // Post-freeze: even owner cannot update -- RegistryFrozen revert (use reg2Addr, a valid contract)
            await expect(
                escrow.connect(owner).setRegistry(reg2Addr),
            ).to.be.revertedWithCustomError(escrow, "RegistryFrozen");
        });

        it("cat6-63: freezeRegistry is owner-only -- stranger cannot freeze (DoS prevention)", async () => {
            const { escrow, stranger } = await deploy();
            await expect(
                escrow.connect(stranger).freezeRegistry(),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
            // Confirm flag still false -- the failed call did not flip it
            expect(await escrow.registryFrozen()).to.equal(false);
        });

        it("cat6-64: bundler cannot freeze the registry (privilege escalation guard)", async () => {
            const { escrow, bundler1 } = await deploy();
            await expect(
                escrow.connect(bundler1).freezeRegistry(),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("cat6-65: freezeRegistry second call reverts RegistryFrozen -- one-way ratchet (R4 monotone)", async () => {
            const { escrow, owner } = await deploy();
            await escrow.connect(owner).freezeRegistry();
            expect(await escrow.registryFrozen()).to.equal(true);
            // Second call must revert -- no toggle semantics, no repeated event emission.
            await expect(
                escrow.connect(owner).freezeRegistry(),
            ).to.be.revertedWithCustomError(escrow, "RegistryFrozen");
            expect(await escrow.registryFrozen()).to.equal(true);
        });

        it("cat6-66: NO unfreeze function exists -- registryFrozen() cannot be set back to false", async () => {
            const { escrow, owner } = await deploy();
            await escrow.connect(owner).freezeRegistry();

            // No "unfreezeRegistry" or similar function should exist on the ABI.
            // We assert by enumerating all selectors and checking nothing
            // references registryFrozen as a writable target other than freezeRegistry().
            const fragments = escrow.interface.fragments
                .filter((f: any) => f.type === "function")
                .map((f: any) => f.name as string);
            // Whitelist of acceptable function names that touch registryFrozen
            expect(fragments).to.include("freezeRegistry");
            expect(fragments).to.include("registryFrozen");
            // None of these should exist
            for (const forbidden of ["unfreezeRegistry", "setRegistryFrozen", "thawRegistry"]) {
                expect(fragments).to.not.include(forbidden);
            }

            // Belt-and-braces: even calling setRegistry(currentRegistry) with the same address fails
            const currentRegistry = await escrow.registry();
            await expect(
                escrow.connect(owner).setRegistry(currentRegistry),
            ).to.be.revertedWithCustomError(escrow, "RegistryFrozen");
        });

        it("cat6-67: RegistryFrozen check fires BEFORE the zero-address check (no information leak)", async () => {
            const { escrow, owner } = await deploy();
            await escrow.connect(owner).freezeRegistry();
            // The very first check inside setRegistry is `if (registryFrozen) revert RegistryFrozen()`
            // so passing address(0) must still revert with RegistryFrozen, NOT ZeroAddress.
            await expect(
                escrow.connect(owner).setRegistry(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(escrow, "RegistryFrozen");
        });

        it("cat6-68: open commits remain settleable after freezeRegistry (A6 snapshot integrity)", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            // Bundler deposits + user creates commit
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("frozen-survives"));
            const tx = await escrow.connect(user1).commit(
                1n, userOpHash, bundler1.address, COLLATERAL, SLA_BLOCKS,
                { value: ONE_GWEI },
            );
            const rc = await tx.wait();
            const commitLogs = rc!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(commitLogs.length, "CommitCreated not emitted").to.equal(1);
            const commitId = commitLogs[0].args.commitId as bigint;
            // Bundler accepts
            await escrow.connect(bundler1).accept(commitId);

            // Now FREEZE the registry mid-life
            const { owner } = await ethers.getSigners().then(s => ({ owner: s[0] }));
            await escrow.connect(owner).freezeRegistry();

            // The commit must still settle normally -- A6: terms snapshotted at commit time
            await escrow.connect(bundler1).settle(commitId);
            const c = await escrow.getCommit(commitId);
            expect(c.settled).to.equal(true);
        });

        it("cat6-69: gas cost of freezeRegistry is bounded and reasonable (single SSTORE)", async () => {
            const { escrow, owner } = await deploy();
            const tx = await escrow.connect(owner).freezeRegistry();
            const rc = await tx.wait();
            // A single SSTORE from zero -> non-zero is ~22,100 gas + base tx + onlyOwner SLOAD ~ 51k
            // Bound it at 60k so we catch a genuine regression but tolerate normal variance.
            // T1 not directly relevant but tracks operational cost.
            expect(rc!.gasUsed).to.be.lessThan(60_000n);
        });

        it("cat6-70: freezing one escrow does not affect a separately-deployed escrow (no global state)", async () => {
            const ctxA = await deploy();
            const ctxB = await deploy();
            await ctxA.escrow.connect(ctxA.owner).freezeRegistry();
            expect(await ctxA.escrow.registryFrozen()).to.equal(true);
            // The second deployment must remain unfrozen.
            expect(await ctxB.escrow.registryFrozen()).to.equal(false);
            // And setRegistry on B must still work (use a deployed contract address)
            const Reg = await ethers.getContractFactory("QuoteRegistry");
            const reg2 = await Reg.deploy(ctxB.owner.address, MIN_BOND);
            const reg2Addr = await reg2.getAddress();
            await ctxB.escrow.connect(ctxB.owner).setRegistry(reg2Addr);
            expect(await ctxB.escrow.registry()).to.equal(reg2Addr);
        });

        it("cat6-71: slot 11 layout pin -- registryFrozen(byte0), commitsFrozen(byte1), commitsFrozenAt(bytes2-9) pack correctly", async () => {
            // Layout pin: slot 11 holds two booleans plus a uint64.
            //   byte  0 (rightmost):  registryFrozen
            //   byte  1:              commitsFrozen
            //   bytes 2-9:            commitsFrozenAt (uint64 timestamp set by freezeCommits())
            //   bytes 10-31:          zero padding
            const { escrow } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const [owner] = await ethers.getSigners();

            // Initial state: all false/zero -- slot 11 is all zeros
            const raw0 = await ethers.provider.getStorage(proxyAddr, 11);
            expect(raw0).to.equal("0x" + "00".repeat(32));

            // After freezeRegistry only: byte 0 = 0x01, commitsFrozenAt still 0
            await escrow.connect(owner).freezeRegistry();
            const raw1 = await ethers.provider.getStorage(proxyAddr, 11);
            expect(raw1).to.equal("0x" + "00".repeat(31) + "01");

            // After freezeCommits as well: byte 0 = 0x01, byte 1 = 0x01, bytes 2-9 = timestamp
            await escrow.connect(owner).freezeCommits();
            const raw2 = await ethers.provider.getStorage(proxyAddr, 11);
            const frozenAt = await escrow.commitsFrozenAt();
            // Slot 11 (big-endian hex string): 22 zero bytes | 8-byte timestamp | 0x01 | 0x01
            const expectedSlot11 = "0x" + "00".repeat(22) + frozenAt.toString(16).padStart(16, "0") + "0101";
            expect(raw2).to.equal(expectedSlot11);
            expect(frozenAt).to.be.gt(0n); // timestamp was recorded
        });
    });

    // -- freezeCommits -- upgrade-window fence (T22 enforcement) -----------------
    describe("freezeCommits -- upgrade-window fence (T22)", () => {
        it("cat6-72: commitsFrozen defaults to false after deploy", async () => {
            const { escrow } = await deploy();
            expect(await escrow.commitsFrozen()).to.equal(false);
        });

        it("cat6-73: commit() succeeds before freeze, reverts CommitsFrozen after", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });

            // Pre-freeze: commit works normally
            await escrow.connect(user1).commit(
                1n, ethers.keccak256(ethers.toUtf8Bytes("before-freeze")),
                bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI },
            );

            const [owner] = await ethers.getSigners();
            await escrow.connect(owner).freezeCommits();
            expect(await escrow.commitsFrozen()).to.equal(true);

            // Post-freeze: commit must revert CommitsFrozen
            await expect(
                escrow.connect(user1).commit(
                    1n, ethers.keccak256(ethers.toUtf8Bytes("after-freeze")),
                    bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI },
                ),
            ).to.be.revertedWithCustomError(escrow, "CommitsFrozen");
        });

        it("cat6-74: freezeCommits is owner-only -- stranger cannot freeze", async () => {
            const { escrow, stranger } = await deploy();
            await expect(
                escrow.connect(stranger).freezeCommits(),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
            expect(await escrow.commitsFrozen()).to.equal(false);
        });

        it("cat6-75: freezeCommits second call reverts CommitsFrozen -- one-way ratchet", async () => {
            const { escrow, owner } = await deploy();
            await escrow.connect(owner).freezeCommits();
            await expect(
                escrow.connect(owner).freezeCommits(),
            ).to.be.revertedWithCustomError(escrow, "CommitsFrozen");
            expect(await escrow.commitsFrozen()).to.equal(true);
        });

        it("cat6-76: existing ACTIVE commits remain settleable after freezeCommits (open commits safe)", async () => {
            const { escrow, registry, bundler1, user1 } = await deployWithOffer();
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });
            const opHash = ethers.keccak256(ethers.toUtf8Bytes("active-survives-freeze"));
            const tx = await escrow.connect(user1).commit(
                1n, opHash, bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI },
            );
            const rc = await tx.wait();
            const commitId = rc!.logs
                .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
                .map(l => escrow.interface.parseLog(l)!)[0].args.commitId as bigint;
            await escrow.connect(bundler1).accept(commitId);

            const [owner] = await ethers.getSigners();
            await escrow.connect(owner).freezeCommits();

            // settle() on the existing commit must still work
            await escrow.connect(bundler1).settle(commitId);
            expect((await escrow.getCommit(commitId)).settled).to.equal(true);
        });

        it("cat6-77: registryFrozen and commitsFrozen are independent -- freezing one does not flip the other", async () => {
            const { escrow, owner } = await deploy();
            await escrow.connect(owner).freezeRegistry();
            expect(await escrow.registryFrozen()).to.equal(true);
            expect(await escrow.commitsFrozen()).to.equal(false);

            await escrow.connect(owner).freezeCommits();
            expect(await escrow.registryFrozen()).to.equal(true);
            expect(await escrow.commitsFrozen()).to.equal(true);
        });
    });
});
