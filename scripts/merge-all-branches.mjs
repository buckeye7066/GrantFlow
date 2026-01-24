#!/usr/bin/env node

/**
 * Merge All Branches to Main Script
 * 
 * This script will:
 * 1. Get all branches from the repository
 * 2. Create PRs to merge each branch into main
 * 3. Auto-merge the PRs
 * 4. Delete the branches after successful merge
 * 
 * Usage:
 *   node scripts/merge-all-branches.mjs [--dry-run] [--exclude branch1,branch2]
 */

import { execSync } from 'child_process';

// Configuration
const DRY_RUN = process.argv.includes('--dry-run');
const EXCLUDE_ARG = process.argv.find(arg => arg.startsWith('--exclude='));
const EXCLUDE_BRANCHES = EXCLUDE_ARG 
  ? EXCLUDE_ARG.split('=')[1].split(',').map(b => b.trim())
  : ['main', 'copilot/merge-and-delete-branches']; // Always exclude main and current branch

const DEFAULT_EXCLUDES = ['main', 'copilot/merge-and-delete-branches'];
const ALL_EXCLUDES = [...new Set([...DEFAULT_EXCLUDES, ...EXCLUDE_BRANCHES])];

function log(emoji, message) {
  console.log(`${emoji} ${message}`);
}

function executeCommand(command, options = {}) {
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
    return { success: true, output: output?.trim() };
  } catch (error) {
    return { 
      success: false, 
      error: error.message, 
      output: error.stdout?.trim(),
      stderr: error.stderr?.trim()
    };
  }
}

async function getAllBranches() {
  log('🌿', 'Fetching all branches from GitHub...');
  
  const result = executeCommand(
    'gh api repos/:owner/:repo/branches --paginate --jq ".[].name"',
    { silent: true }
  );
  
  if (!result.success) {
    log('❌', 'Failed to fetch branches from GitHub');
    throw new Error(result.error);
  }
  
  const branches = result.output.split('\n').filter(b => b.trim());
  log('✅', `Found ${branches.length} branches`);
  
  return branches;
}

async function createPR(branch, base = 'main') {
  log('📝', `Creating PR for branch: ${branch}`);
  
  if (DRY_RUN) {
    log('🔍', `[DRY RUN] Would create PR: ${branch} -> ${base}`);
    return { success: true, number: 'DRY-RUN', dryRun: true };
  }
  
  // Check if PR already exists
  const existingPRResult = executeCommand(
    `gh pr list --head "${branch}" --base "${base}" --json number --jq ".[0].number"`,
    { silent: true }
  );
  
  if (existingPRResult.success && existingPRResult.output) {
    log('ℹ️', `PR already exists for ${branch}: #${existingPRResult.output}`);
    return { success: true, number: existingPRResult.output, existing: true };
  }
  
  // Create PR
  const title = `Merge ${branch} to main`;
  const body = `Automated merge of branch \`${branch}\` into \`main\`.

This PR was created by the merge-all-branches script.`;
  
  const result = executeCommand(
    `gh pr create --base "${base}" --head "${branch}" --title "${title}" --body "${body}"`,
    { silent: true }
  );
  
  if (!result.success) {
    if (result.stderr && result.stderr.includes('no commits between')) {
      log('ℹ️', `Branch ${branch} has no new commits. Skipping.`);
      return { success: false, reason: 'no-commits', branch };
    }
    log('❌', `Failed to create PR for ${branch}: ${result.error}`);
    return { success: false, error: result.error, branch };
  }
  
  // Extract PR number from output
  const prNumber = result.output.match(/\/pull\/(\d+)/)?.[1];
  log('✅', `Created PR #${prNumber} for ${branch}`);
  
  return { success: true, number: prNumber };
}

async function mergePR(prNumber) {
  if (DRY_RUN) {
    log('🔍', `[DRY RUN] Would merge PR #${prNumber}`);
    return { success: true, dryRun: true };
  }
  
  log('🔀', `Merging PR #${prNumber}...`);
  
  const result = executeCommand(
    `gh pr merge ${prNumber} --squash --delete-branch --auto`,
    { silent: true }
  );
  
  if (!result.success) {
    log('⚠️', `Could not auto-merge PR #${prNumber}. It may need approval or have conflicts.`);
    return { success: false, error: result.error };
  }
  
  log('✅', `PR #${prNumber} queued for auto-merge`);
  return { success: true };
}

async function deleteBranch(branch) {
  if (DRY_RUN) {
    log('🔍', `[DRY RUN] Would delete branch: ${branch}`);
    return { success: true, dryRun: true };
  }
  
  log('🗑️', `Deleting branch: ${branch}...`);
  
  const result = executeCommand(
    `gh api -X DELETE repos/:owner/:repo/git/refs/heads/${branch}`,
    { silent: true }
  );
  
  if (!result.success) {
    log('⚠️', `Could not delete branch ${branch}: ${result.error}`);
    return { success: false, error: result.error };
  }
  
  log('✅', `Deleted branch: ${branch}`);
  return { success: true };
}

async function main() {
  log('🚀', 'Starting merge-all-branches script...');
  log('📋', `Dry run mode: ${DRY_RUN ? 'ENABLED' : 'DISABLED'}`);
  log('🚫', `Excluding branches: ${ALL_EXCLUDES.join(', ')}`);
  console.log('');
  
  // Check if gh CLI is installed
  const ghCheck = executeCommand('which gh', { silent: true });
  if (!ghCheck.success) {
    log('❌', 'GitHub CLI (gh) is not installed. Please install it to run this script.');
    log('ℹ️', 'Visit: https://cli.github.com/');
    process.exit(1);
  }
  
  // Get all branches
  const allBranches = await getAllBranches();
  const branchesToMerge = allBranches.filter(b => !ALL_EXCLUDES.includes(b));
  
  log('📊', `Total branches: ${allBranches.length}`);
  log('📊', `Branches to merge: ${branchesToMerge.length}`);
  console.log('');
  
  if (branchesToMerge.length === 0) {
    log('ℹ️', 'No branches to merge.');
    return;
  }
  
  // Process each branch
  const results = {
    created: [],
    merged: [],
    deleted: [],
    failed: [],
    skipped: [],
    existing: []
  };
  
  for (const branch of branchesToMerge) {
    console.log('═'.repeat(60));
    log('🔄', `Processing branch: ${branch}`);
    
    // Create PR
    const prResult = await createPR(branch);
    
    if (!prResult.success) {
      if (prResult.reason === 'no-commits') {
        results.skipped.push({ branch, reason: 'no-commits' });
        // Delete branch if it has no commits
        await deleteBranch(branch);
        results.deleted.push(branch);
      } else {
        results.failed.push({ branch, step: 'create-pr', error: prResult.error });
      }
      continue;
    }
    
    if (prResult.existing) {
      results.existing.push({ branch, pr: prResult.number });
      // Try to merge existing PR
      const mergeResult = await mergePR(prResult.number);
      if (mergeResult.success) {
        results.merged.push({ branch, pr: prResult.number });
      }
      continue;
    }
    
    results.created.push({ branch, pr: prResult.number });
    
    if (prResult.dryRun) {
      continue;
    }
    
    // Try to auto-merge
    const mergeResult = await mergePR(prResult.number);
    if (mergeResult.success) {
      results.merged.push({ branch, pr: prResult.number });
    }
  }
  
  // Print summary
  console.log('\n' + '═'.repeat(60));
  log('📊', 'Summary:');
  console.log('');
  console.log(`   ✅ PRs created: ${results.created.length}`);
  console.log(`   🔀 PRs merged/queued: ${results.merged.length}`);
  console.log(`   🗑️  Branches deleted: ${results.deleted.length}`);
  console.log(`   📝 Existing PRs: ${results.existing.length}`);
  console.log(`   ⏭️  Skipped (no commits): ${results.skipped.length}`);
  console.log(`   ❌ Failed: ${results.failed.length}`);
  console.log('');
  
  if (results.failed.length > 0) {
    log('⚠️', 'Failed branches:');
    results.failed.forEach(f => {
      console.log(`   - ${f.branch} (${f.step}): ${f.error}`);
    });
    console.log('');
  }
  
  if (results.created.length > 0) {
    log('📝', 'Created PRs:');
    results.created.forEach(r => {
      console.log(`   - ${r.branch} -> PR #${r.pr}`);
    });
    console.log('');
  }
  
  if (results.existing.length > 0) {
    log('📋', 'Existing PRs:');
    results.existing.forEach(r => {
      console.log(`   - ${r.branch} -> PR #${r.pr}`);
    });
    console.log('');
  }
  
  if (DRY_RUN) {
    log('🔍', 'This was a DRY RUN. No actual changes were made.');
  } else {
    log('🎉', 'Script completed!');
    log('ℹ️', 'PRs that were queued for auto-merge will be merged automatically once they pass CI and get approval.');
  }
}

try {
  main();
} catch (error) {
  log('❌', `Error: ${error.message}`);
  console.error(error);
  process.exit(1);
}
