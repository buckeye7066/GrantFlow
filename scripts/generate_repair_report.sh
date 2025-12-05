#!/usr/bin/env bash
set -euo pipefail

BASE_REF=origin/main
OUT_MD=REPAIR_REPORT.md
OUT_JSON=FIXED_FILES.json
ZIP_NAME=FULL_REPAIRED_REPO.zip

# Find files changed compared to base
CHANGED_FILES=$(git diff --name-only ${BASE_REF}..HEAD || true)
if [ -z "${CHANGED_FILES}" ]; then
  echo "No changes compared to ${BASE_REF}"
  exit 0
fi

> ${OUT_MD}
> ${OUT_JSON}

echo "# REPAIR REPORT - $(date -u)" >> ${OUT_MD}
echo "Base ref: ${BASE_REF}" >> ${OUT_MD}

echo "[" > ${OUT_JSON}
first=true
for f in ${CHANGED_FILES}; do
  before_sha=""; after_sha=""; diff_stat=""; summary=""
  if git cat-file -e ${BASE_REF}:${f} 2>/dev/null; then
    before_sha=$(git rev-parse ${BASE_REF}:${f} 2>/dev/null || echo "")
  fi
  if [ -f "${f}" ]; then
    after_sha=$(sha1sum "${f}" | awk '{print $1}')
  fi
  diff_stat=$(git diff --shortstat ${BASE_REF}..HEAD -- "${f}" || true)
  summary=$(git --no-pager diff --no-color ${BASE_REF}..HEAD -- "${f}" | sed -n '1,40p' | sed 's/"/\"/g')

  echo "- ${f}" >> ${OUT_MD}
  echo "  - Diff stat: ${diff_stat}" >> ${OUT_MD}

  if [ "${first}" = true ]; then first=false; else echo "," >> ${OUT_JSON}; fi
  printf '{"file": "%s", "sha_before": "%s", "sha_after": "%s", "diff_stat": "%s"}' "${f}" "${before_sha}" "${after_sha}" "${diff_stat}" >> ${OUT_JSON}

done

echo "\n]" >> ${OUT_JSON}

# Add a summary to REPAIR_REPORT
NB_CHANGED=$(echo "${CHANGED_FILES}" | wc -w)

cat >> ${OUT_MD} <<'EOF'

## Summary
- Files changed: ${NB_CHANGED}

## Next steps
- Validate the changes in a staging environment.
- Deploy and confirm webserver behavior.
EOF

# Create ZIP of repository
zip -r "${ZIP_NAME}" . -x ".git/*" "triage/patch/*" "triage/placeholder_backup/*" "node_modules/*" || true

echo "Generated ${OUT_MD}, ${OUT_JSON}, ${ZIP_NAME}." 

