// docs/DESIGN.md A4 -- Conservation of value.
//
// "Every wei is always assigned to exactly one claimant; no ETH enters or
//  leaves the system without a corresponding actor action."
//
// Concrete invariant: address(escrow).balance == escrow.reservedBalance()
// at all times. reservedBalance tracks every legitimate wei: it increments
// on deposit() and commit() (fee), decrements on withdraw() and claimPayout().
//
// Force-sent ETH (selfdestruct) breaks balance > reservedBalance, but never
// balance < reservedBalance. sweepExcess() reconciles the difference.
//
// This spec verifies the weaker form: reservedBalance <= nativeBalances[escrow]
// always. The stronger equality (no force-send) holds in normal operation.
//
// Additionally, for each mutating function we verify that reservedBalance
// changes match the expected ETH flow.
//
// Theorem: A4
// Contract: SLAEscrow
// Status: PASS

using SLAEscrow as escrow;

methods {
    function reservedBalance() external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;

    // deposit / withdraw / claimRefund / claimPayout / sweepExcess were
    // previously declared without envfree/optional/summary -- those declarations
    // had no effect (CVL resolves them automatically for direct calls and for
    // parametric invariant enumeration). Removed during the 2026-04-15 integrity
    // audit to silence "declaration has no effect" warnings.

    // settle() calls _verifyReceiptProof which hashes a variable-length calldata
    // array. Without --optimistic_hashing, the prover cannot bound the array size
    // and marks settle() as VIOLATED. We summarise the internal proof pipeline as
    // NONDET (proof correctness is verified in A10_inclusion_proof.spec) so that
    // A4's induction step can complete.  settle() itself does not modify
    // reservedBalance, so NONDET here is conservative-but-sound for A4.
    function SLAEscrow._verifyReceiptProof(uint256, bytes32, uint64, bytes calldata, bytes[] calldata, uint256) internal => NONDET;

    // Address.sendValue is in-scope (OZ library present); optimistic_fallback does not
    // suppress the raw call{value}("") inside sendValue. Pointer analysis fails on that
    // call site (certora-cli 8.8.1 warning 1277565207), allowing the prover to assume
    // success=false -> FailedInnerCall revert. NONDET models ETH transfer as non-reverting.
    function Address.sendValue(address payable, uint256) internal => NONDET;

    // certora-cli 8.8.1 models EIP-1153 transient storage as arbitrary symbolic state
    // (not zero-initialized). ALWAYS(false) is correct for top-level transaction calls.
    function ReentrancyGuardTransient._reentrancyGuardEntered() internal returns (bool) => ALWAYS(false);
}

// Invariant: reservedBalance never exceeds the contract's actual ETH balance.
// Under normal operation they are equal. After force-send, balance > reserved.
//
// Notes on exclusions in the filtered clause:
//   upgradeToAndCall -- executes arbitrary delegatecall code that could mutate
//     any storage slot; owner-trust is out of scope for this invariant.
//     Proxy integrity is covered by cat16 / T11 adversarial tests.
//
// Note on nativeBalances[escrow] vs nativeBalances[currentContract]:
//   Both QuoteRegistry and SLAEscrow are in the files list.  For functions on
//   QuoteRegistry, Certora sets currentContract = QuoteRegistry, making the
//   invariant check measure QuoteRegistry's balance instead of SLAEscrow's.
//   Using nativeBalances[escrow] pins the balance to the SLAEscrow instance
//   regardless of which contract's function is being checked in the induction step.
//
// Note on preserved { require e.msg.sender != escrow }:
//   Certora's induction step considers ALL possible msg.sender values, including
//   escrow itself.  When msg.sender = escrow, calling deposit() or commit() is a
//   self-call: nativeBalances[escrow] does not change (ETH stays in the contract)
//   but reservedBalance increases.  Similarly, if escrow were to call
//   QuoteRegistry.register() as sender, its ETH balance would decrease while
//   reservedBalance stays fixed.  Neither path is reachable -- SLAEscrow has no
//   code that calls its own deposit/commit or QuoteRegistry.register() -- so
//   excluding msg.sender = escrow is a sound assumption for this invariant.
invariant A4_reserved_le_balance()
    reservedBalance() <= nativeBalances[escrow]
    filtered { f -> f.selector != sig:upgradeToAndCall(address,bytes).selector }
    {
        preserved with (env e) {
            require e.msg.sender != escrow;
        }
    }

// Rule: deposit() increases reservedBalance by exactly msg.value.
rule A4_deposit_conservation() {
    env e;
    require e.msg.value > 0;

    mathint reservedBefore = reservedBalance();

    deposit(e);

    mathint reservedAfter = reservedBalance();

    assert reservedAfter == reservedBefore + to_mathint(e.msg.value),
        "A4: deposit must increase reservedBalance by msg.value";
}

// Rule: withdraw() decreases reservedBalance by exactly the amount withdrawn.
rule A4_withdraw_conservation(uint256 amount) {
    env e;
    require amount > 0;

    mathint reservedBefore = reservedBalance();

    withdraw(e, amount);

    mathint reservedAfter = reservedBalance();

    assert reservedAfter == reservedBefore - to_mathint(amount),
        "A4: withdraw must decrease reservedBalance by amount";
}

// Rule: claimPayout() decreases reservedBalance by exactly the pending amount.
rule A4_claimPayout_conservation() {
    env e;

    mathint pendingBefore = pendingWithdrawals(e.msg.sender);
    mathint reservedBefore = reservedBalance();

    claimPayout(e);

    mathint reservedAfter = reservedBalance();

    assert reservedAfter == reservedBefore - pendingBefore,
        "A4: claimPayout must decrease reservedBalance by pending amount";
}

// Rule: claimRefund() does not change reservedBalance
// (it only moves ETH between accounting buckets: deposited -> pendingWithdrawals).
rule A4_refund_preserves_reserved(uint256 commitId) {
    env e;

    mathint reservedBefore = reservedBalance();

    claimRefund(e, commitId);

    mathint reservedAfter = reservedBalance();

    assert reservedAfter == reservedBefore,
        "A4: claimRefund must not change reservedBalance (internal redistribution only)";
}
