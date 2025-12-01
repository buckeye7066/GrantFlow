#!/usr/bin/env bash
set -euo pipefail

# Moves placeholder files to triage/placeholder_backup and removes them from the repository

BACKUP_DIR=triage/placeholder_backup
mkdir -p ${BACKUP_DIR}

PLACEHOLDER_FILES=$(git grep -l "Note: This is a placeholder" -- 'functions/**' || true)
if [ -z "${PLACEHOLDER_FILES}" ]; then
  echo "No placeholder files found"
  exit 0
fi

echo "Found placeholders:" 
printf "%s\n" ${PLACEHOLDER_FILES}

for f in ${PLACEHOLDER_FILES}; do
  dest=${BACKUP_DIR}/$(dirname "${f}")
  mkdir -p "${dest}"
  git mv "${f}" "${dest}/" || mv "${f}" "${dest}/"
done

# Commit the changes
if [[ -n $(git status --porcelain) ]]; then
  git add ${BACKUP_DIR}
  git commit -m "chore(triage): move placeholder files to triage/placeholder_backup"
else
  echo "No changes to commit"
fi

echo "Moved placeholder files to ${BACKUP_DIR}. Review before pushing." 

exit 0
