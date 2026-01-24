# Auto-Merge Recent Pull Requests Workflow

## Overview

This workflow automatically merges pull requests that have been updated within the last 48 hours and meet specific merge criteria.

## Workflow File

`.github/workflows/auto-merge-recent-prs.yml`

## Triggers

### 1. Scheduled Execution
- Runs daily at 2:00 AM UTC
- Automatically processes all eligible PRs from the last 48 hours

### 2. Manual Execution
- Can be triggered manually via GitHub Actions UI
- Supports custom parameters:
  - `hours_lookback`: Number of hours to look back (default: 48)
  - `dry_run`: Test mode without actually merging PRs (default: false)

## Merge Criteria

A pull request will be automatically merged if it meets ALL of the following criteria:

1. **Recent Activity**: Updated within the specified time window (default: 48 hours)
2. **Open State**: PR must be in open state
3. **Mergeable**: No merge conflicts
4. **CI Passing**: All required status checks must pass (no failures)
5. **No Pending Checks**: All CI checks must be completed
6. **Approved**: At least one approval from a reviewer

## How It Works

1. **Fetch Branches**: Fetches all remote branches to ensure up-to-date information
2. **Query PRs**: Uses GitHub CLI to find all open PRs updated in the specified time window
3. **Filter PRs**: Evaluates each PR against the merge criteria
4. **Queue for Auto-Merge**: Queues qualifying PRs for automatic merge using squash merge strategy
5. **Branch Cleanup**: Automatically deletes the source branch after merge completes
6. **Notification**: Adds a comment to queued PRs explaining the automated action

**Note:** The workflow uses GitHub's auto-merge feature (`--auto` flag), which queues PRs for merge. The actual merge happens automatically once all branch protection requirements are satisfied (not immediately). This ensures compliance with branch protection rules even if they change between queueing and merging.

## Output Summary

The workflow provides a summary at the end:
- **Merged/Queued**: Number of PRs set to auto-merge
- **Skipped**: PRs that didn't meet criteria
- **Failed**: PRs that encountered errors during merge

## Usage Examples

### Running Manually with Custom Parameters

1. Go to: `Actions` → `Auto-Merge Recent Pull Requests` → `Run workflow`
2. Set parameters:
   - Hours lookback: `24` (for last 24 hours instead of 48)
   - Dry run: `true` (to test without merging)

### Testing Locally

While you cannot fully test merging locally, you can check which PRs would be affected:

```bash
# Install GitHub CLI if not already installed
# https://cli.github.com/

# List open PRs updated in last 48 hours
gh pr list --state open --json number,title,updatedAt,mergeable,statusCheckRollup

# Check specific PR status
gh pr view <PR_NUMBER> --json reviews,statusCheckRollup
```

## Permissions Required

The workflow requires the following permissions:
- `contents: write` - To merge PRs and delete branches
- `pull-requests: write` - To modify PR state and add comments
- `checks: read` - To read CI status

## Security Considerations

1. **Protected Branches**: Respects branch protection rules - PRs to protected branches still require all protection requirements to be met
2. **Required Reviews**: Only merges PRs with at least one approval
3. **CI Requirements**: Only merges PRs where all CI checks pass
4. **Token Usage**: Uses `GITHUB_TOKEN` with scoped permissions

## Monitoring

Check workflow runs at: `https://github.com/buckeye7066/GrantFlow/actions/workflows/auto-merge-recent-prs.yml`

Each run provides detailed logs showing:
- Which PRs were evaluated
- Why PRs were skipped
- Success/failure of merge operations

## Disabling the Workflow

To temporarily disable automatic merging:
1. Go to `.github/workflows/auto-merge-recent-prs.yml`
2. Comment out or remove the `schedule:` trigger
3. Keep the `workflow_dispatch:` for manual runs only

## Customization

### Change Schedule
Edit the cron expression in the workflow file:
```yaml
schedule:
  - cron: '0 2 * * *'  # Daily at 2 AM UTC
```

### Change Default Lookback Period
Modify the default value in the workflow file:
```yaml
hours_lookback:
  default: '48'  # Change to desired default
```

### Change Merge Strategy
Currently uses `--squash`. To use different merge methods:
- `--merge` for standard merge commit
- `--rebase` for rebase and merge

Edit line in workflow:
```bash
gh pr merge "$PR_NUMBER" --auto --squash --delete-branch
```

## Troubleshooting

### PRs Not Being Merged

**Check the workflow logs for specific reasons:**
- Not mergeable (conflicts)
- Failing CI checks
- Pending CI checks
- No approvals

### Merge Conflicts

The workflow will skip PRs with merge conflicts. Resolve conflicts manually and the PR will be reconsidered in the next run.

### Failed to Merge

If a PR fails to merge despite meeting criteria, check:
1. Branch protection rules
2. Required status checks
3. Required review count
4. Whether auto-merge is enabled for the repository

## Related Workflows

- `ci.yml` - Standard CI pipeline that runs tests
- `anya-code-fix-pr.yml` - AI-assisted code fix PR creation
- `prod-smoke.yml` - Production smoke tests
