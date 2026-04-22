# Certora spec status

## Summary

SureLock's core protocol properties are mechanically verified with Certora under explicit modeling assumptions, and complemented by Foundry/Kontrol tests where Certora's model of BLOCKHASH, transient storage, or proof-library internals makes direct proof impractical.

The receipt-proof pipeline is treated as an audited primitive; Certora verifies the structural settlement guards around it.

**What this package proves:** core economic correctness (T1, T4, A2), ETH conservation (A4), bundler consent / no collateral lock before accept (T25), authority windows and bounded resolution (A9, T12, T19), fee snapshot and anti-bait-and-switch (T5, T9), hash uniqueness and retirement (T23), governance-latch monotonicity (T22 cluster), admin-bounds closure (T24), and anti-self-commit / strict collateral economics (T8 cluster).

**What this package does not claim:** full MPT/RLP receipt-proof correctness (audited primitive), BLOCKHASH-driven liveness in Certora (covered by Kontrol), monotonicity across `upgradeToAndCall` (intended governance escape hatch behind 48h timelock), or retirement guarantees for legacy pre-upgrade cancelled/refunded hashes (DESIGN.md T23 upgrade boundary).

**PASS means** "proved under the stated summaries and loop bounds, not that every line of the underlying proof libraries was symbolically verified."

---

Last full run: 2026-04-19. All 27 specs PASS within their stated modeling assumptions and summaries (see scope notes below).

| Spec | Result | Job |
|------|--------|-----|
| `A4_eth_conservation` | **PASS** [3] | [f48c3a76](https://prover.certora.com/output/5373370/f48c3a762ac947df8be8836094a19a7e) |
| `A10_settle_structural_guards` | **PASS** [1] | [ed46da1c](https://prover.certora.com/output/5373370/ed46da1cc8eb412891cac7174ef08a9c) |
| `T2_idle_withdrawable` | **PASS** [3] | [32dc6db9](https://prover.certora.com/output/5373370/32dc6db9ad78445ead5761d4c9effa10) |
| `T8_cheating_net_negative` | **PASS** | [d72b4f3a](https://prover.certora.com/output/5373370/d72b4f3a89c64016821582a82ff19147) |
| `T8_collateral_strict` | **PASS** | [ec66c938](https://prover.certora.com/output/5373370/ec66c93838b141e299ff56cb6f24063e) |
| `T9_offer_identity` | **PASS** | [2d1d5174](https://prover.certora.com/output/5373370/2d1d5174a4554e5ca677c838e67ab478) |
| `T12_no_capital_lock` | **PASS** | [1287c062](https://prover.certora.com/output/5373370/1287c0620e8c490cb9003c204bf917a6) |
| `T15_fee_recipient_valid` | **PASS** | [51186fa6](https://prover.certora.com/output/5373370/51186fa651e04d4e8920ae6bad221300) |
| `T19_liveness` | **PASS** | [601a162b](https://prover.certora.com/output/5373370/601a162b1f42492e8bf378c998608241) |
| `T22_renounce_disabled` | **PASS** | [a7f44631](https://prover.certora.com/output/5373370/a7f44631ec7a410289eec50796104790) |
| `T22_renounce_disabled_registry` | **PASS** | [8f3ae8f4](https://prover.certora.com/output/5373370/8f3ae8f46ecc4580b185cf2b4989dc4a) |
| `T22_registry_freeze` | **PASS** [5] | [1a53ce95](https://prover.certora.com/output/5373370/1a53ce95dddb4bed90406d5d22b0c661) |
| `T23_hash_uniqueness` | **PASS** | [7293766d](https://prover.certora.com/output/5373370/7293766d78ba4fe4a5327c2122c05d47) |
| `T24_parameter_setter_bounds` | **PASS** [2] | [465fffca](https://prover.certora.com/output/5373370/465fffcaf5bc4d62973e8fbcf1351c9f) |
| `T23_terminal_hash_retirement` | **PASS** | [e5c7c9f6](https://prover.certora.com/output/5373370/e5c7c9f6a9c945ae82ab13543d058f83) |
| `T25_bundler_consent` | **PASS** | [435de8bc](https://prover.certora.com/output/5373370/435de8bc5ee848b580cbcfe328e4a44b) |
| `A4_commit_accounting` | **PASS** | [41a634d4](https://prover.certora.com/output/5373370/41a634d461774592a16859cfb6285024) |
| `T22_freeze_commits` | **PASS** | [ec23d796](https://prover.certora.com/output/5373370/ec23d796295f486b961c47652d527143) |
| `T22_freeze_commits_non_pause` | **PASS** [3] | [72aa77a1](https://prover.certora.com/output/5373370/72aa77a1d151459eae9ddfd5272332b9) |
| `A6_admin_no_effect_on_open_commits` | **PASS** | [2534571b](https://prover.certora.com/output/5373370/2534571b69b343daa9d121e4f2f6420b) |
| `T8_self_commit_forbidden` | **PASS** | [3e7bbcd2](https://prover.certora.com/output/5373370/3e7bbcd2f67a436e9dd38d186cf6e868) |
| `T4_cancel_exact_payout` | **PASS** | [dda8e1b5](https://prover.certora.com/output/5373370/dda8e1b578a54d728c7394fa7f69e83e) |
| `T1_settle_pays_full_fee` | **PASS** | [a3ecb657](https://prover.certora.com/output/5373370/a3ecb657436b4be2b576afade2fe56b3) |
| `A2_refund_exact_payout` | **PASS** | [fbc0f788](https://prover.certora.com/output/5373370/fbc0f7884fbb4e1ab4973523b21e5c67) |
| `A9_resolution_authority_windows` | **PASS** | [be643478](https://prover.certora.com/output/5373370/be643478015f46e59fc70b0fef3e0520) |
| `T5_fee_snapshot` | **PASS** | [fe091397](https://prover.certora.com/output/5373370/fe091397609c478cadda2ddabdb4b284) |
| `A9_permissionless_settle` | **PASS** [4] | [651be81a](https://prover.certora.com/output/5373370/651be81a60b1485588b606bac028dde7) |

[1] **A10 scope** (`A10_settle_structural_guards`): structural guards only (deadline, grace
  window bounds). Full MPT/RLP receipt proof is ASSUMED AUDITED (external library).
  Blockhash freshness (BlockHashUnavailable path) is covered by concrete boundary tests
  in SLAEscrowSettle.test.ts (256-block window edges).
  See spec header for complete rationale.

[2] **T24 scope** (`T24_parameter_setter_bounds`): numeric setter bounds only (max fee,
  max SLA). Other T24 sub-claims: feeRecipient validity -> T15; registry freeze ->
  T22_registry_freeze; no mutation of open commits -> A6_admin_no_effect_on_open_commits.
  Together these specs close T24 completely.

[3] **A4 / T2 / T22_freeze_commits_non_pause (NP4) scope**: `Address.sendValue => NONDET` and
  `ReentrancyGuardTransient._reentrancyGuardEntered() => ALWAYS(false)` summaries added.
  `Address.sendValue` is in-scope (OZ library); `optimistic_fallback` does not cover its
  internal `call{value}("")` -- pointer analysis fails on that call site (certora-cli 8.8.1),
  allowing the prover to manufacture a `FailedInnerCall` revert. NONDET models the ETH
  transfer as non-reverting. `_reentrancyGuardEntered() => ALWAYS(false)` models EIP-1153
  transient-storage zero-initialization for top-level calls; correct because all rules model
  a single top-level transaction. A4's `A4_reserved_le_balance` invariant requires both
  summaries because its induction step enumerates all ETH-sending functions. NONDET replaces
  the old `_transfer => NONDET` pattern (removed 2026-04-17 after v0.6 refactor).

[5] **T22_registry_freeze R3b scope** (2026-04-19): two preconditions added to
  `R3b_setRegistry_succeeds_when_unfrozen`: `require newRegistry != registry()` (excludes
  `RegistryAlreadySet` revert -- line 328 of SLAEscrow.sol) and
  `SLAEscrow._validateRegistry(address) internal => NONDET` (excludes reverts from the
  interface-fingerprint / governance-alignment staticcalls to the symbolic `newRegistry`).
  R3b's claim is "the `registryFrozen` guard alone does not block `setRegistry()` when
  false" -- not "any address passes full validation". These preconditions match that stated
  scope exactly. The April 2026-04-15 PASS was a cache hit; fresh run exposed the violation.

[4] **A9_permissionless_settle scope**: liveness rule (`settle() CAN succeed for a
  third-party caller`) removed -- unprovable in Certora because `settle()` checks
  `blockhash(inclusionBlock) != 0` before `_verifyReceiptProof`, and Certora models
  `BLOCKHASH` as a fully symbolic bytes32 (same limitation as A10; see A10 spec header).
  The retained rule proves payout routing: feePaid always routes to snapshotted
  `c.bundler` regardless of caller. Liveness is covered by T19_liveness and Kontrol.

### Note: T22_registry_freeze R4 and `upgradeToAndCall`

R4 (`frozen_stays_frozen`) is VERIFIED with `upgradeToAndCall` filtered from parametric enumeration. The UUPS upgrade path can write arbitrary storage via `delegatecall`, which is the expected governance escape hatch -- protected by the 48h `TimelockController`. The one-way ratchet holds for all normal protocol operations. Same filter applies to T23_terminal_hash_retirement `T23_retired_hash_monotone` and T22_freeze_commits F3.

### NONDET summaries

`_verifyReceiptProof => NONDET` is used in specs that reach `settle()` (A4, A10, T1, T22_registry_freeze, T22_freeze_commits, T23, A6, A9_permissionless_settle). The function is an internal view with no storage writes -- NONDET cannot manufacture false PASSes.

`Address.sendValue => NONDET` is used in A4, T2, and T22_freeze_commits_non_pause (NP4). The OZ library is in-scope so `optimistic_fallback` does not suppress the raw `call{value}("")` inside `sendValue`; pointer analysis for that site fails under certora-cli 8.8.1. NONDET models the ETH transfer as non-reverting -- same role as the old `_transfer => NONDET` summary (removed 2026-04-17 after v0.6 refactor).

`ReentrancyGuardTransient._reentrancyGuardEntered() => ALWAYS(false)` is used in A4, T2, and T22_freeze_commits_non_pause. Certora models EIP-1153 transient storage as arbitrary symbolic state (not zero-initialized per spec), allowing the guard to appear entered at rule start. For top-level transaction calls -- the only scenario modelled -- the guard is never entered.

`SLAEscrow._validateRegistry(address) => NONDET` is used in T22_registry_freeze (R3b only). Prevents the prover from reverting via the interface-fingerprint / governance-alignment staticcalls to a symbolic `newRegistry` address. See footnote [5].

### Scope notes

- **PASS means "proved under the stated summaries and loop bounds"**, not "every line of the underlying proof libraries was symbolically verified."
- **A4 conservation (weak form)**: the proved invariant is `reservedBalance <= contract balance`. Force-sent ETH (e.g. via selfdestruct) creates a temporary surplus (`balance > reservedBalance`) that `sweepExcess()` queues; this is out-of-band and does not violate the invariant. The design axiom's strong equality claim holds in normal operation but is not directly proved here.
- **`A10_settle_structural_guards`** verifies structural settle-path guards (`InclusionAfterDeadline`, `DeadlinePassed`, window non-overlap properties). It does **not** machine-prove the full MPT/RLP receipt-verification pipeline; that pipeline is an audited primitive covered by `_verifyReceiptProof => NONDET`.
- **`T23_hash_uniqueness`** covers `commit`, `settle`, and `claimRefund` active-hash behavior. The `cancel()` retirement path is covered in `T23_terminal_hash_retirement` and also exercised by Foundry/Kontrol tests.
- **T23 upgrade boundary**: T23's permanent-retirement guarantee applies to commitments finalized under the current logic. Legacy cancelled/refunded hashes from before this version are not retroactively retired (see DESIGN.md T23 upgrade note).

### Configuration

All specs use `optimistic_loop: true, loop_iter: 1`. No state-mutating loops exist on exercised paths; MPT loops are behind NONDET summaries.

`rule_sanity: none` in: T22_registry_freeze (R4 vacuous for `commit()` variant), T22_freeze_commits (F3 same reason), T23_terminal_hash_retirement (T23_retired_hash_monotone and combined-path rules: `commit()` always reverts when hash retired).

### Theorem coverage map

| Theorem | Certora spec(s) | Note |
|---------|----------------|------|
| A2 refund exact payout | `A2_refund_exact_payout` | feePaid+collateral to CLIENT; deposited slashed; bundler gets nothing |
| A4 ETH conservation | `A4_eth_conservation`, `A4_commit_accounting` | commit() accounting complete; 14-field PROPOSED snapshot |
| A6 admin cannot mutate commits | `A6_admin_no_effect_on_open_commits`, `T22_registry_freeze` R1 | all 5 admin functions covered |
| A9 resolution authority | `A9_resolution_authority_windows` | cancel W1-W6; claimRefund W7-W9 |
| A9 permissionless settle | `A9_permissionless_settle`, `T1_settle_pays_full_fee` | payout routing; liveness via T19 + Kontrol |
| A10 settlement proof | `A10_settle_structural_guards` (structural), Hardhat boundary tests (blockhash), ASSUMED (MPT libs) | |
| T1 settle pays full fee | `T1_settle_pays_full_fee` | feePaid to bundler; lockedOf freed; deposited unchanged |
| T2 idle withdrawable | `T2_idle_withdrawable` | withdraw never reverts when idle >= amount |
| T4 cancel payout | `T4_cancel_exact_payout` | feePaid to CLIENT; bundler unchanged; window auth |
| T5 fee snapshot | `T5_fee_snapshot` | feePaid = msg.value - protocolFee; immutable after commit |
| T8 anti-sybil / collateral | `T8_cheating_net_negative`, `T8_collateral_strict`, `T8_self_commit_forbidden` | |
| T22 governance latches | `T22_renounce_disabled`, `T22_renounce_disabled_registry`, `T22_registry_freeze`, `T22_freeze_commits`, `T22_freeze_commits_non_pause` | |
| T23 hash retirement | `T23_hash_uniqueness`, `T23_terminal_hash_retirement` | combined-path invariants + monotone ratchet |
| T24 admin bounds | `T24_parameter_setter_bounds` + T15 + T22_registry_freeze + A6 | numeric ranges only in this spec; see [2] |
| T25 bundler consent | `T25_bundler_consent`, `A4_commit_accounting` (lockedOf) | full two-phase proof |
