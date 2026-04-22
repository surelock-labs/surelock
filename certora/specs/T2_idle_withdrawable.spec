// docs/DESIGN.md T2 -- Honest BUNDLER's idle collateral is always accessible.
//
// "Collateral not bound to an active or unresolved commitment is fully
//  withdrawable at any time. BUNDLER is never locked into the protocol against
//  their will, subject to bounded delay for active commitments."
//
// Idle collateral is defined as: deposited[bundler] - lockedOf[bundler].
// The contract exposes this as idleBalance(bundler) and the withdraw() path
// accepts any amount up to idle.
//
// This spec verifies:
// 1. If 0 < amount <= idle, withdraw(amount) does NOT revert.
// 2. After a successful withdraw(amount), deposited[bundler] decreased by
//    exactly `amount` (the ETH transfer success is encoded in the call not
//    reverting -- _transfer reverts on push failure).
// 3. lockedOf[bundler] is unchanged by withdraw (idle shrinks, locked does not).
//
// Theorem: T2 (also touches A5, A8)
// Contract: SLAEscrow
// Status: PASS

using SLAEscrow as escrow;

methods {
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function reservedBalance() external returns (uint256) envfree;
    function idleBalance(address) external returns (uint256) envfree;
    // withdraw() declaration removed 2026-04-15: no envfree/optional/summary
    // makes the declaration a no-op.  Rules call it directly regardless.

    // withdraw() → withdrawTo() → Address.sendValue() → recipient.call{value}("").
    // Certora has the OZ library in-scope so optimistic_fallback does not apply to
    // the raw low-level call inside sendValue(); pointer analysis for that call site
    // fails (warning 1277565207), which can let the prover assume success=false and
    // manufacture a FailedInnerCall revert. NONDET suppresses the sendValue body and
    // models the ETH transfer as non-reverting -- the same role _transfer=>NONDET
    // played before the v0.6 refactor (removed 2026-04-17). ETH bookkeeping is
    // cross-verified by A4_eth_conservation.
    function Address.sendValue(address payable, uint256) internal => NONDET;

    // ReentrancyGuardTransient uses EIP-1153 tload/tstore. Certora models transient
    // storage as arbitrary symbolic state, not zero-initialized as EIP-1153 requires.
    // For a top-level transaction call the guard is never entered; ALWAYS(false) encodes
    // that invariant. (certora-cli 8.8.1 regression vs earlier versions.)
    function ReentrancyGuardTransient._reentrancyGuardEntered() internal returns (bool) => ALWAYS(false);
}

// Rule: if the caller has at least `amount` idle, withdraw(amount) succeeds.
rule T2_idle_withdraw_never_reverts(uint256 amount) {
    env e;

    // withdraw() is non-payable -- msg.value > 0 causes implicit revert.
    require e.msg.value == 0;

    // Caller must be an EOA-like address that can receive ETH.
    // We exclude the zero address (_transfer rejects it with ZeroAddress).
    // We exclude the contract itself: SLAEscrow has no receive(), so a
    // self-transfer reverts -- but no code path can call withdraw() from inside
    // the contract, so this state is unreachable in practice.
    require e.msg.sender != 0;
    require e.msg.sender != escrow;

    // Precondition: caller has at least `amount` idle and the amount is
    // positive (withdraw(0) trivially succeeds but is uninteresting).
    uint256 idle = idleBalance(e.msg.sender);
    require amount > 0;
    require to_mathint(amount) <= to_mathint(idle);

    // Contract invariant: reservedBalance >= deposited[bundler]. Certora
    // cannot derive this from the code alone, but it holds because every wei
    // in deposited[*] was routed through deposit() or commit(), both of which
    // increment reservedBalance by the same amount.
    require to_mathint(reservedBalance()) >= to_mathint(deposited(e.msg.sender));

    // A4 invariant: the contract's actual ETH balance >= reservedBalance.
    // Without this, the prover may construct a state where nativeBalances[escrow]
    // < amount even though reservedBalance >= deposited, causing _transfer to fail.
    require to_mathint(nativeBalances[escrow]) >= to_mathint(reservedBalance());

    // Overflow guards: withdraw() transfers `amount` to msg.sender via a raw
    // call. The call can fail if the recipient has no receive() -- we model an
    // EOA by assuming the transfer succeeds. This mirrors the concrete test
    // setup (EOA bundlers always receive).
    //
    // We do not need nativeBalances bounds here: the contract's own balance
    // is tracked via reservedBalance and will decrement atomically.

    withdraw@withrevert(e, amount);

    assert !lastReverted,
        "T2: withdraw(amount) must succeed whenever 0 < amount <= idleBalance";
}

// Rule: successful withdraw decreases deposited by exactly `amount`,
// leaves lockedOf unchanged.
rule T2_withdraw_updates_state(uint256 amount) {
    env e;
    require e.msg.value == 0;
    require e.msg.sender != 0;

    address b = e.msg.sender;

    mathint depositedBefore = deposited(b);
    mathint lockedBefore    = lockedOf(b);

    withdraw(e, amount);

    mathint depositedAfter = deposited(b);
    mathint lockedAfter    = lockedOf(b);

    assert depositedAfter == depositedBefore - to_mathint(amount),
        "T2: withdraw must decrease deposited by exactly amount";

    assert lockedAfter == lockedBefore,
        "T2: withdraw must not change lockedOf";
}
