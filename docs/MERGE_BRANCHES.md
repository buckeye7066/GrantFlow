# Merge All Branches to Main

This document describes how to merge all branches in the repository to the `main` branch and delete them after successful merge.

## Overview

The repository contains a GitHub Actions workflow that automates the process of:
1. Creating pull requests for all branches to merge them into `main`
2. Auto-merging the PRs where possible
3. Deleting branches after successful merge

## Usage

### Using the GitHub Actions Workflow (Recommended)

1. Go to the **Actions** tab in the GitHub repository
2. Select the **"Merge All Branches to Main"** workflow from the left sidebar
3. Click **"Run workflow"** button
4. Configure the workflow parameters:
   - **dry_run**: Set to `true` for a test run (no actual changes), `false` to actually merge
   - **exclude_branches**: Comma-separated list of branches to exclude (optional)
   - **batch_size**: Number of branches to process in this run (default: 10, set to 0 for all)
5. Click **"Run workflow"** to start

### Workflow Parameters

- **dry_run** (default: `true`)
  - When `true`, the workflow will simulate the merge process without making any actual changes
  - When `false`, the workflow will create PRs and attempt to auto-merge them
  - Always run with `dry_run=true` first to preview the changes

- **exclude_branches** (default: empty)
  - Comma-separated list of branch names to exclude from merging
  - By default, `main` and the current workflow branch are excluded
  - Example: `"production,staging,develop"`

- **batch_size** (default: `10`)
  - Number of branches to process in a single workflow run
  - Set to `0` to process all branches at once
  - Processing in batches is recommended for large numbers of branches

## Process

The workflow performs the following steps for each branch:

1. **Check for existing PR**: If a PR already exists for the branch, it will attempt to merge it
2. **Create PR**: Creates a new pull request to merge the branch into `main`
3. **Auto-merge**: Attempts to enable auto-merge on the PR
4. **Delete empty branches**: If a branch has no new commits compared to `main`, it will be deleted immediately

### Auto-Merge Behavior

The workflow uses GitHub's auto-merge feature, which means:
- PRs will be automatically merged once they pass all required checks
- PRs may require approval from a repository maintainer
- PRs with conflicts will need to be resolved manually
- The branch will be automatically deleted after successful merge

## Manual Script Usage (Alternative)

A Node.js script is also available for local execution:

```bash
# Dry run (preview only)
node scripts/merge-all-branches.mjs --dry-run

# Actual merge (requires GH_TOKEN environment variable)
GH_TOKEN=your_token_here node scripts/merge-all-branches.mjs

# Exclude specific branches
node scripts/merge-all-branches.mjs --exclude=branch1,branch2
```

**Note**: The script requires:
- Node.js 20.20.2
- GitHub CLI (`gh`) installed and authenticated
- `GH_TOKEN` environment variable set with appropriate permissions

## Monitoring Progress

After running the workflow:

1. Check the workflow run logs in the **Actions** tab
2. Review created PRs in the **Pull Requests** tab
3. Monitor auto-merge status for each PR
4. Manually review and approve PRs that couldn't be auto-merged

## Summary Statistics

The workflow provides a summary at the end:
- ✅ PRs created
- 🔀 PRs merged/queued for auto-merge
- 🗑️ Branches deleted (empty branches)
- 📝 Existing PRs found
- ⏭️ Skipped (no commits)
- ❌ Failed

## Best Practices

1. **Always test first**: Run with `dry_run=true` to preview changes
2. **Process in batches**: Use a reasonable batch size (10-20) for large numbers of branches
3. **Review failures**: Check failed branches and resolve issues manually
4. **Monitor PRs**: Resolve conflicts and failed checks before merging
5. **Clean up**: After successful merges, verify that branches are properly deleted

## Troubleshooting

### PR Creation Failed
- **No commits**: Branch has no changes compared to `main` → Will be automatically deleted
- **Conflicts**: Branch has merge conflicts → Needs manual resolution
- **Protected branch rules**: May require approval or passing checks

### Auto-Merge Failed
- **No approval**: PR needs review from a maintainer
- **Failing checks**: CI/CD checks must pass first
- **Conflicts**: Merge conflicts must be resolved

### Branch Not Deleted
- PR may still be open or pending
- Branch may be protected
- Manual deletion may be required

## Safety Features

- `main` branch is always excluded from merging
- Current workflow branch is excluded to prevent self-deletion
- Dry run mode allows safe testing
- Batch processing prevents overwhelming the repository
- Empty branches (no new commits) are detected and skipped

## Examples

### Example 1: Test run on all branches
```
Run workflow with:
- dry_run: true
- exclude_branches: (empty)
- batch_size: 0
```

### Example 2: Merge 10 branches at a time
```
Run workflow with:
- dry_run: false
- exclude_branches: (empty)
- batch_size: 10

(Run multiple times until all branches are merged)
```

### Example 3: Merge all except specific branches
```
Run workflow with:
- dry_run: false
- exclude_branches: "production,staging,hotfix/critical-bug"
- batch_size: 0
```

## Current Branch Count

As of the last check, this repository has approximately **82 branches** to potentially merge.

To get the current count:
```bash
gh api repos/:owner/:repo/branches --paginate --jq ".[].name" | wc -l
```
