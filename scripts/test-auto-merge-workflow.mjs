#!/usr/bin/env node

/**
 * Test script for auto-merge workflow logic
 * This script simulates the workflow's PR filtering logic locally
 */

import { execSync } from 'child_process';

const HOURS_LOOKBACK = process.env.HOURS_LOOKBACK || 48;

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
    return { success: false, error: error.message, output: error.stdout?.trim() };
  }
}

function main() {
  log('🔍', 'Testing auto-merge workflow logic...\n');

  // Check if gh CLI is installed
  const ghCheck = executeCommand('which gh', { silent: true });
  if (!ghCheck.success) {
    log('❌', 'GitHub CLI (gh) is not installed. Please install it to run this test.');
    log('ℹ️', 'Visit: https://cli.github.com/');
    process.exit(1);
  }
  log('✅', 'GitHub CLI found');

  // Calculate date for lookback period
  const sinceDate = new Date(Date.now() - HOURS_LOOKBACK * 60 * 60 * 1000).toISOString();
  log('📅', `Looking for PRs updated since: ${sinceDate}`);
  log('⏰', `(Last ${HOURS_LOOKBACK} hours)\n`);

  // Get repository information
  log('📦', 'Fetching repository information...');
  const repoInfo = executeCommand('gh repo view --json nameWithOwner -q .nameWithOwner', { silent: true });
  if (repoInfo.success) {
    log('✅', `Repository: ${repoInfo.output}\n`);
  }

  // Fetch all branches
  log('🌿', 'Fetching all remote branches...');
  const fetchResult = executeCommand('git fetch --all --prune', { silent: true });
  if (fetchResult.success) {
    log('✅', 'Branches fetched successfully\n');
  } else {
    log('⚠️', 'Could not fetch branches (continuing anyway)\n');
  }

  // Get recent PRs
  log('🔎', 'Searching for open pull requests...');
  const prListCommand = `gh pr list --state open --json number,title,updatedAt,headRefName,mergeable,statusCheckRollup,reviews --limit 100`;

  const prListResult = executeCommand(prListCommand, { silent: true });
  if (!prListResult.success) {
    log('❌', 'Failed to fetch PR list');
    process.exit(1);
  }

  const allPRs = JSON.parse(prListResult.output || '[]');
  const recentPRs = allPRs.filter(pr => pr.updatedAt >= sinceDate);

  log('📊', `Total open PRs: ${allPRs.length}`);
  log('📊', `PRs updated in last ${HOURS_LOOKBACK} hours: ${recentPRs.length}\n`);

  if (recentPRs.length === 0) {
    log('ℹ️', 'No pull requests found in the specified time window.');
    return;
  }

  // Analyze each recent PR
  log('📝', 'Analyzing recent pull requests:\n');
  log('═'.repeat(60));

  let mergeableCount = 0;
  let notMergeableCount = 0;
  let needsApprovalCount = 0;
  let failingChecksCount = 0;
  let pendingChecksCount = 0;

  recentPRs.forEach((pr, index) => {
    console.log(`\n${index + 1}. PR #${pr.number}: ${pr.title}`);
    console.log(`   Branch: ${pr.headRefName}`);
    console.log(`   Updated: ${pr.updatedAt}`);

    // Check mergeable status
    if (pr.mergeable !== 'MERGEABLE') {
      console.log(`   ⚠️  Status: ${pr.mergeable} (not mergeable)`);
      notMergeableCount++;
      return;
    }

    // Check status checks
    const statusChecks = pr.statusCheckRollup || [];
    const hasFailures = statusChecks.some(check => check.conclusion === 'FAILURE');
    const hasPending = statusChecks.some(check =>
      check.status === 'IN_PROGRESS' || check.status === 'QUEUED'
    );

    if (hasFailures) {
      console.log('   ❌ Has failing CI checks');
      failingChecksCount++;
      return;
    }

    if (hasPending) {
      console.log('   ⏳ Has pending CI checks');
      pendingChecksCount++;
      return;
    }

    // Check approvals
    const approvals = (pr.reviews || []).filter(review => review.state === 'APPROVED');

    if (approvals.length === 0) {
      console.log('   ⏸️  No approvals yet');
      needsApprovalCount++;
      return;
    }

    // This PR would be merged!
    console.log('   ✅ Ready to merge!');
    console.log(`      - Mergeable: Yes`);
    console.log(`      - CI checks: All passing`);
    console.log(`      - Approvals: ${approvals.length}`);
    mergeableCount++;
  });

  // Summary
  console.log('\n' + '═'.repeat(60));
  log('📊', '\nSummary:');
  console.log(`   Would merge: ${mergeableCount}`);
  console.log(`   Needs approval: ${needsApprovalCount}`);
  console.log(`   Has conflicts/not mergeable: ${notMergeableCount}`);
  console.log(`   Failing CI checks: ${failingChecksCount}`);
  console.log(`   Pending CI checks: ${pendingChecksCount}`);
  console.log('');

  if (mergeableCount > 0) {
    log('🎉', `${mergeableCount} PR(s) would be automatically merged by the workflow!`);
  } else {
    log('ℹ️', 'No PRs currently meet all criteria for auto-merge.');
  }
}

try {
  main();
} catch (error) {
  log('❌', `Error: ${error.message}`);
  process.exit(1);
}
