// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// SLAEscrow Stateful Invariant Fuzz Tests
// ============================================================================
//
// Fuzzing strategy:
// -----------------
// A Handler contract exposes 9 guarded actions that Foundry's invariant
// fuzzer calls in random order with random arguments:
//
//   1. handler_deposit         -- bundler deposits collateral
//   2. handler_withdraw        -- bundler withdraws idle collateral
//   3. handler_commit          -- user commits a UserOp; bundler immediately accepts (ACTIVE)
//   4. handler_commitProposed  -- user commits a UserOp without bundler accepting (PROPOSED)
//   5. handler_cancel          -- authorized actor cancels a PROPOSED commit
//   6. handler_settle          -- settle an ACTIVE commit via SLAEscrowTestable (bypasses MPT)
//   7. handler_claimRefund     -- user claims refund on an expired, unfinalized commit
//   8. handler_claimPayout     -- any tracked address claims pending withdrawals
//   9. handler_rollBlocks      -- advances block.number to expire SLA deadlines
//
// Each action uses bound() to constrain fuzz inputs and returns early (no
// revert) when the current state makes the action invalid. Ghost variables
// shadow every on-chain state mutation so invariants can verify full ETH
// accounting without re-deriving state from storage.
//
// Note: handler_settle uses SLAEscrowTestable's 1-arg settle() overload which
// skips MPT proof verification. This exercises the business-logic path (state
// transitions, ETH accounting) but not the receipt-proof pipeline (covered by
// A10_inclusion_proof.spec in Certora and integration tests).
//
// Invariants verified after every fuzzer step:
//   INV-1:  deposited[b] >= lockedOf[b] for every bundler
//   INV-2:  reservedBalance == address(escrow).balance
//   INV-3:  Terminal states (settled/refunded/cancelled) are pairwise exclusive
//   INV-4:  activeCommitForHash is cleared for all finalized (settled/refunded/cancelled) commits
//   INV-5:  Ghost accounting -- sum(deposited) + sum(pendingWithdrawals) + openFees == reservedBalance
//   INV-6:  Ghost totalDeposited matches on-chain sum
//   INV-7:  Ghost totalLocked matches on-chain sum
//   INV-8:  Ghost totalPending matches on-chain sum
//   INV-9:  All terminal states (settled/refunded/cancelled) retire the hash in retiredHashes
//   INV-10: lockedOf[bundler] == sum of collateralLocked for ACTIVE (accepted && !finalized) commits only
// ============================================================================

import "forge-std/Test.sol";
import "../../contracts/QuoteRegistry.sol";
import "../../contracts/SLAEscrow.sol";
import "../contracts/SLAEscrowTestable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ---------------------------------------------------------------------------
// Helper: thin wrappers around escrow.getCommit(id) for invariant assertions.
// ---------------------------------------------------------------------------
library CommitReader {
    function getUser(SLAEscrow escrow, uint256 id) internal view returns (address) {
        return escrow.getCommit(id).user;
    }

    function getFeePaid(SLAEscrow escrow, uint256 id) internal view returns (uint96) {
        return escrow.getCommit(id).feePaid;
    }

    function getBundler(SLAEscrow escrow, uint256 id) internal view returns (address) {
        return escrow.getCommit(id).bundler;
    }

    function getCollateralLocked(SLAEscrow escrow, uint256 id) internal view returns (uint96) {
        return escrow.getCommit(id).collateralLocked;
    }

    function getDeadline(SLAEscrow escrow, uint256 id) internal view returns (uint64) {
        return escrow.getCommit(id).deadline;
    }

    function getSettled(SLAEscrow escrow, uint256 id) internal view returns (bool) {
        return escrow.getCommit(id).settled;
    }

    function getRefunded(SLAEscrow escrow, uint256 id) internal view returns (bool) {
        return escrow.getCommit(id).refunded;
    }

    function getUserOpHash(SLAEscrow escrow, uint256 id) internal view returns (bytes32) {
        return escrow.getCommit(id).userOpHash;
    }

    function getCancelled(SLAEscrow escrow, uint256 id) internal view returns (bool) {
        return escrow.getCommit(id).cancelled;
    }

    function getAccepted(SLAEscrow escrow, uint256 id) internal view returns (bool) {
        return escrow.getCommit(id).accepted;
    }

    function getAcceptDeadline(SLAEscrow escrow, uint256 id) internal view returns (uint64) {
        return escrow.getCommit(id).acceptDeadline;
    }

    function isFinalized(SLAEscrow escrow, uint256 id) internal view returns (bool) {
        SLAEscrow.Commit memory c = escrow.getCommit(id);
        return c.settled || c.refunded || c.cancelled;
    }
}

// ---------------------------------------------------------------------------
// Handler -- the fuzzer's entry point
// ---------------------------------------------------------------------------
contract SLAEscrowHandler is Test {
    using CommitReader for SLAEscrow;

    // ---- External contracts ------------------------------------------------
    SLAEscrow   public escrow;
    QuoteRegistry public registry;

    // ---- Actors ------------------------------------------------------------
    address public owner;
    address public feeRecipient;

    address public bundler0;
    address public bundler1;
    address public bundler2;

    address public user0;
    address public user1;
    address public user2;

    address[] public bundlers;
    address[] public users;
    address[] public allTracked; // every address that may have pendingWithdrawals

    // ---- Quote IDs ---------------------------------------------------------
    uint256 public quoteId0; // bundler0's offer
    uint256 public quoteId1; // bundler1's offer

    // ---- Offer params (cached for commit calls) ----------------------------
    uint128 public fee0;
    uint128 public collateral0;
    uint32  public slaBlocks0;
    uint128 public fee1;
    uint128 public collateral1;
    uint32  public slaBlocks1;

    // ---- Ghost variables ---------------------------------------------------
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalLocked;
    uint256 public ghost_totalPending;
    uint256 public ghost_openCommits;
    uint256 public ghost_openFees;      // sum of feePaid for unfinalized commits

    // ---- Open commit tracking ----------------------------------------------
    uint256[] public openCommitIds;    // ACTIVE commits (accepted; waiting for settle/refund)
    uint256[] public proposedCommitIds; // PROPOSED commits (not yet accepted; waiting for cancel/accept)

    // ---- Nonce for unique userOpHashes -------------------------------------
    uint256 private _nonce;

    // ---- Allow handler to receive ETH --------------------------------------
    receive() external payable {}

    // ========================================================================
    // Setup
    // ========================================================================

    constructor(
        SLAEscrow escrow_,
        QuoteRegistry registry_,
        address owner_,
        address feeRecipient_,
        address bundler0_,
        address bundler1_,
        address bundler2_,
        address user0_,
        address user1_,
        address user2_
    ) {
        escrow       = escrow_;
        registry     = registry_;
        owner        = owner_;
        feeRecipient = feeRecipient_;

        bundler0 = bundler0_;
        bundler1 = bundler1_;
        bundler2 = bundler2_;

        user0 = user0_;
        user1 = user1_;
        user2 = user2_;

        bundlers.push(bundler0);
        bundlers.push(bundler1);
        bundlers.push(bundler2);

        users.push(user0);
        users.push(user1);
        users.push(user2);

        // All addresses that might accumulate pendingWithdrawals
        allTracked.push(bundler0);
        allTracked.push(bundler1);
        allTracked.push(bundler2);
        allTracked.push(user0);
        allTracked.push(user1);
        allTracked.push(user2);
        allTracked.push(feeRecipient);

        // ---- Fund the handler so vm.prank calls can forward msg.value ------
        // In Foundry, vm.prank only spoofs msg.sender; the ETH for {value: X}
        // must come from the calling contract (the handler). Deal enough to
        // cover bonds + deposits.
        vm.deal(address(this), 100 ether);

        // ---- Register 2 offers (bundler0 and bundler1) ---------------------
        uint256 bond = registry.registrationBond();

        // Hoist MIN_LIFETIME() before vm.prank: Solidity evaluates arguments
        // left-to-right, so a staticcall inside the arg list would consume the
        // prank, causing register() to run with msg.sender == address(handler).
        uint32 minLt = registry.MIN_LIFETIME();

        // Offer 0: fee = 0.01 ether, slaBlocks = 10, collateral = 0.05 ether
        fee0 = 0.01 ether;
        slaBlocks0 = 10;
        collateral0 = 0.05 ether;
        vm.prank(bundler0);
        quoteId0 = registry.register{value: bond}(fee0, slaBlocks0, collateral0, minLt);

        // Offer 1: fee = 0.02 ether, slaBlocks = 20, collateral = 0.1 ether
        fee1 = 0.02 ether;
        slaBlocks1 = 20;
        collateral1 = 0.1 ether;
        vm.prank(bundler1);
        quoteId1 = registry.register{value: bond}(fee1, slaBlocks1, collateral1, minLt);

        // ---- Bundler0 deposits 1 ether collateral --------------------------
        vm.prank(bundler0);
        escrow.deposit{value: 1 ether}();
        ghost_totalDeposited += 1 ether;

        // ---- Bundler1 deposits 2 ether collateral --------------------------
        vm.prank(bundler1);
        escrow.deposit{value: 2 ether}();
        ghost_totalDeposited += 2 ether;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    function _pickBundlerWithOffer(uint256 seed)
        internal view returns (address bundler, uint256 quoteId, uint128 fee, uint128 collateral, uint32 slaBlks)
    {
        if (seed % 2 == 0) {
            return (bundler0, quoteId0, fee0, collateral0, slaBlocks0);
        } else {
            return (bundler1, quoteId1, fee1, collateral1, slaBlocks1);
        }
    }

    function _pickBundler(uint256 seed) internal view returns (address) {
        return bundlers[seed % bundlers.length];
    }

    function _pickUser(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _removeOpenCommit(uint256 idx) internal {
        uint256 last = openCommitIds.length - 1;
        if (idx != last) {
            openCommitIds[idx] = openCommitIds[last];
        }
        openCommitIds.pop();
    }

    function _removeProposedCommit(uint256 idx) internal {
        uint256 last = proposedCommitIds.length - 1;
        if (idx != last) {
            proposedCommitIds[idx] = proposedCommitIds[last];
        }
        proposedCommitIds.pop();
    }

    // ========================================================================
    // Action 1: deposit
    // ========================================================================

    /// @notice Bundler deposits collateral into the escrow.
    function handler_deposit(uint256 bundlerSeed, uint256 amount) external {
        address bundler = _pickBundler(bundlerSeed);
        amount = bound(amount, 1, 10 ether);

        vm.deal(bundler, bundler.balance + amount);
        vm.prank(bundler);
        escrow.deposit{value: amount}();

        ghost_totalDeposited += amount;
    }

    // ========================================================================
    // Action 2: withdraw
    // ========================================================================

    /// @notice Bundler withdraws idle (unlocked) collateral.
    function handler_withdraw(uint256 bundlerSeed, uint256 amount) external {
        address bundler = _pickBundler(bundlerSeed);

        uint256 idle = escrow.deposited(bundler) - escrow.lockedOf(bundler);
        if (idle == 0) return;

        amount = bound(amount, 1, idle);

        vm.prank(bundler);
        escrow.withdraw(amount);

        ghost_totalDeposited -= amount;
    }

    // ========================================================================
    // Action 3: commit
    // ========================================================================

    /// @notice User commits a UserOp against a bundler's offer.
    function handler_commit(uint256 bundlerSeed, uint256 userSeed, bytes32 /* unused */) external {
        (address bundler, uint256 quoteId, uint128 fee, uint128 collateral, uint32 slaBlks) =
            _pickBundlerWithOffer(bundlerSeed);
        address user = _pickUser(userSeed);

        if (!registry.isActive(quoteId)) return;

        // Check bundler has enough idle collateral
        uint256 idle = escrow.deposited(bundler) - escrow.lockedOf(bundler);
        if (idle < collateral) return;

        // Generate a unique userOpHash to avoid UserOpAlreadyCommitted
        bytes32 uniqueHash = keccak256(abi.encodePacked(_nonce++, block.number, user, bundler));

        // commit() requires msg.value == feePerOp + PROTOCOL_FEE_WEI.
        uint256 protocolFee = escrow.protocolFeeWei();
        uint256 totalFee    = uint256(fee) + protocolFee;

        // Ensure user has enough ETH for the full required value.
        vm.deal(user, user.balance + totalFee);

        vm.prank(user);
        uint256 commitId = escrow.commit{value: totalFee}(
            quoteId, uniqueHash, bundler, uint96(collateral), slaBlks
        );

        // Accept the commit (PROPOSED -> ACTIVE); collateral is locked at accept() time
        vm.prank(bundler);
        escrow.accept(commitId);

        // Track open commit
        openCommitIds.push(commitId);

        // Update ghosts.
        // PROTOCOL_FEE_WEI is credited to feeRecipient immediately at commit
        // time (pendingWithdrawals[feeRecipient] += PROTOCOL_FEE_WEI).
        // ghost_openFees tracks only the net feePaid stored in the Commit
        // (msg.value - PROTOCOL_FEE_WEI = feePerOp), which will move to
        // pendingWithdrawals on settle/refund.
        // ghost_totalLocked is correct here: lockedOf[bundler] increments at accept().
        ghost_totalLocked   += collateral;
        ghost_openCommits   += 1;
        ghost_openFees      += uint256(fee); // fee == feePerOp == feePaid stored
        if (protocolFee > 0) ghost_totalPending += protocolFee;

        // Advance by 1 block to separate commit blocks
        vm.roll(block.number + 1);
    }

    // ========================================================================
    // Action 4: commitProposed
    // ========================================================================

    /// @notice User commits a UserOp without BUNDLER accepting -- stays PROPOSED.
    ///         No collateral is locked (T25). Exercises the PROPOSED state and
    ///         the cancel path that handler_cancel drains.
    function handler_commitProposed(uint256 bundlerSeed, uint256 userSeed) external {
        (address bundler, uint256 quoteId, uint128 fee, uint128 collateral, uint32 slaBlks) =
            _pickBundlerWithOffer(bundlerSeed);
        address user = _pickUser(userSeed);

        if (!registry.isActive(quoteId)) return;

        // No collateral check: accept() would need idle collateral, but we skip accept here.
        bytes32 uniqueHash = keccak256(abi.encodePacked(_nonce++, block.number, user, bundler, "proposed"));

        uint256 protocolFee = escrow.protocolFeeWei();
        uint256 totalFee    = uint256(fee) + protocolFee;

        vm.deal(user, user.balance + totalFee);
        vm.prank(user);
        uint256 commitId = escrow.commit{value: totalFee}(
            quoteId, uniqueHash, bundler, uint96(collateral), slaBlks
        );

        proposedCommitIds.push(commitId);

        // feePerOp is held in the commit (openFees); protocolFee goes to feeRecipient pending.
        ghost_openFees += uint256(fee);
        if (protocolFee > 0) ghost_totalPending += protocolFee;

        vm.roll(block.number + 1);
    }

    // ========================================================================
    // Action 5: cancel
    // ========================================================================

    /// @notice Authorized actor cancels a PROPOSED commit.
    ///         CLIENT can cancel any time; BUNDLER and feeRecipient can cancel after window.
    function handler_cancel(uint256 commitSeed, uint256 actorSeed) external {
        if (proposedCommitIds.length == 0) return;

        uint256 idx      = commitSeed % proposedCommitIds.length;
        uint256 commitId = proposedCommitIds[idx];

        address user          = CommitReader.getUser(escrow, commitId);
        uint96  feePaid       = CommitReader.getFeePaid(escrow, commitId);
        uint64  acceptDeadline = CommitReader.getAcceptDeadline(escrow, commitId);

        address caller;
        if (block.number <= acceptDeadline) {
            // Within accept window: only CLIENT may cancel
            caller = user;
        } else {
            // After accept window: CLIENT, BUNDLER, or feeRecipient
            address bundler = CommitReader.getBundler(escrow, commitId);
            address[3] memory candidates = [user, bundler, feeRecipient];
            caller = candidates[actorSeed % 3];
        }

        vm.prank(caller);
        escrow.cancel(commitId);

        // feePaid returns to user via pendingWithdrawals; protocolFee already credited at commit.
        ghost_openFees    -= uint256(feePaid);
        ghost_totalPending += uint256(feePaid);

        _removeProposedCommit(idx);
    }

    // ========================================================================
    // Action 6: settle
    // ========================================================================

    /// @notice Settle an ACTIVE commit using the testable 1-arg overload (no MPT proof required).
    function handler_settle(uint256 commitSeed) external {
        if (openCommitIds.length == 0) return;

        uint256 idx = commitSeed % openCommitIds.length;
        uint256 commitId = openCommitIds[idx];

        // Check if already finalized
        if (escrow.isFinalized(commitId)) {
            _removeOpenCommit(idx);
            return;
        }

        // Read only the fields we need via the library
        uint64 deadline  = escrow.getDeadline(commitId);

        // Settlement window: must settle by deadline + SETTLEMENT_GRACE_BLOCKS
        uint64 settleDeadline = deadline + uint64(escrow.SETTLEMENT_GRACE_BLOCKS());
        if (block.number > settleDeadline) return;

        // Read remaining fields for ghost updates
        uint96 feePaid          = escrow.getFeePaid(commitId);
        uint96 collateralLocked = escrow.getCollateralLocked(commitId);

        // Settle using the testable contract (skips MPT proof, keeps guards).
        // settle() is permissionless in v0.6 -- no prank needed.
        SLAEscrowTestable(address(escrow)).settle(commitId);

        // Update ghosts
        ghost_totalLocked  -= collateralLocked;
        ghost_openCommits  -= 1;
        ghost_openFees     -= feePaid;

        // Protocol fee was credited at commit time; bundler receives 100% of feePaid.
        ghost_totalPending += uint256(feePaid);

        _removeOpenCommit(idx);
    }

    // ========================================================================
    // Action 7: claimRefund
    // ========================================================================

    /// @notice User claims a refund on an expired, unfinalized commit.
    function handler_claimRefund(uint256 commitSeed) external {
        if (openCommitIds.length == 0) return;

        uint256 idx = commitSeed % openCommitIds.length;
        uint256 commitId = openCommitIds[idx];

        // Check if already finalized
        if (escrow.isFinalized(commitId)) {
            _removeOpenCommit(idx);
            return;
        }

        // Read fields we need
        address user             = escrow.getUser(commitId);
        uint96 feePaid           = escrow.getFeePaid(commitId);
        uint96 collateralLocked  = escrow.getCollateralLocked(commitId);
        uint64 deadline          = escrow.getDeadline(commitId);

        // Roll past the full grace period
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;

        if (block.number < unlocksAt) {
            vm.roll(unlocksAt);
        }

        // Claim refund as the user
        vm.prank(user);
        escrow.claimRefund(commitId);

        // Update ghosts
        ghost_totalLocked    -= collateralLocked;
        ghost_totalDeposited -= collateralLocked; // slash removes from deposited
        ghost_openCommits    -= 1;
        ghost_openFees       -= feePaid;

        // A2: 100% slash to client -- feePaid + full collateral, no protocol cut.
        uint256 userTotal = uint256(feePaid) + uint256(collateralLocked);
        ghost_totalPending += userTotal;

        _removeOpenCommit(idx);
    }

    // ========================================================================
    // Action 8: claimPayout
    // ========================================================================

    /// @notice Any tracked address claims pending withdrawals.
    function handler_claimPayout(uint256 addrSeed) external {
        address who = allTracked[addrSeed % allTracked.length];

        uint256 pending = escrow.pendingWithdrawals(who);
        if (pending == 0) return;

        vm.prank(who);
        escrow.claimPayout();

        ghost_totalPending -= pending;
    }

    // ========================================================================
    // Action 9: roll blocks
    // ========================================================================

    /// @notice Advance block.number to let commits expire.
    function handler_rollBlocks(uint256 n) external {
        n = bound(n, 1, 300);
        vm.roll(block.number + n);
    }

    // ========================================================================
    // Getters for invariant contract
    // ========================================================================

    function openCommitCount() external view returns (uint256) {
        return openCommitIds.length;
    }

    function proposedCommitCount() external view returns (uint256) {
        return proposedCommitIds.length;
    }
}

// ---------------------------------------------------------------------------
// Invariant test contract
// ---------------------------------------------------------------------------
contract SLAEscrowInvariant is Test {
    SLAEscrowHandler public handler;
    SLAEscrow        public escrow;
    QuoteRegistry    public registry;

    address public owner;
    address public feeRecipient;

    address public bundler0;
    address public bundler1;
    address public bundler2;

    address public user0;
    address public user1;
    address public user2;

    function setUp() public {
        // Kontrol: fix block.number to a small concrete value so K does not
        // split on `block.number % 256` during vm.roll() calls in testProp_*
        // tests.  The properties proved (T8/T12/T19/A4/A10) are logically
        // independent of the specific starting block; proving them at block 1
        // is fully representative.
        vm.roll(1);

        // ---- Deterministic actor addresses ----------------------------------
        owner        = address(this);
        feeRecipient = address(0xFEE);
        bundler0     = address(0xB0);
        bundler1     = address(0xB1);
        bundler2     = address(0xB2);
        user0        = address(0xA0);
        user1        = address(0xA1);
        user2        = address(0xA2);

        // ---- Fund all actors ------------------------------------------------
        vm.deal(bundler0, 1000 ether);
        vm.deal(bundler1, 1000 ether);
        vm.deal(bundler2, 1000 ether);
        vm.deal(user0, 1000 ether);
        vm.deal(user1, 1000 ether);
        vm.deal(user2, 1000 ether);

        // ---- Deploy QuoteRegistry -------------------------------------------
        registry = new QuoteRegistry(owner, 0.001 ether);

        // ---- Deploy SLAEscrow behind UUPS proxy (using Testable for settle) -
        SLAEscrowTestable implementation = new SLAEscrowTestable();
        bytes memory initData = abi.encodeCall(
            SLAEscrow.initialize,
            (address(registry), feeRecipient)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        escrow = SLAEscrow(payable(address(proxy)));

        // ---- Activate protocol fee (test contract is owner post-initialize) -
        escrow.setProtocolFeeWei(escrow.MAX_PROTOCOL_FEE_WEI());

        // ---- Deploy handler -------------------------------------------------
        handler = new SLAEscrowHandler(
            escrow,
            registry,
            owner,
            feeRecipient,
            bundler0,
            bundler1,
            bundler2,
            user0,
            user1,
            user2
        );

        // ---- Target only the handler for fuzzing ----------------------------
        targetContract(address(handler));
    }

    // ========================================================================
    // INV-1: deposited[b] >= lockedOf[b] for every bundler
    // ========================================================================
    /// @notice Proves a bundler can never have more collateral locked than
    ///         deposited. A violation means a commit was created without
    ///         sufficient idle collateral, enabling under-collateralized SLAs.
    function invariant_depositedGeqLocked() public view {
        assertGe(
            escrow.deposited(bundler0),
            escrow.lockedOf(bundler0),
            "INV-1: bundler0 deposited < locked"
        );
        assertGe(
            escrow.deposited(bundler1),
            escrow.lockedOf(bundler1),
            "INV-1: bundler1 deposited < locked"
        );
        assertGe(
            escrow.deposited(bundler2),
            escrow.lockedOf(bundler2),
            "INV-1: bundler2 deposited < locked"
        );
    }

    // ========================================================================
    // INV-2: reservedBalance == address(escrow).balance
    // ========================================================================
    /// @notice The contract's internal bookkeeping of reserved ETH must always
    ///         equal its actual ETH balance. A mismatch means ETH was created
    ///         or destroyed without proper accounting.
    function invariant_reservedBalanceEqualsContractBalance() public view {
        assertEq(
            escrow.reservedBalance(),
            address(escrow).balance,
            "INV-2: reservedBalance != contract balance"
        );
    }

    // ========================================================================
    // INV-3: Terminal states (settled/refunded/cancelled) are pairwise exclusive
    // ========================================================================
    /// @notice A commit must reach exactly one terminal state. Any overlap is a
    ///         critical bug: settled+refunded = fee paid twice, settled+cancelled or
    ///         refunded+cancelled = collateral/fee leaked via two code paths.
    function invariant_noDoubleFinalize() public view {
        uint256 n = escrow.nextCommitId();
        for (uint256 i = 0; i < n; i++) {
            SLAEscrow.Commit memory c = escrow.getCommit(i);
            assertFalse(c.settled   && c.refunded,  "INV-3: commit both settled and refunded");
            assertFalse(c.settled   && c.cancelled, "INV-3: commit both settled and cancelled");
            assertFalse(c.refunded  && c.cancelled, "INV-3: commit both refunded and cancelled");
        }
    }

    // ========================================================================
    // INV-4: activeCommitForHash is cleared for all finalized commits
    // ========================================================================
    /// @notice Once a commit is settled, refunded, or cancelled, its userOpHash
    ///         must be cleared from activeCommitForHash. A stale true value would
    ///         permanently block that hash from being used in a new commitment.
    function invariant_activeHashClearedOnFinalize() public view {
        uint256 n = escrow.nextCommitId();
        for (uint256 i = 0; i < n; i++) {
            if (CommitReader.isFinalized(escrow, i)) {
                bytes32 userOpHash = CommitReader.getUserOpHash(escrow, i);
                assertFalse(
                    escrow.activeCommitForHash(userOpHash),
                    "INV-4: hash still active after finalize"
                );
            }
        }
    }

    // ========================================================================
    // INV-5: Master accounting identity
    //        sum(deposited) + sum(pendingWithdrawals) + openFees == reservedBalance
    // ========================================================================
    /// @notice Every wei held by the contract is either (a) in a bundler's
    ///         deposited pool, (b) in someone's pendingWithdrawals, or (c) a
    ///         fee locked in an open (unfinalized) commit. If this breaks, ETH
    ///         is untracked (stuck forever) or double-counted (phantom balance).
    ///         Catches bugs in commit/settle/refund/claimPayout/withdraw/deposit.
    function invariant_accountingIdentity() public view {
        uint256 sumDeposited = escrow.deposited(bundler0)
            + escrow.deposited(bundler1)
            + escrow.deposited(bundler2);

        uint256 sumPending = escrow.pendingWithdrawals(bundler0)
            + escrow.pendingWithdrawals(bundler1)
            + escrow.pendingWithdrawals(bundler2)
            + escrow.pendingWithdrawals(user0)
            + escrow.pendingWithdrawals(user1)
            + escrow.pendingWithdrawals(user2)
            + escrow.pendingWithdrawals(feeRecipient);

        assertEq(
            sumDeposited + sumPending + handler.ghost_openFees(),
            escrow.reservedBalance(),
            "INV-5: sum(deposited) + sum(pending) + openFees != reservedBalance"
        );
    }

    // ========================================================================
    // INV-6: Ghost totalDeposited matches on-chain sum
    // ========================================================================
    /// @notice Cross-checks the handler's ghost against actual on-chain state.
    ///         Divergence indicates a bug in either ghost tracking or contract
    ///         accounting.
    function invariant_ghostDeposited() public view {
        uint256 onChainSum = escrow.deposited(bundler0)
            + escrow.deposited(bundler1)
            + escrow.deposited(bundler2);
        assertEq(
            handler.ghost_totalDeposited(),
            onChainSum,
            "INV-6: ghost_totalDeposited != sum(deposited)"
        );
    }

    // ========================================================================
    // INV-7: Ghost totalLocked matches on-chain sum
    // ========================================================================
    /// @notice Locked must track exactly the collateral reserved for open
    ///         commits. A mismatch reveals commit/settle/refund bookkeeping bugs.
    function invariant_ghostLocked() public view {
        uint256 onChainSum = escrow.lockedOf(bundler0)
            + escrow.lockedOf(bundler1)
            + escrow.lockedOf(bundler2);
        assertEq(
            handler.ghost_totalLocked(),
            onChainSum,
            "INV-7: ghost_totalLocked != sum(lockedOf)"
        );
    }

    // ========================================================================
    // INV-8: Ghost totalPending matches on-chain sum
    // ========================================================================
    /// @notice Ensures the handler's pending-withdrawal ghost tracks the actual
    ///         sum. Divergence indicates a missed or double-counted fee/slash.
    function invariant_ghostPending() public view {
        uint256 onChainSum = escrow.pendingWithdrawals(bundler0)
            + escrow.pendingWithdrawals(bundler1)
            + escrow.pendingWithdrawals(bundler2)
            + escrow.pendingWithdrawals(user0)
            + escrow.pendingWithdrawals(user1)
            + escrow.pendingWithdrawals(user2)
            + escrow.pendingWithdrawals(feeRecipient);
        assertEq(
            handler.ghost_totalPending(),
            onChainSum,
            "INV-8: ghost_totalPending != sum(pendingWithdrawals)"
        );
    }

    // ========================================================================
    // INV-9: All terminal states (settled/refunded/cancelled) retire the hash
    // ========================================================================
    /// @notice T23: every terminal state must set retiredHashes[userOpHash] = true.
    ///         settle(), claimRefund(), and cancel() all retire the hash so the same
    ///         userOpHash cannot be recommitted in a future lifecycle.
    function invariant_finalizedHashRetired() public view {
        uint256 n = escrow.nextCommitId();
        for (uint256 i = 0; i < n; i++) {
            SLAEscrow.Commit memory c = escrow.getCommit(i);
            if (c.settled || c.refunded || c.cancelled) {
                assertTrue(
                    escrow.retiredHashes(c.userOpHash),
                    "INV-9: finalized commit's hash must be permanently retired"
                );
            }
        }
    }

    // ========================================================================
    // INV-10: lockedOf[bundler] matches sum of collateralLocked for ACTIVE commits
    // ========================================================================
    /// @notice No collateral is locked in lockedOf[] until BUNDLER explicitly calls accept() (T25).
    ///         The ghost_totalLocked tracks only ACTIVE (accepted) commits; if PROPOSED commits
    ///         were accidentally incrementing lockedOf[], INV-7 (ghost_totalLocked == sum(lockedOf))
    ///         would break. INV-10 makes the T25 connection explicit: for every bundler, lockedOf
    ///         must equal the sum of collateralLocked over their currently ACTIVE (accepted &&
    ///         !finalized) commits only.
    function invariant_lockedEqualsActiveCollateral() public view {
        uint256 n = escrow.nextCommitId();
        uint256 b0Active; uint256 b1Active; uint256 b2Active;
        for (uint256 i = 0; i < n; i++) {
            SLAEscrow.Commit memory c = escrow.getCommit(i);
            if (c.accepted && !c.settled && !c.refunded && !c.cancelled) {
                if (c.bundler == bundler0) b0Active += c.collateralLocked;
                if (c.bundler == bundler1) b1Active += c.collateralLocked;
                if (c.bundler == bundler2) b2Active += c.collateralLocked;
            }
        }
        assertEq(escrow.lockedOf(bundler0), b0Active, "INV-10: bundler0 lockedOf != sum of active collateral");
        assertEq(escrow.lockedOf(bundler1), b1Active, "INV-10: bundler1 lockedOf != sum of active collateral");
        assertEq(escrow.lockedOf(bundler2), b2Active, "INV-10: bundler2 lockedOf != sum of active collateral");
    }

    // ========================================================================
    // Kontrol testProp_* properties
    // ========================================================================
    //
    // These functions are picked up by Kontrol (symbolic execution) via the
    // testProp_ naming convention. They also run as concrete unit tests under
    // forge test. Each maps to a docs/DESIGN.md theorem.
    // ========================================================================

    // ---- T22: renounceOwnership must always revert --------------------------
    //
    // docs/DESIGN.md T22: "renounceOwnership() must be disabled on both QuoteRegistry
    // and SLAEscrow; calling it would permanently brick all admin functions."
    //
    // Expected: PASS (both contracts override renounceOwnership to revert).

    function testProp_T22_renounceReverts_escrow() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.RenounceOwnershipDisabled.selector));
        escrow.renounceOwnership();
    }

    function testProp_T22_renounceReverts_registry() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RenounceOwnershipDisabled.selector));
        registry.renounceOwnership();
    }

    function testProp_T22_renounceReverts_nonOwner_escrow() public {
        // Non-owner also cannot call (OwnableUnauthorizedAccount fires first)
        vm.prank(bundler0);
        vm.expectRevert();
        escrow.renounceOwnership();
    }

    function testProp_T22_renounceReverts_nonOwner_registry() public {
        vm.prank(bundler0);
        vm.expectRevert();
        registry.renounceOwnership();
    }

    // ---- T22 / A8: freezeRegistry one-way ratchet --------------------------
    //
    // docs/DESIGN.md T22 + A8: trust reduction roadmap allows the owner to
    // permanently lock the registry address. The "freeze" must be:
    //   (1) monotone -- once true, never false
    //   (2) effective -- setRegistry must always revert post-freeze
    //   (3) safe for open commits -- A6 snapshot integrity preserved
    //   (4) DoS-resistant -- only owner can flip it; non-owner reverts before write
    //
    // Kontrol picks these up as symbolic proofs; under forge they are also
    // concrete unit tests.

    function testProp_T22_freezeRegistry_monotone() public {
        vm.prank(owner);
        escrow.freezeRegistry();
        assertTrue(escrow.registryFrozen(), "T22: freeze must set flag");

        // Calling again must revert -- one-way ratchet, not idempotent.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("RegistryFrozen()"));
        escrow.freezeRegistry();
        assertTrue(escrow.registryFrozen(), "T22: freeze must remain true after second call");
    }

    function testProp_T22_freezeRegistry_blocksSetRegistry() public {
        vm.prank(owner);
        escrow.freezeRegistry();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.RegistryFrozen.selector));
        escrow.setRegistry(address(0xCAFE));
    }

    function testProp_T22_freezeRegistry_blocksZeroAddress() public {
        // RegistryFrozen check must fire BEFORE the zero-address check
        vm.prank(owner);
        escrow.freezeRegistry();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.RegistryFrozen.selector));
        escrow.setRegistry(address(0));
    }

    function testProp_T22_freezeRegistry_ownerOnly() public {
        // Non-owner must revert with OwnableUnauthorizedAccount
        vm.prank(bundler0);
        vm.expectRevert();
        escrow.freezeRegistry();
        // And the flag must remain false
        assertFalse(escrow.registryFrozen(), "T22: failed call must not flip flag");
    }

    function testProp_T22_freezeRegistry_storageSlotIsClean() public {
        // Slot 11 packs two booleans: registryFrozen (byte 0) and commitsFrozen (byte 1).
        // After only freezeRegistry(): byte 0 = 0x01, byte 1 = 0x00 → slot value = 1.
        vm.prank(owner);
        escrow.freezeRegistry();
        bytes32 raw = vm.load(address(escrow), bytes32(uint256(11)));
        assertEq(uint256(raw), uint256(1), "T22: slot 11 byte 0 must be 0x01 (registryFrozen), byte 1 must be 0x00 (commitsFrozen still false)");
    }

    // ---- T22: freezeCommits -- upgrade-window on-chain fence ----------------

    function testProp_T22_freezeCommits_monotone() public {
        vm.startPrank(owner);
        escrow.freezeCommits();
        assertTrue(escrow.commitsFrozen(), "T22: commitsFrozen must be true after first call");
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.CommitsFrozen.selector));
        escrow.freezeCommits();
        vm.stopPrank();
    }

    function testProp_T22_freezeCommits_blocksCommit() public {
        uint256 bond  = registry.registrationBond();
        uint32  minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(0.01 ether, 10, 0.05 ether, minLt);
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        // Freeze commits as owner
        vm.prank(owner);
        escrow.freezeCommits();

        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.CommitsFrozen.selector));
        escrow.commit{value: 0.01 ether + protocolFee}(qid, keccak256("blocked"), bundler2, 0.05 ether, 10);
    }

    function testProp_T22_freezeCommits_ownerOnly() public {
        vm.prank(user0);
        vm.expectRevert();
        escrow.freezeCommits();
        assertFalse(escrow.commitsFrozen(), "T22: commitsFrozen must not flip on non-owner call");
    }

    function testProp_T22_freezeCommits_storageSlotLayout() public {
        // Slot 11 byte layout: registryFrozen(byte0) | commitsFrozen(byte1) | commitsFrozenAt(bytes2-9)
        // After both freezes: low two bytes = 0x0101; bytes 2-9 hold the nonzero freeze timestamp.
        // Asserting the full slot would fail because commitsFrozenAt is nonzero post-freeze.
        vm.startPrank(owner);
        escrow.freezeRegistry();
        escrow.freezeCommits();
        vm.stopPrank();
        bytes32 raw = vm.load(address(escrow), bytes32(uint256(11)));
        // Mask to the two boolean bytes only.
        assertEq(uint256(raw) & 0xFFFF, uint256(0x0101), "T22: slot 11 low bytes must be 0x0101 when both booleans are set");
        // commitsFrozenAt must be packed nonzero at bytes 2-9.
        assertGt(uint64(uint256(raw) >> 16), 0, "T22: commitsFrozenAt must be packed nonzero at bytes 2-9");
    }

    // ---- T15: feeRecipient cannot be set to self or zero --------------------
    //
    // docs/DESIGN.md T15: "OWNER cannot block settlement." Setting feeRecipient to
    // address(this) would trap fees in the escrow's own pendingWithdrawals
    // forever. Setting to address(0) would revert on payout.

    function testProp_T15_feeRecipientCannotBeSelf() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.ZeroAddress.selector, "feeRecipient"));
        escrow.setFeeRecipient(address(escrow));
    }

    function testProp_T15_feeRecipientCannotBeZero() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.ZeroAddress.selector, "feeRecipient"));
        escrow.setFeeRecipient(address(0));
    }

    // ---- T12: claimRefund permissioned after expiry -------------------------
    //
    // docs/DESIGN.md T12 + A9: "After expiry, CLIENT, BUNDLER, or PROTOCOL (feeRecipient)
    // can trigger resolution." This test creates a commit, fast-forwards past the full
    // grace window, and verifies that CLIENT, BUNDLER, and feeRecipient (PROTOCOL) can
    // all trigger claimRefund. Also verifies that an unrelated third party is rejected.

    function testProp_T12_bundlerCanClaimRefundAfterExpiry() public {
        // Create a commit
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        // bundler2 registers an offer and deposits collateral
        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        // user0 commits, bundler2 accepts
        bytes32 opHash = keccak256("t12-test-op");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );
        vm.prank(bundler2);
        escrow.accept(cid);

        // Fast forward past full grace window
        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        // BUNDLER triggers claimRefund -- this should succeed (T12: bundler allowed)
        vm.prank(bundler2);
        escrow.claimRefund(cid);

        // Verify it was refunded
        assertTrue(CommitReader.getRefunded(escrow, cid), "T12: commit should be refunded");
    }

    function testProp_T12_feeRecipientCanClaimRefundAfterExpiry() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("t12-feerec-test");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );
        vm.prank(bundler2);
        escrow.accept(cid);

        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        // PROTOCOL (feeRecipient) triggers claimRefund -- allowed by T12/A9
        vm.prank(feeRecipient);
        escrow.claimRefund(cid);

        assertTrue(CommitReader.getRefunded(escrow, cid), "T12: commit should be refunded by feeRecipient");
    }

    function testProp_T12_thirdPartyRejectedAfterExpiry() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("t12-3p-test");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );
        vm.prank(bundler2);
        escrow.accept(cid);

        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        // Third party (address(0xDEAD) is not the CLIENT, BUNDLER, or PROTOCOL for this commit)
        address thirdParty = address(0xDEAD);
        vm.prank(thirdParty);
        vm.expectRevert(
            abi.encodeWithSelector(SLAEscrow.Unauthorized.selector, cid, thirdParty)
        );
        escrow.claimRefund(cid);
    }

    // ---- A4: balance equals reserved after operations -----------------------
    //
    // docs/DESIGN.md A4: "Every wei is always assigned to exactly one claimant."
    // Concretely: address(escrow).balance == escrow.reservedBalance() must hold
    // before and after any escrow operation.

    function testProp_A4_balanceEqualsReserved_afterDeposit() public {
        vm.deal(bundler2, bundler2.balance + 5 ether);
        vm.prank(bundler2);
        escrow.deposit{value: 5 ether}();

        assertEq(
            address(escrow).balance,
            escrow.reservedBalance(),
            "A4: balance != reserved after deposit"
        );
    }

    function testProp_A4_balanceEqualsReserved_afterWithdraw() public {
        // bundler0 has 1 ether deposited from setUp (via handler constructor)
        uint256 idle = escrow.deposited(bundler0) - escrow.lockedOf(bundler0);
        if (idle > 0) {
            vm.prank(bundler0);
            escrow.withdraw(idle);
        }

        assertEq(
            address(escrow).balance,
            escrow.reservedBalance(),
            "A4: balance != reserved after withdraw"
        );
    }

    function testProp_A4_balanceEqualsReserved_afterCommitAndRefund() public {
        // Setup a fresh commit and refund cycle
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 2 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 2 ether}();
        vm.stopPrank();

        // A4 check after deposit
        assertEq(address(escrow).balance, escrow.reservedBalance(), "A4: post-deposit");

        bytes32 opHash = keccak256("a4-test");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user1, user1.balance + 0.01 ether + protocolFee);
        vm.prank(user1);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        // A4 check after commit (PROPOSED state)
        assertEq(address(escrow).balance, escrow.reservedBalance(), "A4: post-commit");

        // Accept the commit (PROPOSED -> ACTIVE)
        vm.prank(bundler2);
        escrow.accept(cid);

        // A4 check after accept (ACTIVE state)
        assertEq(address(escrow).balance, escrow.reservedBalance(), "A4: post-accept");

        // Roll past grace window and refund
        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        vm.prank(user1);
        escrow.claimRefund(cid);

        // A4 check after refund
        assertEq(address(escrow).balance, escrow.reservedBalance(), "A4: post-refund");

        // Claim payouts
        uint256 pending = escrow.pendingWithdrawals(user1);
        if (pending > 0) {
            vm.prank(user1);
            escrow.claimPayout();
        }

        // A4 check after payout
        assertEq(address(escrow).balance, escrow.reservedBalance(), "A4: post-payout");
    }

    // ---- T24: setBond must reject values outside [MIN_BOND, MAX_BOND] -------
    //
    // docs/DESIGN.md T24: "Admin-configurable parameters are bounded."
    // QuoteRegistry.setBond() must enforce [MIN_BOND, MAX_BOND].

    function testProp_T24_setBondAboveMaxReverts() public {
        uint256 aboveMax = registry.MAX_BOND() + 1;
        vm.prank(owner);
        vm.expectRevert("newBond > MAX_BOND");
        registry.setBond(aboveMax);
    }

    function testProp_T24_setBondBelowMinReverts() public {
        uint256 belowMin = registry.MIN_BOND() - 1;
        vm.prank(owner);
        vm.expectRevert("newBond < MIN_BOND");
        registry.setBond(belowMin);
    }

    function testProp_T24_setBondWithinRangeSucceeds() public {
        uint256 mid = (registry.MIN_BOND() + registry.MAX_BOND()) / 2;
        vm.prank(owner);
        registry.setBond(mid);
        assertEq(registry.registrationBond(), mid, "T24: bond not set");
    }

    // ---- T8: cheating is net-negative (self-slash P&L) ----------------------
    //
    // docs/DESIGN.md T8: "Total P&L loss = collateral + netHonorFee > 0."
    // The bundler who misses the SLA loses collateralLocked from their deposit
    // and receives 0 fee. The netHonorFee they would have earned is also
    // forfeited. We verify the net change to the bundler's deposited balance
    // is strictly negative after a refund.

    function testProp_T8_selfSlashNetNegative() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        uint128 fee = 0.01 ether;
        uint128 collateral = 0.05 ether;

        vm.deal(bundler2, bundler2.balance + bond + 1 ether);
        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            fee, 10, collateral, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        uint256 depositedBefore = escrow.deposited(bundler2);

        bytes32 opHash = keccak256("t8-test");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + fee + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: fee + protocolFee}(
            qid, opHash, bundler2, uint96(collateral), 10
        );
        vm.prank(bundler2);
        escrow.accept(cid);

        // Let it expire and refund (slash path)
        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        vm.prank(user0);
        escrow.claimRefund(cid);

        uint256 depositedAfter = escrow.deposited(bundler2);

        // Bundler's deposited balance must have decreased by exactly collateral
        assertEq(
            depositedBefore - depositedAfter,
            collateral,
            "T8: bundler should lose exactly collateral from deposited"
        );
        assertTrue(depositedBefore > depositedAfter, "T8: bundler deposited must decrease");

        // The bundler also forfeits the fee they would have received (netHonorFee).
        // Combined loss = collateral + netHonorFee > 0 (always true since both > 0).
        // We verify the bundler received 0 pendingWithdrawals from this commit.
        assertEq(
            escrow.pendingWithdrawals(bundler2),
            0,
            "T8: bundler should receive nothing on slash"
        );
    }

    // -- A10: on-chain inclusion proof -----------------------------------------

    /// @notice T10/A10: settle() must revert with InclusionAfterDeadline if
    /// inclusionBlock > commitment deadline. This check fires before any MPT
    /// proof work, so no valid proof is needed to exercise this path.
    function testProp_A10_settleRevertsIfInclusionAfterDeadline() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("a10-test-op");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );
        vm.prank(bundler2);
        escrow.accept(cid);

        uint64 deadline = CommitReader.getDeadline(escrow, cid);

        // Try to settle with inclusionBlock one past the deadline.
        // Proof bytes are irrelevant -- the revert happens before proof verification.
        bytes[] memory emptyProof = new bytes[](0);
        vm.prank(bundler2);
        vm.expectRevert(
            abi.encodeWithSignature(
                "InclusionAfterDeadline(uint256,uint64,uint64)",
                cid, deadline + 1, deadline
            )
        );
        escrow.settle(cid, deadline + 1, "", emptyProof, 0);
    }

    // -- T23: cancel retires the hash ----------------------------------------

    /// @notice T23: cancel() must retire the userOpHash in retiredHashes and clear
    /// activeCommitForHash, preventing the same hash from being recommitted.
    function testProp_T23_cancelRetires() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(0.01 ether, 10, 0.05 ether, minLt);
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("t23-cancel-retires");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        assertTrue(escrow.activeCommitForHash(opHash),  "T23: hash must be active after commit");
        assertFalse(escrow.retiredHashes(opHash),       "T23: hash must not be retired before cancel");

        vm.prank(user0);
        escrow.cancel(cid);

        assertFalse(escrow.activeCommitForHash(opHash), "T23: activeCommitForHash must be cleared after cancel");
        assertTrue(escrow.retiredHashes(opHash),        "T23: hash must be permanently retired after cancel");

        // Recommitting the same hash must revert with UserOpHashRetired
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.UserOpHashRetired.selector, opHash));
        escrow.commit{value: 0.01 ether + protocolFee}(qid, opHash, bundler2, 0.05 ether, 10);
    }

    // -- T23: settle retires the hash ----------------------------------------

    /// @notice T23: settle() must retire the userOpHash in retiredHashes, preventing
    ///         double-payment via slot recycling (T1) and forcing fresh hash on retry.
    function testProp_T23_settledRetires() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(0.01 ether, 10, 0.05 ether, minLt);
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("t23-settle-retires");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        vm.prank(bundler2);
        escrow.accept(cid);

        // Use testable 1-arg settle (no MPT proof required)
        SLAEscrowTestable(address(escrow)).settle(cid);

        assertTrue(escrow.retiredHashes(opHash), "T23: hash must be permanently retired after settle");

        // Recommitting the same hash must revert with UserOpHashRetired
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.UserOpHashRetired.selector, opHash));
        escrow.commit{value: 0.01 ether + protocolFee}(qid, opHash, bundler2, 0.05 ether, 10);
    }

    // -- T23: claimRefund retires the hash -----------------------------------

    /// @notice T23: claimRefund() must retire the userOpHash in retiredHashes, forcing
    ///         a fresh hash on any retry (cannot recycle the same hash after a missed SLA).
    function testProp_T23_refundedRetires() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(0.01 ether, 10, 0.05 ether, minLt);
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        bytes32 opHash = keccak256("t23-refund-retires");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        vm.prank(bundler2);
        escrow.accept(cid);

        // Roll past deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1 (mirrors claimRefund logic)
        SLAEscrow.Commit memory c = escrow.getCommit(cid);
        uint64 unlocksAt = c.deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(uint256(unlocksAt));

        vm.prank(user0);
        escrow.claimRefund(cid);

        assertTrue(escrow.retiredHashes(opHash), "T23: hash must be permanently retired after claimRefund");

        // Recommitting the same hash must revert with UserOpHashRetired
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        vm.expectRevert(abi.encodeWithSelector(SLAEscrow.UserOpHashRetired.selector, opHash));
        escrow.commit{value: 0.01 ether + protocolFee}(qid, opHash, bundler2, 0.05 ether, 10);
    }

    // -- T25: PROPOSED commit locks no collateral ----------------------------

    /// @notice T25: no collateral is locked until BUNDLER explicitly accepts.
    /// A PROPOSED commit must leave lockedOf[bundler] and c.collateralLocked unchanged.
    function testProp_T25_proposedNoCollateral() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(0.01 ether, 10, 0.05 ether, minLt);
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        uint256 lockedBefore = escrow.lockedOf(bundler2);

        bytes32 opHash = keccak256("t25-proposed-no-collateral");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        // lockedOf must be unchanged -- the agreed collateral is snapshotted in the struct
        // but not transferred to lockedOf[] until BUNDLER calls accept().
        assertEq(escrow.lockedOf(bundler2), lockedBefore, "T25: lockedOf must not change for PROPOSED commit");

        // accepted must be false
        assertFalse(CommitReader.getAccepted(escrow, cid), "T25: commit must be PROPOSED (accepted==false)");
    }

    // -- T19: no funds permanently locked -------------------------------------

    /// @notice T19: every open commit is eventually resolvable. After the full
    /// grace window expires the BUNDLER can always call claimRefund() to free
    /// their locked collateral and settle the commitment. CLIENT inaction cannot
    /// trap funds indefinitely.
    function testProp_T19_bundlerCanFreeLockedCollateral() public {
        uint256 bond = registry.registrationBond();
        uint32 minLt = registry.MIN_LIFETIME();
        vm.deal(bundler2, bundler2.balance + bond + 1 ether);

        vm.startPrank(bundler2);
        uint256 qid = registry.register{value: bond}(
            0.01 ether, 10, 0.05 ether, minLt
        );
        escrow.deposit{value: 1 ether}();
        vm.stopPrank();

        uint256 lockedBefore = escrow.lockedOf(bundler2);

        bytes32 opHash = keccak256("t19-test-op");
        uint256 protocolFee = escrow.protocolFeeWei();
        vm.deal(user0, user0.balance + 0.01 ether + protocolFee);
        vm.prank(user0);
        uint256 cid = escrow.commit{value: 0.01 ether + protocolFee}(
            qid, opHash, bundler2, 0.05 ether, 10
        );

        // Accept the commit (PROPOSED -> ACTIVE); collateral is locked at accept() time
        vm.prank(bundler2);
        escrow.accept(cid);

        // Confirm collateral was locked
        assertTrue(
            escrow.lockedOf(bundler2) > lockedBefore,
            "T19: collateral must be locked after accept"
        );

        // Roll past full grace window
        uint64 deadline = CommitReader.getDeadline(escrow, cid);
        uint64 unlocksAt = deadline
            + uint64(escrow.SETTLEMENT_GRACE_BLOCKS())
            + uint64(escrow.REFUND_GRACE_BLOCKS())
            + 1;
        vm.roll(unlocksAt);

        // BUNDLER resolves without CLIENT cooperation (T12 + T19 combined)
        vm.prank(bundler2);
        escrow.claimRefund(cid);

        // Commit is finalized and collateral freed
        assertTrue(CommitReader.getRefunded(escrow, cid), "T19: commit must be refunded");
        assertEq(
            escrow.lockedOf(bundler2),
            lockedBefore,
            "T19: locked collateral must be fully freed after claimRefund"
        );
    }
}
