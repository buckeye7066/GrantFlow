# Bug Fix PR Template / Steps

This is a checklist to follow while preparing a PR to fix a bug.

1. Create a branch from main or the appropriate target branch:
   ```bash
git checkout main
git pull origin main
git checkout -b fix/your-issue-short-desc
```

2. Reproduce the issue locally (attach steps & logs to PR):
   - Copy steps in Issue and add a reproducible test or steps to your PR description.

3. Add your change, tests, and update docs if required.

4. Run diagnostics/tests and ensure green:
   ```bash
bash triage/run_diagnostics.sh
# or
npm test
```

5. Commit and open a PR with a description linking the issue.

6. For the PR body include:
- Summary of the problem and fix.
- How to validate the fix (reproduce steps and expected output).
- Any noteworthy changes and migration or data impacts.

7. Add labels: `bug`, `area-*` and `priority-*` and assign to reviewer.


---
