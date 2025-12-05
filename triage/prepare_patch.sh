#!/usr/bin/env bash
set -euo pipefail

# Pack updated files into a zip after basic analysis
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <file> [file2 file3 ...]" >&2
  exit 1
fi

DEST=triage/patch
REPORT=triage/analysis_$(date -u +%Y%m%dT%H%M%SZ).md
mkdir -p ${DEST}
echo "# Patch Analysis Report - $(date -u)" > ${REPORT}

for file in "$@"; do
  echo "\nAnalyzing ${file}" | tee -a ${REPORT}
  if [ ! -f "${file}" ]; then
    echo " - File not found: ${file}" | tee -a ${REPORT}
    continue
  fi

  echo " - Size: $(wc -c < "${file}") bytes" | tee -a ${REPORT}
  grep -n "Note: This is a placeholder" "${file}" >/dev/null 2>&1 && echo " - Placeholder: yes" | tee -a ${REPORT} || echo " - Placeholder: no" | tee -a ${REPORT}
  grep -n -E "TODO|FIXME" "${file}" >/dev/null 2>&1 && echo " - TODO/FIXME found" | tee -a ${REPORT} || true
  grep -n "@base44/sdk" "${file}" >/dev/null 2>&1 && echo " - Uses @base44/sdk" | tee -a ${REPORT} || true

  echo "\n - Syntax check (node --check):" | tee -a ${REPORT}
  if node --check "${file}" >/dev/null 2>&1; then
    echo "   OK" | tee -a ${REPORT}
  else
    echo "   Syntax issues found" | tee -a ${REPORT}
    node --check "${file}" 2>&1 | sed -n '1,200p' | tee -a ${REPORT}
  fi

  echo "\n - Short grep summary" | tee -a ${REPORT}
  git grep -n "console.error(" "${file}" || true | sed -n '1,20p' | tee -a ${REPORT}
  git grep -n "throw new Error" "${file}" || true | sed -n '1,20p' | tee -a ${REPORT}
  git grep -n "process.exit(" "${file}" || true | sed -n '1,20p' | tee -a ${REPORT}

  # Copy file to patch folder
  cp --parents "${file}" "${DEST}/" || true
done

ZIP_FILE=triage/patch_$(date -u +%Y%m%dT%H%M%SZ).zip
(cd ${DEST} && zip -r ../$(basename ${ZIP_FILE}) .) >/dev/null 2>&1

echo "\nReport saved: ${REPORT}"
echo "Patch zip created: ${ZIP_FILE}"
echo "To upload to Base44, use the zip or create a PR with these changes."

exit 0
