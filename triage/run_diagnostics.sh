#!/usr/bin/env bash
set -euo pipefail

# Lightweight triage and diagnostics script
# Usage: bash triage/run_diagnostics.sh

echo "---- TRIAGE DIAGNOSTICS SUMMARY ----"

echo "Repository: $(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "Branch: ${BRANCH}"
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "none")
echo "Commit: ${COMMIT}"

echo "\n--- Git status ---"
git status --porcelain || true

echo "\n--- Recent commits (5) ---"
git log --oneline -n 5 || true

echo "\n--- Changed files in last commit (if present) ---"
LAST_COMMIT=$(git rev-parse HEAD || echo '')
if [ -n "${LAST_COMMIT}" ]; then
  git show --name-only --pretty=format:"" ${LAST_COMMIT} | sed -n '1,200p' || true
fi

echo "\n--- Placeholder check (functions) ---"
PLACEHOLDER_COUNT=$(git grep -n "Note: This is a placeholder" -- 'functions/**' 2>/dev/null | wc -l || echo 0)
PLACEHOLDER_COUNT=${PLACEHOLDER_COUNT//[^0-9]/}
echo "Found ${PLACEHOLDER_COUNT} placeholder files under functions/"

if (( PLACEHOLDER_COUNT > 0 )); then
  echo "Listing sample placeholder files:"
  git grep -n "Note: This is a placeholder" -- 'functions/**' | sed -n '1,50p' || true
fi

echo "\n--- TODO/FIXME checks ---"
TODO_COUNT=$(git grep -n -e "TODO" -e "FIXME" -- 'functions/**' 2>/dev/null | wc -l || echo 0)
TODO_COUNT=${TODO_COUNT//[^0-9]/}
echo "Found ${TODO_COUNT} TODO/FIXME comments under functions/"
if (( TODO_COUNT > 0 )); then
  git grep -n -e "TODO" -e "FIXME" -- 'functions/**' | sed -n '1,50p' || true
fi

echo "\n--- Error / throw / exit checks ---"
ERR_COUNT=$(git grep -n -e "console.error(" -e "throw new Error" -e "process.exit(" -- 'functions/**' 2>/dev/null | wc -l || echo 0)
ERR_COUNT=${ERR_COUNT//[^0-9]/}
WARN_COUNT=$(git grep -n -e "console.warn(" -- 'functions/**' 2>/dev/null | wc -l || echo 0)
WARN_COUNT=${WARN_COUNT//[^0-9]/}
echo "Found ${ERR_COUNT} error/throw/exit occurrences and ${WARN_COUNT} console.warn occurrences under functions/"
if (( ERR_COUNT > 0 )); then
  git grep -n -e "console.error(" -e "throw new Error" -e "process.exit(" -- 'functions/**' | sed -n '1,50p' || true
fi

echo "\n--- Base44 integration checks ---"
SDK_IMPORTS=$(git grep -n "@base44/sdk" -- 'functions/**' 2>/dev/null | wc -l || echo 0)
SDK_IMPORTS=${SDK_IMPORTS//[^0-9]/}
echo "Files importing @base44/sdk: ${SDK_IMPORTS}"
if (( SDK_IMPORTS > 0 )); then
  git grep -n "@base44/sdk" -- 'functions/**' | sed -n '1,50p' || true
fi

# Check for common issues
echo "\n--- Repo diagnostic checks ---"
# Node/Deno
NODEV=$(node -v 2>/dev/null || echo 'notinstalled')
NPMV=$(npm -v 2>/dev/null || echo 'notinstalled')
DENO_V=$(deno --version 2>/dev/null | head -n 1 || echo 'notinstalled')

echo "node: ${NODEV}, npm: ${NPMV}, deno: ${DENO_V}"

# Run tests if present
if [ -f package.json ]; then
  echo "\nRunning npm test (if configured in package.json)..."
  npm test --silent || echo "npm test failed or not configured"
else
  echo "No package.json found, skipping npm test"
fi

# Run ESLint if present
if command -v eslint >/dev/null 2>&1; then
  echo "\nRunning ESLint..."
  eslint --ext .js,.ts . || echo "eslint failed or found issues"
else
  echo "ESLint not installed, skip lint step"
fi

# Print repo file counts
echo "\n--- File counts ---"
ls -la | wc -l

echo "\n--- FAQ / Next steps suggestions ---"

if (( PLACEHOLDER_COUNT > 0 )); then
  echo "-> Detected placeholder files under functions/. If you expect real code, re-run the Base44 push after confirming your GitHub token has Contents: Read & write permissions."
fi

echo "\n--- TRIAGE SUMMARY (automated) ---"
CRITICAL=()
RECOMMENDED=()
INFO=()

if [ "${PLACEHOLDER_COUNT}" -gt 0 ]; then
  CRITICAL+=("${PLACEHOLDER_COUNT} placeholder files in functions/")
fi

if [ "${ERR_COUNT}" -gt 0 ]; then
  RECOMMENDED+=("${ERR_COUNT} console.error/throw/process.exit occurrences")
fi

if [ "${TODO_COUNT}" -gt 0 ]; then
  RECOMMENDED+=("${TODO_COUNT} TODO/FIXME comments")
fi

if [ "${SDK_IMPORTS}" -gt 0 ]; then
  INFO+=("${SDK_IMPORTS} files import @base44/sdk; ensure Base44 token has read access to file contents if push fails")
fi

echo "CRITICAL (must fix before release):"
if [ ${#CRITICAL[@]} -eq 0 ]; then
  echo " - None identified"
else
  for i in "${CRITICAL[@]}"; do echo " - ${i}"; done
fi

echo "\nRECOMMENDED (fix or audit):"
if [ ${#RECOMMENDED[@]} -eq 0 ]; then
  echo " - None identified"
else
  for i in "${RECOMMENDED[@]}"; do echo " - ${i}"; done
fi

echo "\nINFORMATIONAL (review as needed):"
if [ ${#INFO[@]} -eq 0 ]; then
  echo " - None identified"
else
  for i in "${INFO[@]}"; do echo " - ${i}"; done
fi

# Dump a markdown triage report
REPORT=triage/triage_report.md
echo "# Triage Report - $(date -u)" > ${REPORT}
echo "\n## Summary" >> ${REPORT}
echo "- Repository: $(git rev-parse --show-toplevel 2>/dev/null || pwd)" >> ${REPORT}
echo "- Branch: ${BRANCH}" >> ${REPORT}
echo "- Commit: ${COMMIT}" >> ${REPORT}
echo "\n## Critical Issues" >> ${REPORT}
if [ ${#CRITICAL[@]} -eq 0 ]; then
  echo "- None identified" >> ${REPORT}
else
  for i in "${CRITICAL[@]}"; do echo "- ${i}" >> ${REPORT}; done
fi
echo "\n## Recommended Issues" >> ${REPORT}
if [ ${#RECOMMENDED[@]} -eq 0 ]; then
  echo "- None identified" >> ${REPORT}
else
  for i in "${RECOMMENDED[@]}"; do echo "- ${i}" >> ${REPORT}; done
fi
echo "\n## Informational" >> ${REPORT}
if [ ${#INFO[@]} -eq 0 ]; then
  echo "- None identified" >> ${REPORT}
else
  for i in "${INFO[@]}"; do echo "- ${i}" >> ${REPORT}; done
fi

echo "\nReport saved to ${REPORT}"

cat << 'EOF'
-> Suggested followups:
 - Reproduce the issue and add steps to the GitHub issue.
 - Attach output of this script to the issue for context.
 - If files are placeholders and you have real code in Base44, update the GitHub integration or token scopes and re-run the push.
EOF

exit 0
