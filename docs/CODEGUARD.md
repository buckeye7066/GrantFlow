# GrantFlow CodeGuard

An interactive, menu-driven PowerShell tool for managing the GrantFlow code quality pipeline from a local development environment. It wraps the existing `scripts/code-quality-gate.mjs` scanner and adds GitHub API integrations for branch management and PR auto-merging.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| PowerShell  | 7+      | Install from [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell/releases) |
| Node.js     | 20.20.2 | Matches GrantFlow's verified release runtime |
| GitHub PAT  | —       | See token scopes below |

---

## Token Setup

CodeGuard uses two environment variables for GitHub API access.

### `GITHUB_TOKEN` (read operations)

Required for Options 1, 5, and 6. Needed scopes: **`repo`** (or `public_repo` for public repos).

### `GRANTFLOW_ADMIN_TOKEN` (write operations)

Required for Options 2 and 3 (branch deletion, PR merge). Needed scopes: **`repo`** and **`delete_repo`**.

### Setting tokens in PowerShell

```powershell
# Set for the current session only
$env:GITHUB_TOKEN          = 'ghp_yourReadTokenHere'
$env:GRANTFLOW_ADMIN_TOKEN = 'ghp_yourAdminTokenHere'

# Or add to your PowerShell profile for persistence
notepad $PROFILE
# Add the lines above to the file
```

If a token is not set, CodeGuard will prompt you to enter it interactively at runtime (using a secure prompt that does not echo input).

### Custom repository target

By default, CodeGuard targets `buckeye7066/GrantFlow`. Override with:

```powershell
$env:GRANTFLOW_REPO = 'your-org/your-repo'
```

---

## Usage

### Launch the interactive menu

```powershell
cd path/to/GrantFlow
.\scripts\GrantFlow-CodeGuard.ps1
```

The menu will appear:

```
╔══════════════════════════════════════════════════════════╗
║            GrantFlow CodeGuard – PowerShell              ║
╠══════════════════════════════════════════════════════════╣
║  1. Run Code Quality Gate (local scan)                   ║
║  2. Cleanup Stale Branches (GitHub)                      ║
║  3. Auto-Merge Safe PRs (GitHub)                         ║
║  4. Full Pipeline (Scan → Branch Cleanup → Auto-Merge)   ║
║  5. Show Allowlist Summary                               ║
║  6. View Recent CI Workflow Runs                         ║
║  Q. Quit                                                 ║
╚══════════════════════════════════════════════════════════╝
```

---

## Menu Options

### Option 1 – Run Code Quality Gate (local scan)

Runs `node scripts/code-quality-gate.mjs --report` from the repo root.

- Output is color-coded: **green** for pass, **red** for violations, **yellow** for violation categories.
- Displays a pass/fail banner with a per-category violation count on failure.
- Does **not** require a GitHub token.

```
Select an option: 1
─── Running Code Quality Gate ───
[quality-gate] OK: no blocking code-quality violations found
╔════════════════════════════════╗
║      ✔  QUALITY GATE PASSED    ║
╚════════════════════════════════╝
```

### Option 2 – Cleanup Stale Branches (GitHub)

Lists all remote branches, identifies those whose last commit is older than 30 days and are not protected (`main`, `develop`, `staging`, `production`), and offers to delete them.

- Requires `GRANTFLOW_ADMIN_TOKEN` with `repo` + `delete_repo` scopes.
- Presents a list with last-commit dates before prompting for confirmation (default: **No**).
- Fetches up to 300 branches (3 pages of 100).

```
Select an option: 2
─── Fetching branches ───
Found 45 total branches.

Stale branches (last commit older than 30 days):
Name                     LastCommit
----                     ----------
feature/old-experiment   2024-11-15
fix/abandoned-attempt    2024-10-02

Delete all 2 stale branches? (y/N): y
  Deleted: feature/old-experiment
  Deleted: fix/abandoned-attempt

Branch cleanup complete. Deleted: 2  Failed: 0
```

### Option 3 – Auto-Merge Safe PRs (GitHub)

Lists open PRs that meet **all** of the following criteria:

- Not a draft
- `mergeable` is `true`
- All status checks are passing
- At least one approval review is present
- Has the `auto-merge` label **or** was created by `github-actions[bot]` (e.g., the `anya-code-fix-pr` workflow)
- If title/branch looks like CodeGuard/autofix, it must also include the `codeguard-reviewed` label

Merges using the **squash** method. Requires `GRANTFLOW_ADMIN_TOKEN`.

```
Select an option: 3
─── Fetching open pull requests ───
Evaluating 12 open PR(s)...

PRs eligible for auto-merge:
Number Title                              Author               Status
------ -----                              ------               ------
   42  fix: auto-repair console usage     github-actions[bot]  passing

Merge all 1 eligible PR(s)? (y/N/number to merge one): y
  Merged PR #42: fix: auto-repair console usage

Auto-merge complete. Merged: 1  Failed: 0
```

### Option 4 – Full Pipeline

Runs options 1, 2, and 3 in sequence:

1. **Code Quality Gate** – if violations are found, you are asked whether to continue.
2. **Branch Cleanup** – stale branch deletion with confirmation.
3. **Auto-Merge** – safe PR merging with confirmation.

### Option 5 – Show Allowlist Summary

Reads `codeQualityGate.allowlist.json` from the repo root and displays a formatted summary of each allowlist category.

- Shows counts per category.
- Lists up to 20 files per category (truncates with "...and N more" for larger lists).
- Does not require a GitHub token.

```
─── Allowlist Summary ───

  allowed_console_files (3 files):
    backend/server.js
    backend/routes/auth.js
    backend/routes/ai.js

  allowed_todo_files (0 files):
    (none)
  ...
```

### Option 6 – View Recent CI Workflow Runs

Fetches the last 10 GitHub Actions workflow runs and displays them in a table. Requires `GITHUB_TOKEN`.

Color codes:
- **Green** – `success`
- **Red** – `failure`
- **Yellow** – `in_progress`
- **Gray** – other states

---

## Non-Interactive / CI Usage

Pass a comma-separated list of option numbers via `-NonInteractive` to run without prompts:

```powershell
# Run just the code quality gate
.\scripts\GrantFlow-CodeGuard.ps1 -NonInteractive "1"

# Run branch cleanup and auto-merge (requires tokens in environment)
.\scripts\GrantFlow-CodeGuard.ps1 -NonInteractive "2,3"

# Run the full pipeline
.\scripts\GrantFlow-CodeGuard.ps1 -NonInteractive "4"
```

In CI environments, set the tokens as secrets and export them:

```yaml
# GitHub Actions example
- name: Run GrantFlow CodeGuard
  shell: pwsh
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GRANTFLOW_ADMIN_TOKEN: ${{ secrets.GRANTFLOW_ADMIN_TOKEN }}
  run: .\scripts\GrantFlow-CodeGuard.ps1 -NonInteractive "1"
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid/expired token (401) | Displays "Check that your token is valid and not expired." |
| Insufficient scopes (403) | Displays "Check that your token has the required scopes." |
| Rate limited (403 + `X-RateLimit-Remaining: 0`) | Displays the quota reset time |
| Missing `codeQualityGate.allowlist.json` | Displays a path error; does not crash |
| Node.js not found | Standard PowerShell error from the `& node` call |

---

## Get Help

```powershell
Get-Help .\scripts\GrantFlow-CodeGuard.ps1 -Full
```
