<#
.SYNOPSIS
    GrantFlow CodeGuard – Interactive PowerShell tool for managing the GrantFlow code quality pipeline.

.DESCRIPTION
    Wraps the existing scripts/code-quality-gate.mjs scanner and adds GitHub API integrations
    for branch management and PR auto-merging. Provides an interactive menu-driven interface
    for local development workflows as well as a -NonInteractive mode for CI usage.

.PARAMETER NonInteractive
    Comma-separated list of menu option numbers to run without prompting (e.g. "1,2,3").
    Valid values: 1, 2, 3, 4, 5, 6.

.EXAMPLE
    # Launch the interactive menu
    .\GrantFlow-CodeGuard.ps1

.EXAMPLE
    # Run just the code quality gate non-interactively
    .\GrantFlow-CodeGuard.ps1 -NonInteractive "1"

.EXAMPLE
    # Run the full pipeline non-interactively
    .\GrantFlow-CodeGuard.ps1 -NonInteractive "4"

.NOTES
    Prerequisites: PowerShell 7+, Node.js 20.20.2
    Required environment variables:
      GITHUB_TOKEN          – GitHub PAT with 'repo' scope (Options 1, 5, 6)
      GRANTFLOW_ADMIN_TOKEN – GitHub PAT with 'repo' + 'delete_repo' scopes (Options 2, 3)
      GRANTFLOW_REPO        – Optional override for owner/repo (default: buckeye7066/GrantFlow)
#>

param(
    [string]$NonInteractive = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

$script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$script:Repo     = if ($env:GRANTFLOW_REPO) { $env:GRANTFLOW_REPO } else { 'buckeye7066/GrantFlow' }
$script:ApiBase  = 'https://api.github.com'

# Protected branches that must never be deleted
$script:ProtectedBranches = @('main', 'develop', 'staging', 'production')

# Stale branch threshold (days)
$script:StaleDays = 30

# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

function Get-GitHubToken {
    if ($env:GITHUB_TOKEN) {
        return $env:GITHUB_TOKEN
    }
    Write-Host 'GITHUB_TOKEN is not set.' -ForegroundColor Yellow
    $secure = Read-Host 'Enter your GitHub Personal Access Token (repo scope)' -AsSecureString
    $bstr   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Get-AdminToken {
    if ($env:GRANTFLOW_ADMIN_TOKEN) {
        return $env:GRANTFLOW_ADMIN_TOKEN
    }
    Write-Host 'GRANTFLOW_ADMIN_TOKEN is not set.' -ForegroundColor Yellow
    $secure = Read-Host 'Enter your GitHub Admin Token (repo + delete_repo scopes)' -AsSecureString
    $bstr   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function New-AuthHeaders {
    param([string]$Token)
    return @{
        Authorization = "Bearer $Token"
        Accept        = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
}

# ---------------------------------------------------------------------------
# GitHub API helper
# ---------------------------------------------------------------------------

function Invoke-GitHubApi {
    param(
        [string]$Uri,
        [string]$Method = 'GET',
        [hashtable]$Headers,
        [object]$Body = $null
    )
    try {
        $params = @{
            Uri     = $Uri
            Method  = $Method
            Headers = $Headers
        }
        if ($Body) {
            $params.Body        = ($Body | ConvertTo-Json -Depth 10)
            $params.ContentType = 'application/json'
        }
        return Invoke-RestMethod @params
    } catch {
        $statusCode = $null
        try {
            if ($_.Exception -and $_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $statusCode = $_.Exception.Response.StatusCode.value__
            }
        } catch {
            $statusCode = $null
        }
        $message    = $_.Exception.Message

        if ($statusCode -eq 401 -or $statusCode -eq 403) {
            # Check for rate-limit header
            $remaining = $null
            $resetUnix = $null
            try {
                $responseHeaders = $null
                if ($_.Exception -and $_.Exception.Response) {
                    $responseHeaders = $_.Exception.Response.Headers
                }
                if ($responseHeaders) {
                    $remaining = $responseHeaders['X-RateLimit-Remaining']
                    $resetUnix = $responseHeaders['X-RateLimit-Reset']
                }
            } catch {
                $remaining = $null
                $resetUnix = $null
            }
            if ($remaining -eq '0') {
                $resetTime  = if ($resetUnix) {
                    [System.DateTimeOffset]::FromUnixTimeSeconds([long]$resetUnix).LocalDateTime.ToString('HH:mm:ss')
                } else { 'unknown' }
                Write-Host "Rate limited. Quota resets at $resetTime." -ForegroundColor Red
            } elseif ($statusCode -eq 401) {
                Write-Host "Authentication failed (401). Check that your token is valid and not expired." -ForegroundColor Red
            } else {
                Write-Host "Authorization failed (403). Check that your token has the required scopes." -ForegroundColor Red
            }
        } else {
            Write-Host "GitHub API error [$statusCode]: $message" -ForegroundColor Red
        }
        throw
    }
}

# ---------------------------------------------------------------------------
# Option 1 – Run Code Quality Gate
# ---------------------------------------------------------------------------

function Invoke-CodeQualityGate {
    Write-Host ''
    Write-Host '─── Running Code Quality Gate ───' -ForegroundColor Cyan

    $scriptPath = Join-Path $script:RepoRoot 'scripts' 'code-quality-gate.mjs'
    if (-not (Test-Path $scriptPath)) {
        Write-Host "ERROR: $scriptPath not found." -ForegroundColor Red
        return $false
    }

    Push-Location $script:RepoRoot
    try {
        $output = & node $scriptPath --report 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    foreach ($line in $output) {
        if ($line -match 'OK: no blocking code-quality violations found') {
            Write-Host $line -ForegroundColor Green
        } elseif ($line -match '\[quality-gate\] Violations found') {
            Write-Host $line -ForegroundColor Red
        } elseif ($line -match '^-\s+\w+:\s+\d+') {
            Write-Host $line -ForegroundColor Yellow
        } else {
            Write-Host $line
        }
    }

    Write-Host ''
    if ($exitCode -eq 0) {
        Write-Host '╔════════════════════════════════╗' -ForegroundColor Green
        Write-Host '║      ✔  QUALITY GATE PASSED    ║' -ForegroundColor Green
        Write-Host '╚════════════════════════════════╝' -ForegroundColor Green
        return $true
    } else {
        # Build violation summary
        $categories = $output | Where-Object { $_ -match '^- (\w+): (\d+)' } | ForEach-Object {
            if ($_ -match '^- (\w+): (\d+)') { "  $($Matches[1]): $($Matches[2]) violation(s)" }
        }
        Write-Host '╔════════════════════════════════╗' -ForegroundColor Red
        Write-Host '║      ✘  QUALITY GATE FAILED    ║' -ForegroundColor Red
        Write-Host '╚════════════════════════════════╝' -ForegroundColor Red
        if ($categories) {
            Write-Host 'Violations by category:' -ForegroundColor Yellow
            $categories | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
        }
        return $false
    }
}

# ---------------------------------------------------------------------------
# Option 2 – Cleanup Stale Branches
# ---------------------------------------------------------------------------

function Invoke-BranchCleanup {
    $adminToken = Get-AdminToken
    $headers    = New-AuthHeaders -Token $adminToken

    Write-Host ''
    Write-Host '─── Fetching branches ───' -ForegroundColor Cyan

    # Paginate up to 300 branches (3 pages × 100)
    $allBranches = @()
    for ($page = 1; $page -le 3; $page++) {
        $uri        = "$script:ApiBase/repos/$script:Repo/branches?per_page=100&page=$page"
        $pageResult = Invoke-GitHubApi -Uri $uri -Headers $headers
        if ($pageResult.Count -eq 0) { break }
        $allBranches += $pageResult
        if ($pageResult.Count -lt 100) { break }
    }

    Write-Host "Found $($allBranches.Count) total branches." -ForegroundColor Gray

    $cutoff     = (Get-Date).AddDays(-$script:StaleDays)
    $staleBranches = @()

    foreach ($branch in $allBranches) {
        $name = $branch.name
        if ($script:ProtectedBranches -contains $name) { continue }

        $commitDate = [datetime]$branch.commit.commit.committer.date
        if ($commitDate -lt $cutoff) {
            $staleBranches += [PSCustomObject]@{
                Name       = $name
                LastCommit = $commitDate.ToString('yyyy-MM-dd')
                Sha        = $branch.commit.sha
            }
        }
    }

    if ($staleBranches.Count -eq 0) {
        Write-Host "No stale branches found (threshold: $script:StaleDays days)." -ForegroundColor Green
        return
    }

    Write-Host ''
    Write-Host "Stale branches (last commit older than $script:StaleDays days):" -ForegroundColor Yellow
    $staleBranches | Format-Table -AutoSize Name, LastCommit

    $confirm = Read-Host "Delete all $($staleBranches.Count) stale branches? (y/N)"
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host 'Aborted. No branches deleted.' -ForegroundColor Gray
        return
    }

    $deleted = 0
    $failed  = 0
    foreach ($b in $staleBranches) {
        try {
            $uri = "$script:ApiBase/repos/$script:Repo/git/refs/heads/$([System.Uri]::EscapeDataString($b.Name))"
            Invoke-GitHubApi -Uri $uri -Method DELETE -Headers $headers | Out-Null
            Write-Host "  Deleted: $($b.Name)" -ForegroundColor Green
            $deleted++
        } catch {
            Write-Host "  Failed to delete: $($b.Name)" -ForegroundColor Red
            $failed++
        }
    }

    Write-Host ''
    Write-Host "Branch cleanup complete. Deleted: $deleted  Failed: $failed" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Option 3 – Auto-Merge Safe PRs
# ---------------------------------------------------------------------------

function Invoke-AutoMergePRs {
    $adminToken   = Get-AdminToken
    $adminHeaders = New-AuthHeaders -Token $adminToken
    $readToken    = Get-GitHubToken
    $readHeaders  = New-AuthHeaders -Token $readToken

    Write-Host ''
    Write-Host '─── Fetching open pull requests ───' -ForegroundColor Cyan

    $uri  = "$script:ApiBase/repos/$script:Repo/pulls?state=open&per_page=100"
    $prs  = Invoke-GitHubApi -Uri $uri -Headers $readHeaders

    if ($prs.Count -eq 0) {
        Write-Host 'No open pull requests found.' -ForegroundColor Green
        return
    }

    Write-Host "Evaluating $($prs.Count) open PR(s)..." -ForegroundColor Gray

    $safePRs = @()
    foreach ($pr in $prs) {
        # Skip drafts
        if ($pr.draft) { continue }

        # Skip if not mergeable
        if ($pr.mergeable -ne $true) { continue }

        # Check labels and author
        $hasAutoMergeLabel = ($pr.labels | Where-Object { $_.name -eq 'auto-merge' }).Count -gt 0
        $isBot             = $pr.user.login -eq 'github-actions[bot]'

        if (-not $hasAutoMergeLabel -and -not $isBot) { continue }

        $isCodeGuardLike = (($pr.title -match '\[CodeGuard\]') -or ($pr.head.ref -match '(^|/)(codeguard|anya-fix|autofix)(/|$)'))
        if ($isCodeGuardLike) {
            $hasCodeguardReviewed = ($pr.labels | Where-Object { $_.name -eq 'codeguard-reviewed' }).Count -gt 0
            if (-not $hasCodeguardReviewed) {
                continue
            }
        }

        # Check commit status
        $sha        = $pr.head.sha
        $statusUri  = "$script:ApiBase/repos/$script:Repo/commits/$sha/status"
        try {
            $status = Invoke-GitHubApi -Uri $statusUri -Headers $readHeaders
            $checksOk = $status.state -eq 'success' -or $status.total_count -eq 0
        } catch {
            $checksOk = $false
        }

        # Require at least one approval before listing as safe.
        $reviewsUri = "$script:ApiBase/repos/$script:Repo/pulls/$($pr.number)/reviews"
        try {
            $reviews = Invoke-GitHubApi -Uri $reviewsUri -Headers $readHeaders
            $approvals = @($reviews | Where-Object { $_.state -eq 'APPROVED' }).Count
        } catch {
            $approvals = 0
        }
        if ($approvals -eq 0) { continue }

        $safePRs += [PSCustomObject]@{
            Number  = $pr.number
            Title   = $pr.title
            Author  = $pr.user.login
            Status  = if ($checksOk) { 'passing' } else { 'not passing' }
            Checks  = $checksOk
            Approvals = $approvals
        }
    }

    if ($safePRs.Count -eq 0) {
        Write-Host 'No safe PRs eligible for auto-merge.' -ForegroundColor Green
        return
    }

    Write-Host ''
    Write-Host 'PRs eligible for auto-merge:' -ForegroundColor Yellow
    $safePRs | Format-Table -AutoSize Number, Title, Author, Status

    $confirm = Read-Host "Merge all $($safePRs.Count) eligible PR(s)? (y/N/number to merge one)"
    if ($confirm -match '^[Yy]$') {
        $toMerge = $safePRs
    } elseif ($confirm -match '^\d+$') {
        $toMerge = $safePRs | Where-Object { $_.Number -eq [int]$confirm }
        if (-not $toMerge) {
            Write-Host "PR #$confirm not found in eligible list." -ForegroundColor Red
            return
        }
    } else {
        Write-Host 'Aborted. No PRs merged.' -ForegroundColor Gray
        return
    }

    $merged = 0
    $failed = 0
    foreach ($pr in $toMerge) {
        if (-not $pr.Checks) {
            Write-Host "  Skipping PR #$($pr.Number) – status checks not passing." -ForegroundColor Yellow
            continue
        }
        try {
            $mergeUri  = "$script:ApiBase/repos/$script:Repo/pulls/$($pr.Number)/merge"
            $mergeBody = @{ merge_method = 'squash' }
            Invoke-GitHubApi -Uri $mergeUri -Method PUT -Headers $adminHeaders -Body $mergeBody | Out-Null
            Write-Host "  Merged PR #$($pr.Number): $($pr.Title)" -ForegroundColor Green
            $merged++
        } catch {
            Write-Host "  Failed to merge PR #$($pr.Number)." -ForegroundColor Red
            $failed++
        }
    }

    Write-Host ''
    Write-Host "Auto-merge complete. Merged: $merged  Failed: $failed" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Option 4 – Full Pipeline
# ---------------------------------------------------------------------------

function Invoke-FullPipeline {
    Write-Host ''
    Write-Host '══════════════════════════════════════' -ForegroundColor Magenta
    Write-Host '  Full Pipeline: Scan → Cleanup → Merge' -ForegroundColor Magenta
    Write-Host '══════════════════════════════════════' -ForegroundColor Magenta

    $passed = Invoke-CodeQualityGate

    if (-not $passed) {
        Write-Host ''
        $cont = Read-Host 'Quality gate failed. Continue with branch cleanup and merge? (y/N)'
        if ($cont -notmatch '^[Yy]$') {
            Write-Host 'Pipeline aborted.' -ForegroundColor Yellow
            return
        }
    }

    Invoke-BranchCleanup
    Invoke-AutoMergePRs

    Write-Host ''
    Write-Host '══════════════════════════════════════' -ForegroundColor Magenta
    Write-Host '  Full Pipeline Complete'              -ForegroundColor Magenta
    Write-Host '══════════════════════════════════════' -ForegroundColor Magenta
}

# ---------------------------------------------------------------------------
# Option 5 – Show Allowlist Summary
# ---------------------------------------------------------------------------

function Show-AllowlistSummary {
    $allowlistPath = Join-Path $script:RepoRoot 'codeQualityGate.allowlist.json'

    if (-not (Test-Path $allowlistPath)) {
        Write-Host "ERROR: $allowlistPath not found." -ForegroundColor Red
        return
    }

    $json = Get-Content $allowlistPath -Raw | ConvertFrom-Json

    $categories = @(
        'allowed_console_files',
        'allowed_todo_files',
        'allowed_empty_catch_files',
        'allowed_unhandled_then_files'
    )

    Write-Host ''
    Write-Host '─── Allowlist Summary ───' -ForegroundColor Cyan
    Write-Host ''

    foreach ($cat in $categories) {
        $files = $json.$cat
        $count = if ($files) { @($files).Count } else { 0 }

        Write-Host "  $cat ($count files):" -ForegroundColor Yellow

        if ($count -eq 0) {
            Write-Host '    (none)' -ForegroundColor Gray
        } else {
            $display = if ($count -gt 20) { @($files)[0..19] } else { @($files) }
            foreach ($f in $display) {
                Write-Host "    $f" -ForegroundColor Gray
            }
            if ($count -gt 20) {
                Write-Host "    ...and $($count - 20) more" -ForegroundColor DarkGray
            }
        }
        Write-Host ''
    }
}

# ---------------------------------------------------------------------------
# Option 6 – View Recent CI Workflow Runs
# ---------------------------------------------------------------------------

function Show-WorkflowRuns {
    $token   = Get-GitHubToken
    $headers = New-AuthHeaders -Token $token

    Write-Host ''
    Write-Host '─── Recent CI Workflow Runs ───' -ForegroundColor Cyan

    $uri  = "$script:ApiBase/repos/$script:Repo/actions/runs?per_page=10"
    $data = Invoke-GitHubApi -Uri $uri -Headers $headers

    if ($data.total_count -eq 0) {
        Write-Host 'No workflow runs found.' -ForegroundColor Gray
        return
    }

    Write-Host ''
    foreach ($run in $data.workflow_runs) {
        $color = switch ($run.conclusion) {
            'success'  { 'Green' }
            'failure'  { 'Red' }
            default    {
                if ($run.status -eq 'in_progress') { 'Yellow' } else { 'Gray' }
            }
        }

        $runName   = if ($run.name)        { $run.name.Substring(0, [Math]::Min(39, $run.name.Length)) }        else { '' }
        $runBranch = if ($run.head_branch) { $run.head_branch.Substring(0, [Math]::Min(29, $run.head_branch.Length)) } else { '' }
        $runConclusion = if ($run.conclusion) { $run.conclusion } else { 'pending' }
        $line = '{0,-12} {1,-40} {2,-12} {3,-12} {4,-30} {5}' -f `
            $run.id,
            $runName,
            $run.status,
            $runConclusion,
            $runBranch,
            $run.created_at

        Write-Host $line -ForegroundColor $color
    }

    Write-Host ''
    Write-Host ('{0,-12} {1,-40} {2,-12} {3,-12} {4,-30} {5}' -f 'Run ID', 'Workflow', 'Status', 'Conclusion', 'Branch', 'Created At') -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------

function Show-Menu {
    Write-Host ''
    Write-Host '╔══════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
    Write-Host '║            GrantFlow CodeGuard – PowerShell              ║' -ForegroundColor Cyan
    Write-Host '╠══════════════════════════════════════════════════════════╣' -ForegroundColor Cyan
    Write-Host '║  1. Run Code Quality Gate (local scan)                   ║' -ForegroundColor Cyan
    Write-Host '║  2. Cleanup Stale Branches (GitHub)                      ║' -ForegroundColor Cyan
    Write-Host '║  3. Auto-Merge Safe PRs (GitHub)                         ║' -ForegroundColor Cyan
    Write-Host '║  4. Full Pipeline (Scan → Branch Cleanup → Auto-Merge)   ║' -ForegroundColor Cyan
    Write-Host '║  5. Show Allowlist Summary                               ║' -ForegroundColor Cyan
    Write-Host '║  6. View Recent CI Workflow Runs                         ║' -ForegroundColor Cyan
    Write-Host '║  Q. Quit                                                 ║' -ForegroundColor Cyan
    Write-Host '╚══════════════════════════════════════════════════════════╝' -ForegroundColor Cyan
    Write-Host "  Repo: $script:Repo" -ForegroundColor DarkGray
    Write-Host ''
}

function Invoke-MenuOption {
    param([string]$Choice)

    switch ($Choice.Trim().ToUpper()) {
        '1' { Invoke-CodeQualityGate | Out-Null }
        '2' { Invoke-BranchCleanup }
        '3' { Invoke-AutoMergePRs }
        '4' { Invoke-FullPipeline }
        '5' { Show-AllowlistSummary }
        '6' { Show-WorkflowRuns }
        default {
            Write-Host "Unknown option: $Choice" -ForegroundColor Yellow
        }
    }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if ($NonInteractive) {
    # CI / non-interactive mode: run comma-separated options in order
    $options = $NonInteractive -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    foreach ($opt in $options) {
        Write-Host "[CodeGuard] Running option $opt non-interactively..." -ForegroundColor Cyan
        Invoke-MenuOption -Choice $opt
    }
} else {
    # Interactive loop
    while ($true) {
        Show-Menu
        $choice = Read-Host 'Select an option'
        if ($choice.Trim().ToUpper() -eq 'Q') {
            Write-Host 'Goodbye!' -ForegroundColor Cyan
            break
        }
        Invoke-MenuOption -Choice $choice
    }
}
