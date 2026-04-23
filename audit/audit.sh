#!/usr/bin/env bash
# Security analysis gate -- run before any mainnet deployment.
#
# Tools:
#   Slither    -- static analysis (Trail of Bits)
#   Aderyn     -- static analysis (Cyfrin)
#   Kontrol    -- symbolic execution (Runtime Verification)
#   fuzz       -- Foundry invariant suite (local, no container)
#
# Usage:
#   audit/audit.sh build              -- one-time: build the audit image (slow first time)
#   audit/audit.sh                    -- run all tools (Slither + Aderyn + Kontrol)
#   audit/audit.sh slither            -- Slither only
#   audit/audit.sh aderyn             -- Aderyn only
#   audit/audit.sh kontrol            -- Kontrol only (all testProp_* / invariant_*)
#   audit/audit.sh kontrol <filter>   -- Kontrol single property
#   audit/audit.sh fuzz               -- Foundry invariant suite (local, 256 runs x 512 depth)
#   audit/audit.sh fuzz -v            -- fuzz with verbose output
set -euo pipefail

TOOL="${1:-all}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="$REPO_ROOT/audit/reports"
WORKDIR="/workspace"
DOCKER=(sudo docker)
IMAGE="surelock-audit"

# fuzz -- local Foundry invariant suite; no container needed
if [ "$TOOL" = "fuzz" ]; then
  shift || true
  # ensure node_modules is present
  if [ ! -e "$REPO_ROOT/node_modules" ]; then
    echo "==> node_modules not found -- run 'npm install' first."
    exit 1
  fi
  # ensure forge-std is present
  if [ ! -d "$REPO_ROOT/lib/forge-std" ]; then
    echo "==> forge-std not found -- cloning..."
    mkdir -p "$REPO_ROOT/lib"
    git clone --depth 1 https://github.com/foundry-rs/forge-std.git "$REPO_ROOT/lib/forge-std"
  fi
  echo "==> Running invariant fuzz suite..."
  cd "$REPO_ROOT"
  forge clean 2>/dev/null || true
  forge test --match-path 'test/foundry/*' "$@"
  exit 0
fi

if [ "$TOOL" = "build" ]; then
  echo "==> Building audit image (slow the first time)..."
  "${DOCKER[@]}" build -f "$REPO_ROOT/audit/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
  echo "==> Audit image ready."
  exit 0
fi

echo "==> Building audit image..."
"${DOCKER[@]}" build -f "$REPO_ROOT/audit/Dockerfile" -t "$IMAGE" "$REPO_ROOT"

echo "==> Running: $TOOL..."
"${DOCKER[@]}" rm -f "$IMAGE" 2>/dev/null || true
set +e
"${DOCKER[@]}" run --name "$IMAGE" \
  -w "$WORKDIR" \
  "$IMAGE" bash audit/_inner.sh "$@"
rc=$?
set -e

echo "==> Copying reports..."
mkdir -p "$REPORT_DIR"
"${DOCKER[@]}" cp "$IMAGE:$WORKDIR/audit/reports/." "$REPORT_DIR/" 2>/dev/null || true
"${DOCKER[@]}" rm -f "$IMAGE" 2>/dev/null || true

echo ""
echo "Reports in: $REPORT_DIR/"

if [ "$rc" -ne 0 ]; then
  echo ""
  echo "==> FAIL: audit tool exited with code $rc"
  exit "$rc"
fi
