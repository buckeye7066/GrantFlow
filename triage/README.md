# Triage & Bug-fix Console Template

This folder contains resources to help triage, debug, and fix issues in this repository.

Files:
- `run_diagnostics.sh` - a lightweight diagnostics script you can run in a Codespace or locally to collect logs, list recent commits/branches, check for placeholder files, and provide a summary.
- `bug_fix_template.md` - a checklist and template to make a fix branch and PR for a bug.

How to run:

1. Open a Codespace or the repo in a terminal.
2. Run the diagnostics script:

```bash
bash triage/run_diagnostics.sh
```

3. Review the output: it includes a quick summary of branch, recent commits, changed files, and suggestions to reproduce.

If you want me to triage an issue here, provide the issue link or attach the output from `triage/run_diagnostics.sh`. I can analyze it and propose a fix.

