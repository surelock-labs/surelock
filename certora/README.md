# Certora Prover

Certora runs CVL (Certora Verification Language) rules against the compiled Solidity bytecode,
providing machine-checked proofs of the theorems in `docs/DESIGN.md`. Unlike fuzz tests that sample
inputs, Certora reasons over all possible inputs and storage states. Each rule in `specs/` maps
to one or more docs/DESIGN.md axioms or theorems -- the header comment in each file names the theorem.

## Prerequisites

- `CERTORAKEY` environment variable set to your API key
- `certoraRun` available: `source scripts/venv.sh`
- `solc` available (install via `solc-select`: `pip install solc-select && solc-select install 0.8.24 && solc-select use 0.8.24`)

## Running rules

Run a single rule:
```sh
scripts/venv.sh certoraRun --conf certora/conf/T8_collateral_strict.conf
```

Run all rules (summary table printed at the end):
```sh
audit/certora.sh
```

Run via venv wrapper (no prior activation needed):
```sh
scripts/venv.sh audit/certora.sh
```

## Directory layout

```
certora/
  specs/      CVL rule files, one per theorem cluster (e.g. T8_collateral_strict.spec)
  harness/    Solidity harnesses exposing internals the prover needs (add only when necessary)
  conf/       .conf files pinning options per rule run (one per spec file)
  README.md   This file
```

## Reading failures

When a rule fails, Certora returns a link to a web report. Key places to look:

1. **Call trace** -- the exact sequence of calls that produced the counter-example
2. **Variables panel** -- storage state at each step; look for the invariant violation
3. **Split log** -- if the rule was split into sub-problems, check which sub-problem failed
4. **Counter-example values** -- Certora will show concrete values for all symbolic inputs

All 14 specs currently PASS -- see `STATUS.md` for the latest run results and job links.

## References

- [Certora user guide](https://docs.certora.com/en/latest/docs/user-guide/index.html)
- [CVL language reference](https://docs.certora.com/en/latest/docs/cvl/index.html)
- `docs/DESIGN.md` -- behavioral reference (theorems and axioms rules map to)
- `STATUS.md` -- PASS results table, NONDET justifications, run configuration
