#!/usr/bin/env bash
# Runs INSIDE the audit container OR directly on CI.
# Self-locates so it works regardless of the calling directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # audit/
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"                    # repo root
REPORT_DIR="$SCRIPT_DIR/reports"
cd "$REPO_ROOT"

TOOL=${1:-all}
mkdir -p "$REPORT_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)

run_slither() {
  echo "==> Slither"
  npx hardhat compile --quiet

  slither . \
    --fail-low \
    --hardhat-artifacts-directory artifacts \
    --exclude-dependencies \
    --filter-paths "test/" \
    --compile-force-framework hardhat \
    --json "$REPORT_DIR/slither_${TIMESTAMP}.json" \
    2>&1 | tee "$REPORT_DIR/slither_${TIMESTAMP}.txt"
}

run_aderyn() {
  echo "==> Aderyn"

  aderyn . \
    --src contracts \
    --output "$REPORT_DIR/aderyn_${TIMESTAMP}.md" \
    2>&1 | tee "$REPORT_DIR/aderyn_${TIMESTAMP}.txt"

  if [ -f "$REPORT_DIR/aderyn_${TIMESTAMP}.md" ]; then
    cat "$REPORT_DIR/aderyn_${TIMESTAMP}.md"
  fi
}

run_kontrol() {
  local test="${2:-}"
  echo "==> Kontrol"
  # forge clean removes the Hardhat-format solidity-files-cache.json that
  # otherwise corrupts Foundry's cache, causing forge build to skip writing
  # artifacts to out/ -- which leaves kontrol build with nothing to process.
  forge clean 2>/dev/null || true
  kontrol build

  if [ -z "$test" ]; then
    kontrol prove --match-test 'testProp_' \
      2>&1 | tee "$REPORT_DIR/kontrol_${TIMESTAMP}.txt"
  else
    kontrol prove --match-test "$test" \
      2>&1 | tee "$REPORT_DIR/kontrol_${TIMESTAMP}.txt"
  fi
}

case "$TOOL" in
  slither)  run_slither ;;
  aderyn)   run_aderyn ;;
  kontrol)  run_kontrol "$@" ;;
  all)
    run_slither
    run_aderyn
    run_kontrol
    ;;
  *)
    echo "Usage: $0 [slither|aderyn|kontrol|all] [kontrol-test-filter]"
    exit 1
    ;;
esac
