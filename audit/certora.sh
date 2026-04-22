#!/usr/bin/env bash
# Run all Certora rules in certora/conf/ and print a summary table.
# Usage:
#   audit/certora.sh                  # run all rules
#   audit/certora.sh T8_collateral    # run rules whose conf name contains the argument
#
# The CERTORAKEY env var must be set before calling this script.
# API key is picked up by certoraRun automatically -- this script never reads any env file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # repo root
CONF_DIR="$REPO_ROOT/certora/conf"

# certoraRun is installed via pipx -- already on PATH, no venv needed.
if ! command -v certoraRun &>/dev/null; then
  echo "ERROR: certoraRun not found. Install with: pipx install certora-cli" >&2
  exit 1
fi

FILTER="${1:-}"

if [ -z "${CERTORAKEY:-}" ]; then
  echo "ERROR: CERTORAKEY is not set. Export your Certora API key before running." >&2
  exit 1
fi

# Locate solc from Hardhat's compiler cache -- no solc-select needed.
SOLC_BIN=$(find "$HOME/Library/Caches/hardhat-nodejs/compilers-v2" \
           "$HOME/.cache/hardhat-nodejs/compilers-v2" \
           -name "solc-*0.8.24*" -type f 2>/dev/null | head -1 || true)
if [ -z "$SOLC_BIN" ]; then
  echo "ERROR: could not find solc 0.8.24 in Hardhat cache. Run 'npx hardhat compile' first." >&2
  exit 1
fi
export SOLC_BIN

confs=()
while IFS= read -r -d '' f; do
  confs+=("$f")
done < <(find "$CONF_DIR" -name "*.conf" -print0 | sort -z)

if [ ${#confs[@]} -eq 0 ]; then
  echo "No .conf files found in $CONF_DIR -- nothing to run."
  exit 0
fi

# Filter if argument provided
if [ -n "$FILTER" ]; then
  filtered=()
  for f in "${confs[@]}"; do
    [[ "$(basename "$f")" == *"$FILTER"* ]] && filtered+=("$f")
  done
  confs=("${filtered[@]}")
  if [ ${#confs[@]} -eq 0 ]; then
    echo "No .conf files match filter '$FILTER'." >&2
    exit 1
  fi
fi

declare -a names statuses times links
any_fail=0

# certoraRun resolves conf-file paths (contracts/, certora/specs/, node_modules/) relative
# to CWD -- must run from repo root.
cd "$REPO_ROOT"

# Use a temp dir to track parallel jobs (bash 3.2-compatible -- no associative arrays).
JOB_DIR=$(mktemp -d)
trap 'rm -rf "$JOB_DIR"' EXIT

# Submit all rules in parallel
for conf in "${confs[@]}"; do
  name="$(basename "$conf" .conf)"
  out="$JOB_DIR/$name.out"
  echo $SECONDS > "$JOB_DIR/$name.start"
  echo "-- Submitting: $name"
  (
    set +e
    certoraRun "$conf" --solc "$SOLC_BIN" --disable_local_typechecking --wait_for_results all > "$out" 2>&1
    echo $? > "$JOB_DIR/$name.exit"
  ) &
  echo $! > "$JOB_DIR/$name.pid"
done

echo ""
echo "-- Waiting for ${#confs[@]} rules to complete..."

for conf in "${confs[@]}"; do
  name="$(basename "$conf" .conf)"
  pid=$(cat "$JOB_DIR/$name.pid")
  wait "$pid"
  start=$(cat "$JOB_DIR/$name.start")
  elapsed=$(( SECONDS - start ))
  exit_code=$(cat "$JOB_DIR/$name.exit" 2>/dev/null || echo 1)
  output=$(cat "$JOB_DIR/$name.out")

  link=$(echo "$output" | grep -oE 'https://prover\.certora\.com/output/[^ ]+' | tail -1 || true)
  [ -z "$link" ] && link="-"

  if [ "$exit_code" -eq 0 ]; then
    status="PASS"
  else
    status="FAIL"
    any_fail=1
    echo ""
    echo "-- FAILED: $name --"
    echo "$output"
  fi

  names+=("$name")
  statuses+=("$status")
  times+=("${elapsed}s")
  links+=("$link")
done

# Summary table
echo ""
echo "=============================================================="
echo " Certora summary"
echo "=============================================================="
printf "%-40s %-6s %-6s %s\n" "Rule" "Status" "Time" "Report"
printf "%-40s %-6s %-6s %s\n" "----------------------------------------" "------" "------" "------"
for i in "${!names[@]}"; do
  printf "%-40s %-6s %-6s %s\n" "${names[$i]}" "${statuses[$i]}" "${times[$i]}" "${links[$i]}"
done
echo "=============================================================="

exit $any_fail
