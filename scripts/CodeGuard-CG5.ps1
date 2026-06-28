# GrantFlow CodeGuard v5 - Self-Learning AI Code Guardian
# Usage: powershell -ExecutionPolicy Bypass -File .\CG5.ps1
# Modes: Menu, Scan, QuickScan, Test, GeoCrawl, Evolve, CrossFile, MatchAudit, AnyaAudit, MissionVerify, All, Deep
# Auto-fixes default to branch codeguard/run-<timestamp> + PR into main (CI runs before merge).
# Set CODEGUARD_COMMIT_TO_MAIN=1 only if you intentionally want direct commits to main.
param([ValidateSet('A','Menu','Scan','QuickScan','Test','GeoCrawl','Evolve','CrossFile','MatchAudit','AnyaAudit','MissionVerify','All','Deep')][string]$Mode='Menu')
$ErrorActionPreference='Continue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
if($Mode -eq 'A'){ $Mode = 'All' }

$script:M = @{}
$script:M.V = '5.0.0'
$script:M.Owner = 'buckeye7066'
$script:M.Repo = 'GrantFlow'
$script:M.Branch = 'main'
$script:M.BaseBranch = 'main'
$script:M.UseWorkBranch = -not ($env:CODEGUARD_COMMIT_TO_MAIN -match '^(1|true|yes)$')
$script:M.WorkBranchEnsured = $false
$script:M.WorkBranchName = $null
$script:M.App = 'https://www.axiombiolabs.org/grantflow'
$script:M.RepoUrl = 'https://github.com/buckeye7066/GrantFlow'
$script:M.Rail = 'https://grantflow-production.up.railway.app'
$script:M.Claude = 'https://api.anthropic.com/v1/messages'
$script:M.Model = 'claude-sonnet-4-6'
$script:M.Script = $PSCommandPath
$script:M.LogDir = Join-Path $env:USERPROFILE 'GrantFlow-CodeGuard-Logs'
$script:M.RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:M.KBFile = Join-Path $script:M.LogDir '.codeguard-brain.json'
$script:M.Api = "https://api.github.com/repos/$($script:M.Owner)/$($script:M.Repo)"
$script:M.Log = Join-Path $script:M.LogDir "run_$($script:M.RunId).log"
$script:M.FixRpt = Join-Path $script:M.LogDir "fixes_$($script:M.RunId).md"
$script:M.TestRpt = Join-Path $script:M.LogDir "tests_$($script:M.RunId).md"
$script:M.CrawlRpt = Join-Path $script:M.LogDir "geocrawl_$($script:M.RunId).md"
$script:M.MatchRpt = Join-Path $script:M.LogDir "matchaudit_$($script:M.RunId).md"
if (!(Test-Path $script:M.LogDir)) { New-Item -ItemType Directory -Path $script:M.LogDir -Force | Out-Null }
$script:S=@{Files=0;Errs=0;Fixes=0;Pass=0;Fail=0;Crawls=0;Calls=0;T0=Get-Date;ApiCost=0.0}

# Optional: local clone for pre-commit validation (eslint + node --check). Set GRANTFLOW_REPO or place repo at a known path.
$script:M.LocalRepoRoot = $null
foreach ($candidate in @(
    $env:GRANTFLOW_REPO,
    'G:\GrantFlowbackup',
    (Join-Path $env:USERPROFILE 'GrantFlowbackup'),
    (Join-Path $env:USERPROFILE 'source\repos\GrantFlow')
)) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'package.json'))) {
        $script:M.LocalRepoRoot = $candidate
        break
    }
}

# ===================================================================
#  KNOWLEDGE BASE - Persistent memory across all runs
# ===================================================================
# The brain file stores everything CodeGuard has learned:
#   .lastScannedCommit  - SHA of last full scan (for Quick Scan diffs)
#   .lastScanDate       - when
#   .runCount           - total runs
#   .fileRisk           - { "path": score } - files with more bugs get higher scores
#   .bugPatterns        - [ { type, count, lastSeen, files } ] - recurring bug categories
#   .endpointHealth     - { "/api/path": { passCount, failCount, lastStatus, lastMs } }
#   .matchGrades        - [ { date, profile, grade, relevant, irrelevant } ] - grade history
#   .repoShape          - { backendFiles, frontendFiles, routes, services, totalFiles } - auto-discovered
#   .knownIssues        - [ "description" ] - issues Claude has flagged that haven't been fixed yet
#   .fixHistory         - [ { date, file, description } ] - what CodeGuard has fixed
#   .discoveredEndpoints - [ "/api/path" ] - routes auto-discovered from code
function Load-KB{
  if(Test-Path $script:M.KBFile){
    try{
      $raw=Get-Content $script:M.KBFile -Raw -ErrorAction Stop
      return $raw|ConvertFrom-Json
    }catch{
      Write-Log "KB corrupted, starting fresh" 'WARN'
      return [PSCustomObject]@{}
    }
  }
  return [PSCustomObject]@{}
}
function Save-KB($kb){
  try{$kb|ConvertTo-Json -Depth 10 -Compress|Set-Content $script:M.KBFile -Encoding UTF8 -ErrorAction Stop}
  catch{Write-Log "KB save failed: $($_.Exception.Message)" 'WARN'}
}
function Ensure-KBField($kb,[string]$Field,$Default){
  if(!($kb.PSObject.Properties.Name -contains $Field)){
    $kb|Add-Member -NotePropertyName $Field -NotePropertyValue $Default -Force
  }
}
function Init-KB{
  $kb=Load-KB
  Ensure-KBField $kb 'lastScannedCommit' $null
  Ensure-KBField $kb 'lastScanDate' $null
  Ensure-KBField $kb 'runCount' 0
  Ensure-KBField $kb 'fileRisk' @{}
  Ensure-KBField $kb 'bugPatterns' @()
  Ensure-KBField $kb 'endpointHealth' @{}
  Ensure-KBField $kb 'matchGrades' @()
  Ensure-KBField $kb 'repoShape' @{}
  Ensure-KBField $kb 'knownIssues' @()
  Ensure-KBField $kb 'fixHistory' @()
  Ensure-KBField $kb 'discoveredEndpoints' @()
  $kb.runCount++
  return $kb
}

$script:KB=Init-KB

# ===================================================================
#  LOGGING
# ===================================================================
function Write-Log([string]$Msg,[string]$Lv='INFO'){
  $l="[$(Get-Date -Format 'HH:mm:ss')][$Lv] $Msg"
  Add-Content -Path $script:M.Log -Value $l -ErrorAction SilentlyContinue
  $c=switch($Lv){'ERROR'{[ConsoleColor]::Red}'WARN'{[ConsoleColor]::Yellow}'OK'{[ConsoleColor]::Green}'FIX'{[ConsoleColor]::Cyan}'AI'{[ConsoleColor]::Magenta}'EVO'{[ConsoleColor]::DarkYellow}'COST'{[ConsoleColor]::DarkCyan}'LEARN'{[ConsoleColor]::Blue}default{[ConsoleColor]::Gray}}
  Write-Host $l -ForegroundColor $c
}
function Send-Notify([string]$T,[string]$B){
  try{[console]::beep(800,600);[console]::beep(1000,400)}catch{}
  Write-Host ""; Write-Host "  *** $T ***" -ForegroundColor Magenta; Write-Host "  $B" -ForegroundColor White; Write-Host ""
}
function Get-Tok([string]$Env,[string]$Pr){
  $v=[Environment]::GetEnvironmentVariable($Env)
  if($v){return $v}
  return Read-Host "  $Pr"
}

# ===================================================================
#  LEARNING FUNCTIONS - How CodeGuard gets smarter
# ===================================================================

# Record that a file had bugs (increases its risk score for future priority)
function Learn-FileRisk([string]$FilePath,[int]$BugCount){
  if(!$script:KB.fileRisk){$script:KB|Add-Member -NotePropertyName 'fileRisk' -NotePropertyValue @{} -Force}
  $current=0
  if($script:KB.fileRisk.PSObject.Properties.Name -contains $FilePath){
    $current=$script:KB.fileRisk.$FilePath
  }
  $newScore=$current + $BugCount
  $script:KB.fileRisk|Add-Member -NotePropertyName $FilePath -NotePropertyValue $newScore -Force
  Write-Log "  LEARN: ${FilePath} risk score now ${newScore}" 'LEARN'
}

# Record a bug pattern (type of bug, which files it appears in)
function Learn-BugPattern([string]$Type,[string]$FilePath){
  $existing=$script:KB.bugPatterns|Where-Object{$_.type -eq $Type}
  if($existing){
    $existing.count++
    $existing.lastSeen=(Get-Date -Format 'o')
    if($existing.files -notcontains $FilePath){
      $fList=[System.Collections.ArrayList]@($existing.files)
      [void]$fList.Add($FilePath)
      $existing.files=$fList.ToArray()
    }
  } else {
    $pattern=[PSCustomObject]@{type=$Type;count=1;lastSeen=(Get-Date -Format 'o');files=@($FilePath)}
    $pList=[System.Collections.ArrayList]@($script:KB.bugPatterns)
    [void]$pList.Add($pattern)
    $script:KB.bugPatterns=$pList.ToArray()
  }
}

# Record endpoint test result
function Learn-EndpointHealth([string]$Path,[int]$Status,[int]$Ms,[bool]$Passed){
  if(!$script:KB.endpointHealth){$script:KB|Add-Member -NotePropertyName 'endpointHealth' -NotePropertyValue @{} -Force}
  $entry=$null
  if($script:KB.endpointHealth.PSObject.Properties.Name -contains $Path){
    $entry=$script:KB.endpointHealth.$Path
  }
  if(!$entry){
    $entry=[PSCustomObject]@{passCount=0;failCount=0;lastStatus=$Status;lastMs=$Ms;lastTest=(Get-Date -Format 'o')}
    $script:KB.endpointHealth|Add-Member -NotePropertyName $Path -NotePropertyValue $entry -Force
  }
  if($Passed){$entry.passCount++}else{$entry.failCount++}
  $entry.lastStatus=$Status
  $entry.lastMs=$Ms
  $entry.lastTest=(Get-Date -Format 'o')
}

# Record match audit grade for a profile
function Learn-MatchGrade([string]$Profile,[string]$Grade,[int]$Good,[int]$Bad){
  $entry=[PSCustomObject]@{date=(Get-Date -Format 'o');profile=$Profile;grade=$Grade;relevant=$Good;irrelevant=$Bad}
  $list=[System.Collections.ArrayList]@($script:KB.matchGrades)
  [void]$list.Add($entry)
  # Keep last 500 entries
  if($list.Count -gt 500){$list.RemoveRange(0,$list.Count - 500)}
  $script:KB.matchGrades=$list.ToArray()
}

# Record a fix that was applied
function Learn-Fix([string]$FilePath,[string]$Description){
  $entry=[PSCustomObject]@{date=(Get-Date -Format 'o');file=$FilePath;description=$Description}
  $list=[System.Collections.ArrayList]@($script:KB.fixHistory)
  [void]$list.Add($entry)
  if($list.Count -gt 200){$list.RemoveRange(0,$list.Count - 200)}
  $script:KB.fixHistory=$list.ToArray()
}

# ===================================================================
#  AUTO-DISCOVER REPO SHAPE - Keeps system context current
# ===================================================================
function Update-RepoShape($tree){
  if(!$tree -or !$tree.tree){return}
  $allFiles=$tree.tree|Where-Object{$_.type -eq 'blob'}

  $backendJs=$allFiles|Where-Object{$_.path -match '^backend/' -and $_.path -match '\.(js|mjs|ts)$'}
  $frontendJs=$allFiles|Where-Object{$_.path -match '^src/' -and $_.path -match '\.(jsx?|tsx?)$'}
  $routes=$allFiles|Where-Object{$_.path -match '^backend/routes/' -and $_.path -match '\.js$'}
  $services=$allFiles|Where-Object{$_.path -match '^backend/services/' -and $_.path -match '\.js$'}
  $middleware=$allFiles|Where-Object{$_.path -match '^backend/middleware/' -and $_.path -match '\.js$'}
  $pages=$allFiles|Where-Object{$_.path -match '^src/pages/' -and $_.path -match '\.(jsx|tsx)$'}
  $components=$allFiles|Where-Object{$_.path -match '^src/components/' -and $_.path -match '\.(jsx|tsx)$'}
  $crawlers=$allFiles|Where-Object{$_.path -match 'crawler' -and $_.path -match '\.js$'}

  $shape=[PSCustomObject]@{
    totalFiles=$allFiles.Count
    backendFiles=$backendJs.Count
    frontendFiles=$frontendJs.Count
    routeFiles=$routes.Count
    serviceFiles=$services.Count
    middlewareFiles=$middleware.Count
    pageFiles=$pages.Count
    componentFiles=$components.Count
    crawlerFiles=$crawlers.Count
    discoveredAt=(Get-Date -Format 'o')
    routeList=@($routes|ForEach-Object{$_.path})
    serviceList=@($services|ForEach-Object{$_.path})
    pageList=@($pages|ForEach-Object{$_.path})
  }

  $script:KB|Add-Member -NotePropertyName 'repoShape' -NotePropertyValue $shape -Force
  Write-Log "LEARN: Repo shape updated - $($shape.totalFiles) files ($($shape.routeFiles) routes, $($shape.serviceFiles) services, $($shape.pageFiles) pages, $($shape.crawlerFiles) crawlers)" 'LEARN'
}

# Build system context dynamically from what we've learned
function Build-SystemContext{
  $shape=$script:KB.repoShape
  $routeCount=if($shape.routeFiles){$shape.routeFiles}else{'~50'}
  $serviceCount=if($shape.serviceFiles){$shape.serviceFiles}else{'~180'}
  $componentCount=if($shape.componentFiles){$shape.componentFiles}else{'~300'}
  $crawlerCount=if($shape.crawlerFiles){$shape.crawlerFiles}else{'~10'}

  # Build known issues summary from KB
  $issuesSummary=""
  if($script:KB.bugPatterns -and $script:KB.bugPatterns.Count -gt 0){
    $topBugs=$script:KB.bugPatterns|Sort-Object count -Descending|Select-Object -First 5
    $issuesSummary="`nRecurring bug patterns (from past scans): $(($topBugs|ForEach-Object{"$($_.type)($($_.count)x)"}) -join ', ')"
  }

  # Build risky files summary
  $riskyFiles=""
  if($script:KB.fileRisk -and $script:KB.fileRisk.PSObject.Properties.Count -gt 0){
    $sorted=$script:KB.fileRisk.PSObject.Properties|Sort-Object Value -Descending|Select-Object -First 8
    $riskyFiles="`nHigh-risk files (historically buggy): $(($sorted|ForEach-Object{"$($_.Name)(score:$($_.Value))"}) -join ', ')"
  }

  # Build match quality summary
  $matchSummary=""
  if($script:KB.matchGrades -and $script:KB.matchGrades.Count -gt 0){
    $recent=$script:KB.matchGrades|Select-Object -Last 20
    $gradeGroups=$recent|Group-Object grade
    $matchSummary="`nRecent match quality: $(($gradeGroups|ForEach-Object{"$($_.Name):$($_.Count)"}) -join ', ')"
  }

  # Build flaky endpoint summary
  $flakyEps=""
  if($script:KB.endpointHealth -and $script:KB.endpointHealth.PSObject.Properties.Count -gt 0){
    $flaky=$script:KB.endpointHealth.PSObject.Properties|Where-Object{$_.Value.failCount -gt 0}|Sort-Object {$_.Value.failCount} -Descending|Select-Object -First 5
    if($flaky){$flakyEps="`nFlaky endpoints: $(($flaky|ForEach-Object{"$($_.Name)(fail:$($_.Value.failCount))"}) -join ', ')"}
  }

  return @"
You are CodeGuard v$($script:M.V), an expert code auditor for GrantFlow (github.com/buckeye7066/GrantFlow).
Architecture: Express+Node20 backend (Railway), React18+Vite frontend (Vercel), SQLite database.
Codebase: $routeCount route files, $serviceCount service files, $componentCount frontend components, $crawlerCount crawlers.
Key services: matchEngine.js (scoring+decisions), relevanceFilter.js (hard disqualification), opportunityMatcher.js (pipeline insert with 5 gates), comprehensiveCrawlerOptimized.js (discovery), profileHelpers.js (signal extraction), anyaOrchestrator.js (Anya AI).

=== GRANTFLOW MISSION (15 GOALS) ===
Every line of code you review MUST be evaluated against these goals. When you find an issue, state WHICH GOAL it violates. When you fix code, state WHICH GOAL the fix serves.

GOAL 1 - REAL FUNDING: Opportunities must have an actual application path (URL, portal, mailing address). ACCEPT requires application_url. Dead records, vague mentions, and placeholder entries must not reach the pipeline.

GOAL 2 - MATCH TO NEEDS: The system maps real user needs (housing, education, medical, business, caregiving, emergency) to funding. Profile normalisation extracts need categories; the decision engine compares them to opportunity support types. Code that ignores profile needs or matches on surface keywords only violates this goal.

GOAL 3 - REJECT JUNK: Hard-reject loans, closed deadlines, wrong entity types, wrong state, institutional-only for individuals, disease-specific with no matching condition, disaster programs with no emergency context. Code that lets junk through the pipeline or removes filtering violates this goal.

GOAL 4 - SINGLE DECISION AUTHORITY: computeMatchDecision() is the sole authority. All insertion paths flow through saveToProfilePipeline(). Code that bypasses the decision engine or adds a parallel scoring path violates this goal.

GOAL 5 - FULL PROFILE DEPTH: Matching uses the full normalised profile — military, education, family, health, emergency, business, housing sections — not just surface tags. Code that only reads name/zip/type and ignores deeper sections violates this goal.

GOAL 6 - MULTIPLE APPLICANT TYPES: GrantFlow serves individuals, families, students, veterans, nonprofits, businesses, caregivers, disabled persons, and emergency-affected users. Code that assumes one profile type or collapses distinctions violates this goal.

GOAL 7 - RECALL OVER SUPPRESSION: Prefer false positives over false negatives in candidate selection; be conservative only at final acceptance. The threshold gate must not override canonical ACCEPT/REVIEW decisions. Code that aggressively filters before the decision engine runs violates this goal.

GOAL 8 - EXPLAINABLE PIPELINE: Store match_decision, match_explanation, matched_needs, eligibility_status, ineligibility_reasons, fingerprints, matcher_version, evaluated_at, match_confidence in the DB. Code that silently drops audit metadata or inserts grants without explanations violates this goal.

GOAL 9 - RE-EVALUATION: Profile fingerprints and opportunity fingerprints enable re-evaluation when data or logic changes. Code that skips fingerprint computation or ignores matcher_version violates this goal.

GOAL 10 - PROFILE IMPROVEMENT: Help users understand which profile fields improve matching. Anya must proactively identify profile gaps and suggest fields to fill. Code that treats empty profiles as acceptable without guidance violates this goal.

GOAL 11 - PROFILE-DRIVEN CRAWLING: Crawlers use location, needs, and applicant type from the profile to determine what to search. Code that runs crawlers without profile context or ignores profile data in search queries violates this goal.

GOAL 12 - PLAIN LANGUAGE: Match results include human-readable reasons[] and explanations. Code that returns raw scores without explanations or uses jargon violates this goal.

GOAL 13 - APPLICATION WORKFLOW: GrantFlow covers discovery through application — pipeline stages, proposals, documents, deadlines, monitoring, outreach, stewardship. Code that breaks the pipeline state machine or loses workflow context violates this goal.

GOAL 14 - ANYA AS STRATEGIST: Anya is a funding strategist, not a help shell. She diagnoses poor matches, rescues empty pipelines, compares rejected vs accepted, and guides profile improvement. Code that reduces Anya to navigation-only or generic responses violates this goal.

GOAL 15 - ANYA GROUNDED IN APP: Anya's responses must be grounded in real profile data, real opportunity data, and real app structure via the help knowledge registry. Code that lets Anya make claims without tool verification or hallucinate about features violates this goal.

=== STANDING GUARD RULES ===
- Any code that inserts grants without running relevanceFilter is CRITICAL (violates Goals 3, 4).
- Any code that silently drops grants with no log of WHY is an observability gap (violates Goals 7, 8).
- Any URL stored in DB without validation is a data quality risk (violates Goal 1).
- Any Anya response not grounded in actual data is misleading (violates Goals 14, 15).
- If total_found > 0 and included === 0, suppression reasoning MUST be logged (violates Goals 7, 8).
- Any threshold gate that overrides canonical ACCEPT/REVIEW is over-suppression (violates Goals 4, 7).
- Any match_reasons that don't come from the decision engine are fragmented (violates Goals 8, 12).

=== WHEN FIXING CODE ===
- State which goal(s) the bug violates
- State which goal(s) your fix serves
- Ensure the fix doesn't break other goals (e.g. fixing Goal 3 must not violate Goal 7)
- Prefer fixes that serve multiple goals simultaneously
- Never introduce a fix that reduces recall without explicit justification against Goal 7

=== CRITICAL: CODE QUALITY RULES (violations cause rejected commits) ===
Your fixes MUST NOT introduce any of these patterns. Previous CodeGuard runs introduced 54 ESLint errors across 31 files. That must never happen again.

FORBIDDEN PATTERNS:
1. DUPLICATE DECLARATIONS: Never declare the same variable name twice with const/let in the same scope
2. TRY WITHOUT CATCH: Every try block MUST have catch or finally
3. OUT-OF-SCOPE VARIABLES: Never reference a variable outside the block where it was declared
4. CONTINUE OUTSIDE LOOP: continue is only valid inside for/while/do — NOT inside forEach callbacks
5. IMPORT INSIDE FUNCTIONS: Static import declarations MUST be at module top level. Use dynamic import() for lazy loading
6. AWAIT IN NON-ASYNC: Never use await inside a non-async function
7. CONST REASSIGNMENT: Never reassign a variable declared with const — use let if mutation is needed
8. DUPLICATE OBJECT KEYS: Never use the same property name twice in an object literal
9. UNBALANCED BRACES: Ensure every { has a matching } at the correct nesting level
10. DEAD CODE: Do not leave unreachable statements after return/throw

If your fix would introduce ANY of these, DO NOT set can_auto_fix:true. Return can_auto_fix:false instead with a description of why.

This is run #$($script:KB.runCount) of CodeGuard.$issuesSummary$riskyFiles$matchSummary$flakyEps
Find REAL bugs that break the mission. Not style nits.
"@
}

# ===================================================================
#  GITHUB API
# ===================================================================
function Invoke-GH([string]$Ep,[string]$Mt='GET',$Bd=$null){
  $script:S.Calls++
  $uri=if($Ep.StartsWith('http')){$Ep}else{"$($script:M.Api)/$Ep"}
  $h=@{Authorization="Bearer $script:GH";Accept='application/vnd.github.v3+json';'User-Agent'='CodeGuard/5';'X-GitHub-Api-Version'='2022-11-28'}
  $p=@{Uri=$uri;Method=$Mt;Headers=$h;ContentType='application/json';UseBasicParsing=$true}
  if($Bd){$p.Body=$Bd|ConvertTo-Json -Depth 20 -Compress}
  try{return Invoke-RestMethod @p}catch{
    $c=$_.Exception.Response.StatusCode.value__
    if($c -eq 403 -or $c -eq 429){Write-Log "Rate limited, waiting 65s" 'WARN';Start-Sleep 65;return Invoke-RestMethod @p}
    Write-Log "GH err ($c): $($_.Exception.Message)" 'ERROR';return $null}
}
function Read-GH([string]$P){
  $r=Invoke-GH "contents/$($P)?ref=$($script:M.Branch)"
  if(!$r){return $null}
  $bytes=[System.Convert]::FromBase64String($r.content)
  $text=[System.Text.Encoding]::UTF8.GetString($bytes)
  return @{c=$text;sha=$r.sha;p=$P}
}
function Test-JSSyntax([string]$Content,[string]$FilePath){
  if($FilePath -notmatch '\.(js|mjs|jsx|ts|tsx)$'){return $true}
  $patterns=@(
    @{Name='duplicate const/let in same block';Pat='(?m)^(\s*)(const|let)\s+(\w+)\b.*\n(?:\s*(?:\/\/[^\n]*)?\n)*\s*\2\s+\3\b'},
    @{Name='continue outside loop';Pat='\.forEach\s*\([^)]*\)\s*\{[^}]*\bcontinue\b'},
    @{Name='try without catch/finally';Pat='(?s)\btry\s*\{[^{}]*\}(?!\s*(?:catch|finally))'},
    @{Name='await in non-async function';Pat='(?m)^\s*(?:export\s+)?function\s+\w+\s*\([^)]*\)\s*\{[^}]*\bawait\b'},
    @{Name='static import inside block';Pat='(?m)^(?:\s{2,}|\t+)import\s+\{[^}]+\}\s+from\s+'}
  )
  $issues=@()
  foreach($p in $patterns){
    if($Content -match $p.Pat){$issues+=$p.Name}
  }
  $openBraces=([regex]::Matches($Content,'\{')).Count
  $closeBraces=([regex]::Matches($Content,'\}')).Count
  if([math]::Abs($openBraces - $closeBraces) -gt 1){$issues+="unbalanced braces ($openBraces open, $closeBraces close)"}
  if($issues.Count -gt 0){
    Write-Log "PRE-COMMIT REJECT ${FilePath}: $($issues -join '; ')" 'ERROR'
    return $false
  }
  return $true
}

function Test-DriftGuard([string]$OldContent,[string]$NewContent,[string]$FilePath){
  if($FilePath -notmatch '\.(js|mjs|jsx|ts|tsx)$'){return $true}
  $issues=@()

  # Guard common AI drift: navigate() call added without declaring navigate.
  if($NewContent -match '(?<!\.)\bnavigate\s*\('){
    $hasNavigateDecl = $NewContent -match '\bconst\s+navigate\s*=' -or
      $NewContent -match '\blet\s+navigate\s*=' -or
      $NewContent -match '\bvar\s+navigate\s*=' -or
      $NewContent -match '\bfunction\s+navigate\s*\(' -or
      $NewContent -match '\bnavigate\s*:\s*\('
    if(-not $hasNavigateDecl){
      $issues += "navigate() used without local declaration/import wiring"
    }
  }

  # Guard against introducing hook-disable drift unless it already existed.
  if(
    ($NewContent -match 'eslint-disable-next-line\s+react-hooks/exhaustive-deps') -and
    ($OldContent -notmatch 'eslint-disable-next-line\s+react-hooks/exhaustive-deps')
  ){
    $issues += "introduced react-hooks exhaustive-deps disable directive"
  }

  if($issues.Count -gt 0){
    Write-Log "DRIFT GUARD REJECT ${FilePath}: $($issues -join '; ')" 'ERROR'
    return $false
  }
  return $true
}

function Test-MainBranchHealth(){
  if($script:M.Branch -ne $script:M.BaseBranch){return $true}
  $runs=Invoke-GH "actions/runs?branch=$($script:M.BaseBranch)&event=push&per_page=1"
  if($runs -and $runs.workflow_runs -and $runs.workflow_runs.Count -gt 0){
    $latest=$runs.workflow_runs[0]
    if($latest.status -eq 'completed' -and $latest.conclusion -eq 'failure'){
      Write-Log "GUARDRAIL: latest $($script:M.BaseBranch) push CI is failing (run $($latest.id)); blocking direct commits to $($script:M.BaseBranch). Use PR branch mode (default) or fix CI first." 'ERROR'
      Write-Log "GUARDRAIL: merge a green fix to $($script:M.BaseBranch) first, or set GRANTFLOW_REPO for LOCAL PRECOMMIT (eslint)." 'WARN'
      return $false
    }
  }
  return $true
}

function Ensure-CodeGuardWorkBranch{
  if(-not $script:M.UseWorkBranch){return}
  if($script:M.WorkBranchEnsured){return}
  if($script:M.Branch -ne $script:M.BaseBranch){
    $script:M.WorkBranchEnsured = $true
    return
  }
  $mainRef = Invoke-GH "git/refs/heads/$($script:M.BaseBranch)"
  if(!$mainRef -or !$mainRef.object.sha){
    Write-Log "WORK BRANCH: cannot resolve $($script:M.BaseBranch); fixes will stay on $($script:M.Branch)" 'ERROR'
    $script:M.WorkBranchEnsured = $true
    return
  }
  $sha = $mainRef.object.sha
  $wb = "codeguard/run-$($script:M.RunId)"
  $cr = Invoke-GH 'git/refs' 'POST' @{ ref = "refs/heads/$wb"; sha = $sha }
  if($cr){
    $script:M.Branch = $wb
    $script:M.WorkBranchName = $wb
    Write-Log "AUTO-FIX branch: $wb (merge via PR after CI — $($script:M.RepoUrl)/compare/$($script:M.BaseBranch)...$wb)" 'OK'
  }else{
    Write-Log "WORK BRANCH: create failed; commits go to $($script:M.BaseBranch). Fix token scope (repo) or network." 'ERROR'
  }
  $script:M.WorkBranchEnsured = $true
}

function New-CodeGuardPullRequest([string]$HeadBranch,[int]$FixCount){
  if(-not $HeadBranch){return}
  $headQ = "$($script:M.Owner):$HeadBranch"
  $open = Invoke-GH "pulls?head=$headQ&state=open&base=$($script:M.BaseBranch)"
  $openList = @($open)
  if($openList.Count -gt 0 -and $openList[0].html_url){
    Write-Log "PR already open for $HeadBranch : $($openList[0].html_url)" 'OK'
    return
  }
  $title = "[CodeGuard] Automated fixes ($FixCount) — $($script:M.RunId)"
  $body = "Generated by CodeGuard v$($script:M.V). **Let CI finish green before merge.**`n`n- Compare: $($script:M.RepoUrl)/compare/$($script:M.BaseBranch)...$HeadBranch"
  $pr = Invoke-GH 'pulls' 'POST' @{ title = $title; head = $HeadBranch; base = $script:M.BaseBranch; body = $body }
  if($pr -and $pr.html_url){
    Write-Log "Opened PR: $($pr.html_url)" 'OK'
    Send-Notify 'CodeGuard PR ready' $pr.html_url
  }else{
    Write-Log "PR create failed (needs pull_requests:write on token, or open compare link above)." 'WARN'
  }
}

# When GRANTFLOW_REPO / local clone exists: write proposed content, run node --check + eslint on that file, restore on failure.
function Test-LocalPreFlight([string]$Content,[string]$FilePath,[string]$PrevContent){
  if(-not $script:M.LocalRepoRoot){return $true}
  if($FilePath -notmatch '\.(js|mjs|jsx|ts|tsx)$'){return $true}
  $root = $script:M.LocalRepoRoot
  $full = Join-Path $root $FilePath
  $dir = Split-Path $full -Parent
  if(-not (Test-Path $dir)){
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    catch {
      Write-Log "LOCAL PRECOMMIT SKIP (mkdir): $($_.Exception.Message)" 'WARN'
      return $true
    }
  }
  $hadExisting = Test-Path $full
  $backup = $null
  if($hadExisting){
    try { $backup = [System.IO.File]::ReadAllText($full) } catch { $backup = $null }
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  try {
    [System.IO.File]::WriteAllText($full, $Content, $utf8)
  } catch {
    Write-Log "LOCAL PRECOMMIT SKIP (write): $($_.Exception.Message)" 'WARN'
    return $true
  }

  $failed = $false

  if($FilePath -match '\.(mjs|js)$' -and $FilePath -notmatch '\.jsx$'){
    $chk = Start-Process -FilePath 'node' -ArgumentList @('--check', $full) -WorkingDirectory $root -Wait -PassThru -NoNewWindow
    if($chk.ExitCode -ne 0){
      Write-Log "PRE-COMMIT REJECT ${FilePath}: node --check failed" 'ERROR'
      $failed = $true
    }
  }

  if(-not $failed -and (Test-Path (Join-Path $root 'node_modules\eslint'))){
    Push-Location $root
    try {
      $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if($npmCmd){
        & npm.cmd exec -- eslint --max-warnings 0 $full 2>&1 | Out-Null
      } else {
        & npm exec -- eslint --max-warnings 0 $full 2>&1 | Out-Null
      }
      if($LASTEXITCODE -ne 0){
        Write-Log "PRE-COMMIT REJECT ${FilePath}: eslint failed (same rules as CI)" 'ERROR'
        $failed = $true
      }
    } catch {
      Write-Log "LOCAL PRECOMMIT: eslint invocation failed: $($_.Exception.Message)" 'WARN'
    } finally {
      Pop-Location
    }
  } elseif(-not $failed) {
    Write-Log "LOCAL PRECOMMIT: node_modules/eslint missing; run npm ci in repo for full CI parity" 'WARN'
  }

  if($failed){
    try {
      if($null -ne $backup){ [System.IO.File]::WriteAllText($full, $backup, $utf8) }
      elseif($PrevContent){ [System.IO.File]::WriteAllText($full, $PrevContent, $utf8) }
      elseif(-not $hadExisting){ Remove-Item $full -Force -ErrorAction SilentlyContinue }
    } catch {}
    return $false
  }
  Write-Log "LOCAL PRECOMMIT OK ${FilePath}" 'OK'
  return $true
}

function Write-GH([string]$P,[string]$C,[string]$S,[string]$Msg,[string]$PrevContent=''){
  Ensure-CodeGuardWorkBranch
  if(-not (Test-MainBranchHealth)){
    $script:S.Errs++
    return $false
  }
  if(-not (Test-JSSyntax $C $P)){
    Write-Log "BLOCKED commit to ${P} - syntax validation failed" 'ERROR'
    $script:S.Errs++
    return $false
  }
  if(-not (Test-DriftGuard $PrevContent $C $P)){
    Write-Log "BLOCKED commit to ${P} - drift guard failed" 'ERROR'
    $script:S.Errs++
    return $false
  }
  if(-not (Test-LocalPreFlight $C $P $PrevContent)){
    Write-Log "BLOCKED commit to ${P} - local preflight (eslint/node) failed" 'ERROR'
    $script:S.Errs++
    return $false
  }
  $e=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($C))
  $r=Invoke-GH "contents/$P" 'PUT' @{message="[CodeGuard] $Msg";content=$e;sha=$S;branch=$script:M.Branch}
  if($r){Write-Log "Committed: $P - $Msg" 'FIX';Learn-Fix $P $Msg;return $true}
  Write-Log "Commit fail: $P" 'ERROR';return $false
}

function Get-ChangedFiles([string]$SinceCommit){
  if(!$SinceCommit){return $null}
  $diff=Invoke-GH "compare/${SinceCommit}...$($script:M.BaseBranch)"
  if(!$diff -or !$diff.files){return $null}
  return $diff.files|Where-Object{
    $_.status -ne 'removed' -and
    $_.filename -match '\.(js|jsx|mjs|ts|tsx)$' -and
    $_.filename -notmatch '(node_modules|dist|coverage|test-results|seed-data|__snapshots__|fixtures)/' -and
    $_.filename -notmatch 'package-lock'
  }|ForEach-Object{$_.filename}
}

# ===================================================================
#  CLAUDE API (with cost tracking)
# ===================================================================
function Invoke-Claude([string]$Sys,[string]$Usr,[int]$Mx=4096){
  $script:S.Calls++
  $h=@{'x-api-key'=$script:ANT;'anthropic-version'='2023-06-01';'Content-Type'='application/json'}
  $b=@{model=$script:M.Model;max_tokens=$Mx;system=$Sys;messages=@(@{role='user';content=$Usr})}
  $jsonBody=$b|ConvertTo-Json -Depth 10 -Compress
  try{
    $r=Invoke-RestMethod -Uri $script:M.Claude -Method POST -Headers $h -Body ([System.Text.Encoding]::UTF8.GetBytes($jsonBody)) -UseBasicParsing -TimeoutSec 180
    $textBlock=$r.content|Where-Object{$_.type -eq 'text'}|Select-Object -First 1
    $inTok=$r.usage.input_tokens;$outTok=$r.usage.output_tokens
    $cost=($inTok*3e-6)+($outTok*15e-6)
    $script:S.ApiCost+=$cost
    return $textBlock.text
  }catch{
    $c=try{$_.Exception.Response.StatusCode.value__}catch{'?'}
    $errBody=''
    try{
      $sr=[System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
      $errBody=$sr.ReadToEnd();$sr.Close()
    }catch{}
    if($errBody){Write-Log "Claude err ($c): $errBody" 'ERROR'}
    else{Write-Log "Claude err ($c): $($_.Exception.Message)" 'ERROR'}
    if($c -eq 429){Write-Log "Rate limited, waiting 60s" 'WARN';Start-Sleep 60}
    if($c -eq 400 -and $script:S.Calls -le 3){
      Write-Log "Model: $($script:M.Model) | API: $($script:M.Claude) | Body length: $($jsonBody.Length)" 'WARN'
    }
    return $null
  }
}
function Invoke-CJ([string]$Sys,[string]$Usr,[int]$Mx=4096){
  $r=Invoke-Claude $Sys $Usr $Mx
  if(!$r){return $null}
  $r=$r -replace '^\s*```json\s*','' -replace '\s*```\s*$','' -replace '^\s*```\s*',''
  try{return $r.Trim()|ConvertFrom-Json}catch{Write-Log "JSON parse fail" 'WARN';return $null}
}

# ===================================================================
#  RISK-BASED FILE SORTING - High-risk files first
# ===================================================================
function Sort-ByRisk([string[]]$Files){
  # Static priority tiers
  $pri=@('backend/server.js','backend/start.js','backend/middleware/','backend/startup/',
    'backend/routes/','backend/config/','backend/db/','backend/services/anya',
    'backend/services/match','backend/services/relevance','backend/services/profile',
    'backend/services/opportunity','backend/services/crawler','backend/services/comprehensive',
    'backend/services/','backend/apply/','backend/utils/',
    'src/api/','src/stores/','src/pages/','src/components/')

  $riskMap=$script:KB.fileRisk

  return $Files|Sort-Object{
    $p=$_
    # Static tier (0 = highest priority)
    $tier=$pri.Count
    for($i=0;$i -lt $pri.Count;$i++){if($p.StartsWith($pri[$i])){$tier=$i;break}}

    # Historical risk score (negative = higher priority)
    $risk=0
    if($riskMap -and $riskMap.PSObject.Properties.Name -contains $p){$risk=$riskMap.$p}

    # Combined: tier * 1000 minus risk score so risky files bubble up
    ($tier * 1000) - $risk
  }
}

# ===================================================================
#  [1] SCAN AND FIX
# ===================================================================
function Start-ScanAndFix{
  param([string[]]$FileFilter=$null)
  $sysCtx=Build-SystemContext
  Write-Log "=== SCAN AND FIX ===" 'OK'

  $tree=$null
  $filePaths=$FileFilter
  if(!$filePaths){
    $tree=Invoke-GH "git/trees/$($script:M.Branch)?recursive=1"
    if(!$tree){Write-Log "Cannot fetch tree" 'ERROR';return}
    Update-RepoShape $tree
    $filePaths=$tree.tree|Where-Object{
      $_.type -eq 'blob' -and $_.path -match '\.(js|jsx|mjs|ts|tsx)$' -and
      $_.path -notmatch '(node_modules|dist|coverage|test-results|seed-data|__snapshots__|fixtures|scripts/)' -and
      $_.path -notmatch 'package-lock' -and $_.size -lt 300000
    }|ForEach-Object{$_.path}
  }

  $sorted=Sort-ByRisk $filePaths
  $total=$sorted.Count
  Write-Log "Scanning $total files (risk-prioritized)..." 'AI'

  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# CodeGuard Scan Report v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Files: $total | Model: $($script:M.Model)")
  [void]$rpt.Add("")

  $fixes=[System.Collections.ArrayList]::new()
  $n=0
  $batch=[System.Collections.ArrayList]::new()
  $batchSize=0
  $maxBatchChars=12000

  foreach($fp in $sorted){
    $n++
    $pct=[math]::Round(($n/$total)*100,1)
    Write-Progress -Activity "Scanning" -Status "$n/$total ($pct%) $fp" -PercentComplete $pct
    if($n % 25 -eq 0){Write-Log "Progress: $n/$total | Errors:$($script:S.Errs) Fixes:$($script:S.Fixes) | Cost:`$$([math]::Round($script:S.ApiCost,2))" 'COST'}

    $fd=Read-GH $fp
    if(!$fd){continue}
    $script:S.Files++

    if($fd.c.Length -lt 4000 -and ($batchSize + $fd.c.Length) -lt $maxBatchChars){
      [void]$batch.Add($fd)
      $batchSize += $fd.c.Length
      if($batch.Count -lt 3){continue}
    }

    $filesToAnalyze=if($batch.Count -gt 0){$batch.ToArray()}else{@($fd)}
    if($batch.Count -gt 0 -and $fd.c.Length -ge 4000){$filesToAnalyze=$batch.ToArray()}

    $promptParts=foreach($af in $filesToAnalyze){"FILE: $($af.p)`n$($af.c)"}
    $prompt=@"
Analyze for bugs that break GrantFlow's mission goals (see system context). For each error, state which goal(s) it violates. For each fix, state which goal(s) it serves and confirm it does not break other goals. Return ONLY JSON:
{"results":[{"file":"PATH","errors":[{"line":null,"severity":"CRITICAL","type":"category","goals_violated":[4,7],"description":"problem — violates Goal X because...","original_code":"exact buggy code","fixed_code":"corrected code","goals_served":[4,7],"fix_rationale":"why this fix aligns with Goals X,Y without breaking Goal Z","can_auto_fix":true}],"summary":"one line"}]}
No errors: omit the file or give empty errors array.

$($promptParts -join "`n`n---`n`n")
"@
    $a=Invoke-CJ $sysCtx $prompt
    if($a -and $a.results){
      foreach($result in $a.results){
        if(!$result.errors -or $result.errors.Count -eq 0){continue}
        $script:S.Errs += $result.errors.Count
        Write-Log "  $($result.file): $($result.errors.Count) issue(s)" 'WARN'

        # LEARN from findings
        Learn-FileRisk $result.file $result.errors.Count
        foreach($e in $result.errors){Learn-BugPattern $e.type $result.file}

        [void]$rpt.Add("## $($result.file)")
        [void]$rpt.Add("$($result.summary)")
        foreach($e in $result.errors){
          $goalRef=if($e.goals_violated){"[Goals $($e.goals_violated -join ',')]"}else{''}
          [void]$rpt.Add("- [$($e.severity)] $($e.type) $goalRef`: $($e.description)")
        }
        [void]$rpt.Add("")

        $fixable=$result.errors|Where-Object{$_.can_auto_fix -and $_.original_code -and $_.fixed_code}
        if($fixable.Count -gt 0){
          $targetFd=$filesToAnalyze|Where-Object{$_.p -eq $result.file}|Select-Object -First 1
          if($targetFd){
            $content=$targetFd.c;$applied=0
            foreach($fx in $fixable){
              $orig=[string]$fx.original_code;$repl=[string]$fx.fixed_code
              if($orig -and $content.Contains($orig)){
                $content=$content.Replace($orig,$repl);$applied++
                $goalServed=if($fx.goals_served){"(Goals $($fx.goals_served -join ','))"}else{''}
                [void]$fixes.Add("$($result.file): $($fx.description) $goalServed")
              }
            }
            if($applied -gt 0 -and $content -ne $targetFd.c){
              $commitGoals=($fixable|Where-Object{$_.goals_served}|ForEach-Object{$_.goals_served}|Sort-Object -Unique) -join ','
              $commitMsg=if($commitGoals){"Fix $applied issue(s) [Goals $commitGoals]"}else{"Fix $applied issue(s)"}
              if(Write-GH $result.file $content $targetFd.sha $commitMsg $targetFd.c){$script:S.Fixes+=$applied}
              Start-Sleep 1
            }
          }
        }
      }
    }
    $batch.Clear();$batchSize=0
    if($n % 8 -eq 0){Start-Sleep -Milliseconds 400}
  }

  # Flush remaining batch
  if($batch.Count -gt 0){
    $promptParts=foreach($af in $batch){"FILE: $($af.p)`n$($af.c)"}
    $a=Invoke-CJ $sysCtx "Analyze for bugs that break GrantFlow's mission goals (see system context). For each error state which goals_violated. For each fix state goals_served and fix_rationale. Return ONLY JSON: {`"results`":[{`"file`":`"PATH`",`"errors`":[{`"line`":null,`"severity`":`"CRITICAL`",`"type`":`"category`",`"goals_violated`":[],`"description`":`"problem`",`"original_code`":`"`",`"fixed_code`":`"`",`"goals_served`":[],`"fix_rationale`":`"`",`"can_auto_fix`":true}],`"summary`":`"`"}]}`n$($promptParts -join "`n---`n")"
    if($a -and $a.results){
      foreach($result in $a.results){
        if($result.errors -and $result.errors.Count -gt 0){
          $script:S.Errs += $result.errors.Count
          Learn-FileRisk $result.file $result.errors.Count
          foreach($e in $result.errors){Learn-BugPattern $e.type $result.file}
          Write-Log "  $($result.file): $($result.errors.Count) issue(s)" 'WARN'
          [void]$rpt.Add("## $($result.file)")
          foreach($e in $result.errors){[void]$rpt.Add("- [$($e.severity)] $($e.type): $($e.description)")}
          [void]$rpt.Add("")
        }
      }
    }
  }

  Write-Progress -Activity "Scanning" -Completed

  # Save state
  $headRef=Invoke-GH "git/refs/heads/$($script:M.BaseBranch)"
  if($headRef){
    $script:KB|Add-Member -NotePropertyName 'lastScannedCommit' -NotePropertyValue $headRef.object.sha -Force
    $script:KB|Add-Member -NotePropertyName 'lastScanDate' -NotePropertyValue (Get-Date -Format 'o') -Force
  }
  Save-KB $script:KB

  [void]$rpt.Add("---")
  [void]$rpt.Add("## Summary")
  [void]$rpt.Add("Scanned: $($script:S.Files) | Errors: $($script:S.Errs) | Fixes: $($script:S.Fixes) | API cost: `$$([math]::Round($script:S.ApiCost,2))")
  if($fixes.Count -gt 0){[void]$rpt.Add("");[void]$rpt.Add("## Fixes Applied");foreach($fx in $fixes){[void]$rpt.Add("- $fx")}}

  # Append learning summary
  if($script:KB.bugPatterns -and $script:KB.bugPatterns.Count -gt 0){
    [void]$rpt.Add("")
    [void]$rpt.Add("## Learned Bug Patterns (cumulative)")
    $topBugs=$script:KB.bugPatterns|Sort-Object count -Descending|Select-Object -First 10
    foreach($bp in $topBugs){[void]$rpt.Add("- $($bp.type): $($bp.count) occurrences across $($bp.files.Count) file(s)")}
  }

  if($script:S.Fixes -gt 0 -and $script:M.WorkBranchName){
    New-CodeGuardPullRequest $script:M.WorkBranchName $script:S.Fixes
  }

  Set-Content -Path $script:M.FixRpt -Value ($rpt -join "`n") -Encoding UTF8
  Write-Log "Scan done. Errors:$($script:S.Errs) Fixes:$($script:S.Fixes) Cost:`$$([math]::Round($script:S.ApiCost,2))" 'OK'
  Send-Notify "Scan Done" "Errors:$($script:S.Errs) Fixes:$($script:S.Fixes) Cost:`$$([math]::Round($script:S.ApiCost,2))"
  Start-Process $script:M.FixRpt
}

# ===================================================================
#  [Q] QUICK SCAN - Only changed files since last scan
# ===================================================================
function Start-QuickScan{
  Write-Log "=== QUICK SCAN - Changed files only ===" 'OK'
  $lastCommit=$script:KB.lastScannedCommit
  if(!$lastCommit){
    Write-Log "No previous scan found. Checking last 20 commits..." 'WARN'
    $commits=Invoke-GH "commits?sha=$($script:M.BaseBranch)&per_page=20"
    if($commits -and $commits.Count -ge 2){$lastCommit=$commits[-1].sha}
    else{Write-Log "Cannot determine diff range. Run full [1] Scan first." 'ERROR';return}
  }

  Write-Log "Diffing against commit: $($lastCommit.Substring(0,8))... (scanned $($script:KB.lastScanDate))" 'INFO'
  $changed=Get-ChangedFiles $lastCommit
  if(!$changed -or $changed.Count -eq 0){
    Write-Log "No files changed since last scan. Codebase is clean." 'OK'
    return
  }

  Write-Log "Found $($changed.Count) changed file(s)" 'OK'
  foreach($f in $changed){Write-Log "  + $f" 'INFO'}

  Start-ScanAndFix -FileFilter $changed
}

# ===================================================================
#  [2] TEST AND FIX
# ===================================================================
function Start-TestAndFix{
  $sysCtx=Build-SystemContext
  Write-Log "=== TEST AND FIX ===" 'OK'
  $adm=Get-Tok 'GRANTFLOW_ADMIN_TOKEN' 'ADMIN_TOKEN (Enter to skip admin)'
  $base=$script:M.Rail
  $ah=@{'Content-Type'='application/json';Accept='application/json'}
  if($adm){$ah['X-Admin-Token']=$adm;$ah['Authorization']="Bearer $adm"}

  # Static endpoints plus any auto-discovered ones
  $eps=@(
    @{m='GET';p='/healthz';a=$false;n='Health'}
    @{m='GET';p='/api/meta/build';a=$false;n='Build info'}
    @{m='GET';p='/api/version';a=$false;n='Version'}
    @{m='GET';p='/api/auth/me';a=$true;n='Auth me'}
    @{m='GET';p='/api/profiles?limit=3';a=$true;n='Profiles list'}
    @{m='GET';p='/api/profiles/schema';a=$false;n='Profile schema'}
    @{m='GET';p='/api/opportunities?limit=5';a=$false;n='Opportunities'}
    @{m='GET';p='/api/opportunities/meta/sources';a=$false;n='Opportunity sources'}
    @{m='GET';p='/api/opportunities/geo/summary';a=$false;n='Geo summary'}
    @{m='GET';p='/api/discover-grants?zip=37311';a=$false;n='Discover TN'}
    @{m='GET';p='/api/discover-grants?zip=44114';a=$false;n='Discover OH'}
    @{m='GET';p='/api/discover-grants?zip=15010';a=$false;n='Discover PA'}
    @{m='GET';p='/api/grants?limit=3';a=$true;n='Pipeline grants'}
    @{m='GET';p='/api/matching/health';a=$false;n='Match engine health'}
    @{m='GET';p='/api/organizations?limit=3';a=$true;n='Organizations'}
    @{m='GET';p='/api/crawlers';a=$false;n='Crawlers'}
    @{m='GET';p='/api/real-crawlers';a=$false;n='Real crawlers'}
    @{m='GET';p='/api/services';a=$false;n='Services catalog'}
    @{m='GET';p='/api/documents?limit=3';a=$true;n='Documents'}
    @{m='GET';p='/api/colleges/local-funding?zip=37311';a=$false;n='College funding TN'}
    @{m='GET';p='/api/anya/health';a=$true;n='Anya health'}
    @{m='GET';p='/api/admin/diagnostics';a=$true;n='Admin diagnostics'}
    @{m='GET';p='/api/admin/pipeline-health';a=$true;n='Pipeline health'}
    @{m='GET';p='/api/source-directory?limit=3';a=$false;n='Source directory'}
    @{m='GET';p='/api/crawl-logs?limit=3';a=$false;n='Crawl logs'}
  )

  # Add any endpoints auto-discovered from route files that aren't in the static list
  $staticPaths=$eps|ForEach-Object{$_.p -replace '\?.*',''}
  if($script:KB.discoveredEndpoints){
    foreach($de in $script:KB.discoveredEndpoints){
      $clean=$de -replace '\?.*',''
      if($staticPaths -notcontains $clean){
        $eps+=@{m='GET';p=$de;a=$false;n='Auto-discovered'}
      }
    }
  }

  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# Test Report v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Target: $base | Endpoints: $($eps.Count)")
  [void]$rpt.Add("")
  $pass=0;$fail=0;$skip=0;$fails=[System.Collections.ArrayList]::new()

  for($i=0;$i -lt $eps.Count;$i++){
    $ep=$eps[$i]
    if($ep.a -and !$adm){[void]$rpt.Add("SKIP $($ep.p) - no auth token");$skip++;continue}
    $sw=[System.Diagnostics.Stopwatch]::StartNew()
    try{
      $r=Invoke-WebRequest -Uri "$base$($ep.p)" -Method $ep.m -Headers $ah -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      $sw.Stop();$ms=$sw.ElapsedMilliseconds
      [void]$rpt.Add("PASS [$($r.StatusCode)] $($ep.p) (${ms}ms) $($ep.n)")
      $pass++;$script:S.Pass++
      Learn-EndpointHealth $ep.p $r.StatusCode $ms $true
      Write-Log "  PASS [$($r.StatusCode)] $($ep.p) (${ms}ms)" 'OK'

      if($ep.p -match 'discover-grants'){
        $bd=$r.Content|ConvertFrom-Json -ErrorAction SilentlyContinue
        $cnt=0
        if($bd.results){$cnt=$bd.results.Count}elseif($bd.opportunities){$cnt=$bd.opportunities.Count}
        if($cnt -eq 0){Write-Log "  BIZ-WARN: Discovery returned 0 results" 'WARN';[void]$rpt.Add("  BIZ-WARN: 0 results")}
        else{Write-Log "  BIZ-OK: $cnt results" 'OK'}
      }
      if($ep.p -match '/api/anya/health'){
        $bd=$r.Content|ConvertFrom-Json -ErrorAction SilentlyContinue
        if($bd.status -ne 'ok' -and $bd.status -ne 'healthy'){Write-Log "  BIZ-WARN: Anya status '$($bd.status)'" 'WARN'}
      }
    }catch{
      $sw.Stop();$ms=$sw.ElapsedMilliseconds
      $c=try{$_.Exception.Response.StatusCode.value__}catch{'ERR'}
      $em=$_.Exception.Message -replace '\r?\n',' '
      if($em.Length -gt 80){$em=$em.Substring(0,80)+'...'}
      [void]$rpt.Add("FAIL [$c] $($ep.p) (${ms}ms) $em")
      $fail++;$script:S.Fail++
      Learn-EndpointHealth $ep.p ([int]$c) $ms $false
      [void]$fails.Add(@{e="$($ep.m) $($ep.p)";c=$c;m=$em;n=$ep.n})
      Write-Log "  FAIL [$c] $($ep.p)" 'ERROR'
    }
    Start-Sleep -Milliseconds 200
  }

  Save-KB $script:KB

  [void]$rpt.Add("")
  [void]$rpt.Add("## Summary: PASS=$pass FAIL=$fail SKIP=$skip")

  # Show endpoint reliability trends from KB
  if($script:KB.endpointHealth -and $script:KB.endpointHealth.PSObject.Properties.Count -gt 0){
    $chronic=$script:KB.endpointHealth.PSObject.Properties|Where-Object{$_.Value.failCount -gt 2}|Sort-Object {$_.Value.failCount} -Descending
    if($chronic){
      [void]$rpt.Add("")
      [void]$rpt.Add("## Chronically Failing Endpoints (across all runs)")
      foreach($ch in $chronic){[void]$rpt.Add("- $($ch.Name): $($ch.Value.failCount) failures / $($ch.Value.passCount) passes")}
    }
  }

  if($fails.Count -gt 0){
    [void]$rpt.Add("")
    [void]$rpt.Add("## Failures")
    foreach($f in $fails){[void]$rpt.Add("- $($f.e) ($($f.n)): $($f.c) - $($f.m)")}
    Write-Log "Asking Claude to diagnose $($fails.Count) failure(s)..." 'AI'
    $fs=($fails|ForEach-Object{"$($_.e) -> $($_.c): $($_.m)"})|Out-String
    $dx=Invoke-Claude $sysCtx "These endpoints fail on the live GrantFlow deployment:`n$fs`nWhat are the likely causes and which files need fixing?"
    if($dx){[void]$rpt.Add("");[void]$rpt.Add("## Claude Diagnosis");[void]$rpt.Add($dx)}
  }

  Set-Content -Path $script:M.TestRpt -Value ($rpt -join "`n") -Encoding UTF8
  Write-Log "Tests done. Pass:$pass Fail:$fail Skip:$skip" 'OK'
  Send-Notify "Tests Done" "Pass:$pass Fail:$fail Skip:$skip"
  Start-Process $script:M.TestRpt
}

# ===================================================================
#  [3] GEO CRAWL
# ===================================================================
function Start-GeoCrawl{
  Write-Log "=== GEO CRAWL ===" 'OK'
  $adm=Get-Tok 'GRANTFLOW_ADMIN_TOKEN' 'ADMIN_TOKEN'
  if(!$adm){Write-Log "Need admin token for geo crawl" 'ERROR';return}
  $h=@{'Content-Type'='application/json';'X-Admin-Token'=$adm;Authorization="Bearer $adm"}
  $base=$script:M.Rail

  $sts=@('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')

  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# GeoCrawl Report v$($script:M.V)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
  [void]$rpt.Add("")
  $ok=0;$er=0

  foreach($st in $sts){
    $pctDone=[math]::Round((($ok+$er)/$sts.Count)*100)
    Write-Progress -Activity "GeoCrawl" -Status "$st ($ok launched)" -PercentComplete $pctDone
    $body=@{state=$st;discover_local=$true;max_zips=0;rate_limit_ms=800;batch_size=25}
    try{
      $r=Invoke-RestMethod -Uri "$base/api/geo-crawl/start" -Method POST -Headers $h -Body ($body|ConvertTo-Json) -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop
      $rid=$r.run_id;if(!$rid){$rid=$r.id}
      [void]$rpt.Add("OK $st run:$rid")
      $ok++;$script:S.Crawls++
      Write-Log "  $st started (job: $rid)" 'OK'
    }catch{
      $em=$_.Exception.Message -replace '\r?\n',' '
      [void]$rpt.Add("FAIL $st $em")
      $er++
      Write-Log "  $st FAIL: $em" 'ERROR'
      if($em -match '429|rate'){Write-Log "Rate limited, waiting 30s" 'WARN';Start-Sleep 30}
    }
    Start-Sleep 2
  }
  Write-Progress -Activity "GeoCrawl" -Completed

  [void]$rpt.Add("")
  [void]$rpt.Add("## Result: $ok / $($sts.Count) states launched | $er failures")
  Set-Content -Path $script:M.CrawlRpt -Value ($rpt -join "`n") -Encoding UTF8
  Write-Log "GeoCrawl: $ok/$($sts.Count) states launched" 'OK'
  Send-Notify "GeoCrawl" "$ok/$($sts.Count) states launched"
  Start-Process $script:M.CrawlRpt
}

# ===================================================================
#  [4] EVOLVE - Analyze app for improvements (no fake self-mutation)
# ===================================================================
function Start-Evolve{
  $sysCtx=Build-SystemContext
  Write-Log "=== EVOLVE - Analyzing GrantFlow for improvements ===" 'EVO'
  $evoRpt=Join-Path $script:M.LogDir "evolution_$($script:M.RunId).md"
  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# Evolution Report v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
  [void]$rpt.Add("")

  # Use discovered repo shape to pick key files, or fall back to known ones
  $keyFiles=@(
    'backend/server.js','backend/start.js',
    'backend/services/matchingEngine.js','backend/services/relevanceFilter.js',
    'backend/services/opportunityMatcher.js','backend/services/profileHelpers.js',
    'backend/services/comprehensiveCrawlerOptimized.js',
    'backend/services/anyaAdminTools.js','backend/services/anyaToolRegistry.js',
    'backend/routes/discovery.js','backend/routes/matching.js','backend/routes/realCrawlers.js',
    'backend/services/crawlers/crawlerManager.js',
    'backend/middleware/authIdentity.js','backend/db/index.js',
    'src/pages/Pipeline.jsx','src/pages/DiscoverGrants.jsx','src/components/pipeline/GrantCard.jsx'
  )

  # Also include highest-risk files from KB that aren't already in the list
  if($script:KB.fileRisk -and $script:KB.fileRisk.PSObject.Properties.Count -gt 0){
    $riskyExtra=$script:KB.fileRisk.PSObject.Properties|Sort-Object Value -Descending|Select-Object -First 5|ForEach-Object{$_.Name}
    foreach($rf in $riskyExtra){if($keyFiles -notcontains $rf){$keyFiles+=$rf}}
  }

  Write-Log "Gathering $($keyFiles.Count) key files for analysis..." 'EVO'
  $ctx=""
  foreach($kf in $keyFiles){
    $fd=Read-GH $kf
    if($fd){
      $lines=($fd.c -split "`n")|Select-Object -First 120
      $ctx += "`n=== $kf (first 120 lines) ===`n$($lines -join "`n")"
    }
  }

  # Include learning context so Claude knows what has been fixed before
  $learnCtx=""
  if($script:KB.fixHistory -and $script:KB.fixHistory.Count -gt 0){
    $recentFixes=$script:KB.fixHistory|Select-Object -Last 10
    $learnCtx="`n`nRECENT FIXES BY CODEGUARD:`n$(($recentFixes|ForEach-Object{"- $($_.date): $($_.file) - $($_.description)"})|Out-String)"
  }
  if($script:KB.bugPatterns -and $script:KB.bugPatterns.Count -gt 0){
    $topBugs=$script:KB.bugPatterns|Sort-Object count -Descending|Select-Object -First 5
    $learnCtx+="`nRECURRING BUG PATTERNS:`n$(($topBugs|ForEach-Object{"- $($_.type): $($_.count)x in $($_.files -join ', ')"})|Out-String)"
  }

  Write-Log "Claude analyzing app for improvements..." 'AI'
  $appA=Invoke-CJ $sysCtx @"
EVOLUTION MODE. Analyze GrantFlow holistically for the MISSION: helping people find real funding.
Focus on: matching accuracy, crawler coverage, pipeline quality, Anya capability, auth gaps, data integrity.
Do NOT suggest changes that have already been made (see RECENT FIXES below).
Return JSON only:
{"app_improvements":[{"file":"path","priority":"HIGH","description":"what to change","impact":"user benefit"}],"anya_upgrades":[{"name":"pattern","description":"why this helps"}],"missing_funding_sources":[{"name":"source","url":"if known","description":"what it covers","profiles":"who benefits"}]}

KEY FILES:$ctx$learnCtx
"@

  if($appA){
    if($appA.app_improvements){
      [void]$rpt.Add("## App Improvements")
      foreach($imp in $appA.app_improvements){
        [void]$rpt.Add("- [$($imp.priority)] **$($imp.file)**: $($imp.description)")
        [void]$rpt.Add("  Impact: $($imp.impact)")
      }
      [void]$rpt.Add("")
    }
    if($appA.anya_upgrades){
      [void]$rpt.Add("## Anya Upgrade Proposals")
      foreach($au in $appA.anya_upgrades){[void]$rpt.Add("- **$($au.name)**: $($au.description)")}
      [void]$rpt.Add("")
    }
    if($appA.missing_funding_sources){
      [void]$rpt.Add("## Missing Funding Sources")
      foreach($ms in $appA.missing_funding_sources){
        [void]$rpt.Add("- **$($ms.name)**: $($ms.description)")
        if($ms.profiles){[void]$rpt.Add("  Benefits: $($ms.profiles)")}
      }
      [void]$rpt.Add("")
    }
  }

  Set-Content -Path $evoRpt -Value ($rpt -join "`n") -Encoding UTF8
  Save-KB $script:KB
  Write-Log "Evolution analysis complete." 'EVO'
  Send-Notify "Evolution Complete" "See report for improvement proposals"
  Start-Process $evoRpt
}

# ===================================================================
#  [5] CROSS-FILE ANALYSIS
# ===================================================================
function Start-CrossFileAnalysis{
  $sysCtx=Build-SystemContext
  Write-Log "=== CROSS-FILE ANALYSIS ===" 'AI'
  $tree=Invoke-GH "git/trees/$($script:M.Branch)?recursive=1"
  if(!$tree){Write-Log "Cannot fetch tree" 'ERROR';return}

  Update-RepoShape $tree

  $files=$tree.tree|Where-Object{
    $_.type -eq 'blob' -and $_.path -match '\.(js|jsx|mjs|ts|tsx)$' -and
    $_.path -notmatch '(node_modules|dist|coverage|test-results|seed-data|__snapshots__|fixtures|scripts/)' -and
    $_.path -notmatch 'package-lock' -and $_.size -lt 300000
  }
  $total=$files.Count
  Write-Log "Pass 1: Building inventory of $total files..." 'AI'

  $inventory=[System.Collections.ArrayList]::new()
  $n=0
  $discoveredRoutes=[System.Collections.ArrayList]::new()

  foreach($f in $files){
    $n++
    if($n % 20 -eq 0){
      Write-Progress -Activity "Pass 1: Inventory" -Status "$n/$total" -PercentComplete (($n/$total)*100)
      Write-Log "Pass 1: $n/$total | Cost:`$$([math]::Round($script:S.ApiCost,2))" 'COST'
    }
    if($n % 8 -eq 0){Start-Sleep -Milliseconds 400}
    $fd=Read-GH $f.path
    if(!$fd){continue}

    $sig=Invoke-CJ "Extract code signatures. Return ONLY JSON." @"
{"path":"$($f.path)","exports":["exported names"],"imports":[{"from":"module","names":["names"]}],"db_calls":["tables"],"api_routes":[{"method":"GET","path":"/api/...","auth":"none|inline|router"}],"async_issues":["any db call without await"]}

FILE: $($f.path)
$($fd.c)
"@
    if($sig){
      [void]$inventory.Add($sig)
      # Auto-discover API routes for future test runs
      if($sig.api_routes){
        foreach($rt in $sig.api_routes){
          if($rt.path -and $rt.path -match '^/api/'){[void]$discoveredRoutes.Add($rt.path)}
        }
      }
    }
  }
  Write-Progress -Activity "Pass 1" -Completed
  Write-Log "Pass 1 done. $($inventory.Count) files, $($discoveredRoutes.Count) routes discovered." 'OK'

  # LEARN: Save discovered endpoints for future Test runs
  if($discoveredRoutes.Count -gt 0){
    $script:KB|Add-Member -NotePropertyName 'discoveredEndpoints' -NotePropertyValue @($discoveredRoutes|Sort-Object -Unique) -Force
    Write-Log "LEARN: Saved $($discoveredRoutes.Count) discovered API routes for future testing" 'LEARN'
  }

  Write-Log "Pass 2: Cross-referencing..." 'AI'
  $sigSummary=[System.Text.StringBuilder]::new()
  foreach($inv in $inventory){
    [void]$sigSummary.AppendLine("FILE: $($inv.path)")
    if($inv.exports -and $inv.exports.Count -gt 0){[void]$sigSummary.AppendLine("  EXP: $($inv.exports -join ', ')")}
    if($inv.imports){foreach($imp in $inv.imports){[void]$sigSummary.AppendLine("  IMP $($imp.from): $($imp.names -join ', ')")}}
    if($inv.api_routes){foreach($rt in $inv.api_routes){[void]$sigSummary.AppendLine("  ROUTE: $($rt.method) $($rt.path) [$($rt.auth)]")}}
    if($inv.async_issues -and $inv.async_issues.Count -gt 0){[void]$sigSummary.AppendLine("  ASYNC: $($inv.async_issues -join '; ')")}
  }
  $sigText=$sigSummary.ToString()
  if($sigText.Length -gt 120000){$sigText=$sigText.Substring(0,120000)+"`n[TRUNCATED]"}

  $crossAnalysis=Invoke-CJ $sysCtx @"
CROSS-FILE ANALYSIS. Apply the 15 GrantFlow mission goals (see system context) across files. Find bugs visible only by reading multiple files together:

STRUCTURAL CHECKS:
1. Import mismatches (import X from Y but Y doesn't export X)
2. API contract mismatches (backend returns shape X, frontend expects Y)
3. Missing await on async calls
4. Auth gaps on sensitive routes

MISSION-ALIGNMENT CHECKS:
5. Matching pipeline breaks (profileHelpers outputs field X, matchingEngine reads field Y) [Goal 2,5]
6. PIPELINE INSERTION BYPASS: Find ALL code paths that insert grants into the database. Each path MUST flow through saveToProfilePipeline() and relevanceFilter. Any bypass is CRITICAL [Goal 3,4]
7. SUPPRESSION VISIBILITY: Check if the matching/filtering pipeline logs WHY grants are rejected. Silent drops violate [Goal 7,8]
8. DECISION FRAGMENTATION: Check if any code path makes accept/reject decisions outside computeMatchDecision(). Parallel scoring paths violate [Goal 4]
9. PROFILE DEPTH: Check if matching code reads full normalised profile sections (military, health, education, family, housing, emergency, business) or only surface fields like name/zip/type [Goal 5,6]
10. AUDIT COLUMN PERSISTENCE: Check if all code that calls saveToProfilePipeline actually passes match_decision, match_explanation, matched_needs, eligibility_status, ineligibility_reasons, fingerprints, matcher_version [Goal 8,9]
11. EXPLANATION PIPELINE: Trace match_reasons/explanation from decision engine to API response to frontend display. If explanations are computed but never shown, flag it [Goal 12]
12. ANYA GROUNDING: Check if Anya returns data-backed responses or fabricates answers without tool verification [Goal 14,15]

For each bug, state which goal(s) it violates. For each fix suggestion, state which goal(s) it serves and confirm no other goals are broken.

Return JSON: {"cross_file_bugs":[{"severity":"CRITICAL|ERROR|WARNING","type":"category","goals_violated":[4,7],"files":["file1","file2"],"description":"problem — violates Goal X because...","fix_description":"how to fix (serves Goal X,Y)"}],"insertion_paths":[{"file":"path","function":"name","uses_filter":true,"uses_decision_engine":true,"stores_audit_columns":true,"uses_url_validation":false,"description":"how it inserts"}],"mission_gaps":[{"goal":8,"status":"BROKEN|PARTIAL|OK","evidence":"specific files/functions","fix":"what to do"}],"summary":"assessment"}

INVENTORY:
$sigText
"@

  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# Cross-File Analysis v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Files: $($inventory.Count) | Routes discovered: $($discoveredRoutes.Count)")
  [void]$rpt.Add("")

  if($crossAnalysis -and $crossAnalysis.cross_file_bugs){
    [void]$rpt.Add("Assessment: $($crossAnalysis.summary)")
    [void]$rpt.Add("")
    foreach($bug in $crossAnalysis.cross_file_bugs){
      $goalTag=if($bug.goals_violated){"[Goals $($bug.goals_violated -join ',')]"}else{''}
      [void]$rpt.Add("## [$($bug.severity)] $($bug.type) $goalTag")
      [void]$rpt.Add("Files: $($bug.files -join ', ')")
      [void]$rpt.Add("$($bug.description)")
      [void]$rpt.Add("Fix: $($bug.fix_description)")
      [void]$rpt.Add("")
      foreach($bf in $bug.files){Learn-FileRisk $bf 1;Learn-BugPattern $bug.type $bf}
    }
    [void]$rpt.Add("Bugs found: $($crossAnalysis.cross_file_bugs.Count)")

    # AUTO-FIX CRITICAL cross-file bugs that violate mission goals
    $critBugs=$crossAnalysis.cross_file_bugs|Where-Object{$_.severity -eq 'CRITICAL' -and $_.files}
    if($critBugs -and @($critBugs).Count -gt 0){
      Write-Log "Attempting auto-fix for $(@($critBugs).Count) CRITICAL cross-file bug(s)..." 'FIX'
      foreach($cb in $critBugs){
        foreach($targetFile in $cb.files){
          $fd=Read-GH $targetFile
          if(!$fd){continue}
          $goalTag=if($cb.goals_violated){"Goals $($cb.goals_violated -join ',')"}else{'mission alignment'}
          $fixResult=Invoke-CJ $sysCtx @"
CRITICAL cross-file bug found in $targetFile.
Bug: $($cb.description)
Suggested fix: $($cb.fix_description)
Goals violated: $goalTag

Apply the fix to this file. Return ONLY JSON:
{"fixed":true,"original_code":"exact code to replace","fixed_code":"corrected code","commit_message":"short message","goals_served":[list of goal numbers]}
If no code change is needed in THIS specific file, return {"fixed":false}.

FILE: $targetFile
$($fd.c)
"@
          if($fixResult -and $fixResult.fixed -and $fixResult.original_code -and $fixResult.fixed_code){
            $content=$fd.c
            $orig=[string]$fixResult.original_code
            if($content.Contains($orig)){
              $content=$content.Replace($orig,[string]$fixResult.fixed_code)
              $gs=if($fixResult.goals_served){"[Goals $($fixResult.goals_served -join ',')]"}else{''}
              $msg="$($fixResult.commit_message) $gs"
              if(Write-GH $targetFile $content $fd.sha $msg $fd.c){
                $script:S.Fixes++
                [void]$rpt.Add("  AUTO-FIX: ${targetFile} - ${msg}")
                Write-Log "  Auto-fixed ${targetFile} - ${msg}" 'FIX'
              }
              Start-Sleep 1
            }
          }
        }
      }
    }
  } else {
    [void]$rpt.Add("No cross-file bugs detected (or analysis failed)")
  }

  # Auto-fix BROKEN mission gaps
  if($crossAnalysis -and $crossAnalysis.mission_gaps){
    $brokenGaps=$crossAnalysis.mission_gaps|Where-Object{$_.status -eq 'BROKEN' -and $_.evidence}
    if($brokenGaps -and @($brokenGaps).Count -gt 0){
      Write-Log "Attempting auto-fix for $(@($brokenGaps).Count) BROKEN mission gap(s)..." 'FIX'
      foreach($gap in $brokenGaps){
        $fixPlan=Invoke-CJ $sysCtx @"
BROKEN MISSION GAP: Goal $($gap.goal) — $($gap.evidence)
Suggested fix: $($gap.fix)

Identify the SINGLE most impactful file to change and the exact code change. Return ONLY JSON:
{"file":"backend/path/to/file.js","original_code":"exact code","fixed_code":"corrected code","commit_message":"short message","goals_served":[$($gap.goal)]}
If the fix requires schema/migration changes or multiple files, return {"file":null,"reason":"why auto-fix is not safe"}.
"@
        if($fixPlan -and $fixPlan.file -and $fixPlan.original_code -and $fixPlan.fixed_code){
          $fd=Read-GH $fixPlan.file
          if($fd){
            $content=$fd.c
            $orig=[string]$fixPlan.original_code
            if($content.Contains($orig)){
              $content=$content.Replace($orig,[string]$fixPlan.fixed_code)
              $msg="$($fixPlan.commit_message) [Goal $($gap.goal)]"
              if(Write-GH $fixPlan.file $content $fd.sha $msg $fd.c){
                $script:S.Fixes++
                [void]$rpt.Add("  MISSION FIX: Goal $($gap.goal) - $($fixPlan.file) - ${msg}")
                Write-Log "  Mission fix Goal $($gap.goal) $($fixPlan.file) ${msg}" 'FIX'
              }
              Start-Sleep 1
            }
          }
        }
      }
    }
  }

  # Report mission alignment gaps
  if($crossAnalysis -and $crossAnalysis.mission_gaps -and $crossAnalysis.mission_gaps.Count -gt 0){
    [void]$rpt.Add("")
    [void]$rpt.Add("## Mission Goal Alignment")
    foreach($mg in $crossAnalysis.mission_gaps){
      $icon=switch($mg.status){'OK'{'PASS'}'PARTIAL'{'WARN'}'BROKEN'{'FAIL'}default{'?'}}
      [void]$rpt.Add("- [${icon}] Goal $($mg.goal): $($mg.status) - $($mg.evidence)")
      if($mg.fix -and $mg.status -ne 'OK'){[void]$rpt.Add("  Fix: $($mg.fix)")}
    }
    $broken=@($crossAnalysis.mission_gaps|Where-Object{$_.status -eq 'BROKEN'})
    $partial=@($crossAnalysis.mission_gaps|Where-Object{$_.status -eq 'PARTIAL'})
    [void]$rpt.Add("")
    [void]$rpt.Add("Mission score: $(@($crossAnalysis.mission_gaps|Where-Object{$_.status -eq 'OK'}).Count) OK / $($partial.Count) PARTIAL / $($broken.Count) BROKEN of $($crossAnalysis.mission_gaps.Count) goals assessed")
  }

  # Report pipeline insertion paths
  if($crossAnalysis -and $crossAnalysis.insertion_paths -and $crossAnalysis.insertion_paths.Count -gt 0){
    [void]$rpt.Add("")
    [void]$rpt.Add("## Pipeline Insertion Paths")
    [void]$rpt.Add("Every code path that can put a grant into the database:")
    [void]$rpt.Add("")
    foreach($ip in $crossAnalysis.insertion_paths){
      $filterStatus=if($ip.uses_filter){'FILTERED'}else{'UNFILTERED'}
      $icon=if($ip.uses_filter){'OK'}else{'DANGER'}
      [void]$rpt.Add("- [$icon] **$($ip.file)** -> $($ip.function): $filterStatus")
      [void]$rpt.Add("  $($ip.description)")
    }
    $unfiltered=$crossAnalysis.insertion_paths|Where-Object{-not $_.uses_filter}
    if($unfiltered -and $unfiltered.Count -gt 0){
      [void]$rpt.Add("")
      [void]$rpt.Add("**WARNING: $($unfiltered.Count) insertion path(s) bypass the relevance filter!**")
    }
    [void]$rpt.Add("")
  }

  Save-KB $script:KB
  $crossRpt=Join-Path $script:M.LogDir "crossfile_$($script:M.RunId).md"
  Set-Content -Path $crossRpt -Value ($rpt -join "`n") -Encoding UTF8
  if($script:S.Fixes -gt 0 -and $script:M.WorkBranchName){
    New-CodeGuardPullRequest $script:M.WorkBranchName $script:S.Fixes
  }

  Write-Log "Cross-file analysis done. Cost:`$$([math]::Round($script:S.ApiCost,2))" 'OK'
  Send-Notify "Cross-File Done" "See report"
  Start-Process $crossRpt
}

# ===================================================================
#  [6] MATCH QUALITY AUDIT - Core mission test (with trend tracking)
# ===================================================================
function Start-MatchAudit{
  $sysCtx=Build-SystemContext
  Write-Log "=== MATCH QUALITY AUDIT ===" 'OK'
  $adm=Get-Tok 'GRANTFLOW_ADMIN_TOKEN' 'ADMIN_TOKEN'
  $base=$script:M.Rail
  $ah=@{'Content-Type'='application/json';Accept='application/json'}
  if($adm){$ah['X-Admin-Token']=$adm;$ah['Authorization']="Bearer $adm"}

  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# Match Quality Audit v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
  [void]$rpt.Add("")

  Write-Log "Fetching profiles..." 'INFO'
  $profilesRaw=$null
  try{$profilesRaw=Invoke-RestMethod -Uri "$base/api/profiles?limit=50" -Headers $ah -UseBasicParsing -TimeoutSec 30}catch{Write-Log "Cannot fetch profiles: $($_.Exception.Message)" 'ERROR'}
  if(!$profilesRaw -or $profilesRaw.Count -eq 0){Write-Log "No profiles found." 'ERROR';return}

  $profiles=if($profilesRaw -is [array]){$profilesRaw}else{@($profilesRaw)}
  Write-Log "Found $($profiles.Count) profiles" 'OK'

  $totalGood=0;$totalBad=0;$totalEmpty=0;$profileResults=[System.Collections.ArrayList]::new()

  foreach($p in $profiles){
    $pid=$p.id;$pname=$p.display_name;$ptype=$p.primary_type
    if(!$pid){continue}
    Write-Log "  Auditing: $pname ($ptype)..." 'INFO'

    $grantsRaw=$null
    try{$grantsRaw=Invoke-RestMethod -Uri "$base/api/grants?profile_id=$pid&limit=200" -Headers $ah -UseBasicParsing -TimeoutSec 30}
    catch{Write-Log "  Cannot fetch grants for $pname" 'WARN';continue}

    $grants=if($grantsRaw -is [array]){$grantsRaw}else{@($grantsRaw)}
    if($grants.Count -eq 0){
      $totalEmpty++
      [void]$profileResults.Add(@{name=$pname;type=$ptype;total=0;good=0;bad=0;grade='N/A';issues=@('Empty pipeline')})
      Learn-MatchGrade $pname 'N/A' 0 0
      continue
    }

    $sampleSize=[math]::Min(20,$grants.Count)
    $sample=$grants|Select-Object -First $sampleSize
    $grantList=($sample|ForEach-Object{"- $($_.title) (match:$($_.match_score)%)"}) -join "`n"

    # Include previous grade for this profile if available
    $prevGrade=""
    $prevEntry=$script:KB.matchGrades|Where-Object{$_.profile -eq $pname}|Select-Object -Last 1
    if($prevEntry){$prevGrade="`nPrevious audit grade: $($prevEntry.grade) ($($prevEntry.relevant) relevant, $($prevEntry.irrelevant) irrelevant)"}

    $assessment=Invoke-CJ "You assess funding source relevance for profiles." @"
PROFILE: $pname
Type: $ptype
Tags: $($p.tags -join ', ')$prevGrade

These grants are in their pipeline. For each, say if it is RELEVANT or IRRELEVANT to this profile type and needs.
Return JSON: {"profile":"$pname","relevant_count":N,"irrelevant_count":N,"irrelevant":[{"title":"grant name","reason":"why irrelevant"}],"missing":["funding sources that SHOULD be there but aren't"],"grade":"A|B|C|D|F","trend":"improving|stable|declining|new"}

GRANTS ($sampleSize of $($grants.Count)):
$grantList
"@

    if($assessment){
      $good=$assessment.relevant_count;$bad=$assessment.irrelevant_count
      $totalGood+=$good;$totalBad+=$bad
      $grade=$assessment.grade
      $trend=if($assessment.trend){$assessment.trend}else{'new'}
      [void]$profileResults.Add(@{name=$pname;type=$ptype;total=$grants.Count;good=$good;bad=$bad;grade=$grade;trend=$trend;irrelevant=$assessment.irrelevant;missing=$assessment.missing})
      Learn-MatchGrade $pname $grade $good $bad
      $lvl=if($grade -match 'A|B'){'OK'}elseif($grade -eq 'C'){'WARN'}else{'ERROR'}
      Write-Log "  ${pname}: Grade ${grade} (${trend}) - ${good} relevant, ${bad} irrelevant of ${sampleSize} sampled" $lvl
    }
    Start-Sleep -Milliseconds 500
  }

  # --- URL HEALTH SPOT-CHECK ---
  Write-Log "Spot-checking grant URLs for dead links..." 'INFO'
  $urlSample=[System.Collections.ArrayList]::new()
  foreach($pr in $profileResults){
    if($pr.total -gt 0 -and $pr.grade -ne 'N/A'){
      # Grab a few grant URLs from the profile's raw grant data to check
    }
  }
  # Collect up to 30 unique URLs across all profiles
  $allGrantUrls=[System.Collections.ArrayList]::new()
  foreach($p in $profiles){
    $pid=$p.id
    if(!$pid){continue}
    try{
      $gRaw=Invoke-RestMethod -Uri "$base/api/grants?profile_id=$pid&limit=50" -Headers $ah -UseBasicParsing -TimeoutSec 20 -ErrorAction SilentlyContinue
      $gList=if($gRaw -is [array]){$gRaw}else{@($gRaw)}
      foreach($g in $gList){
        if($g.url -and $allGrantUrls.Count -lt 30){
          [void]$allGrantUrls.Add(@{title=$g.title;url=$g.url;profile=$p.display_name})
        }
      }
    }catch{}
    if($allGrantUrls.Count -ge 30){break}
  }

  $deadUrls=[System.Collections.ArrayList]::new()
  $checkedCount=0
  foreach($gu in $allGrantUrls){
    $checkedCount++
    try{
      $resp=Invoke-WebRequest -Uri $gu.url -Method HEAD -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 3 -ErrorAction Stop
      $code=$resp.StatusCode
      if($code -ge 400){
        [void]$deadUrls.Add(@{title=$gu.title;url=$gu.url;profile=$gu.profile;status=$code;reason='HTTP error'})
        Write-Log "  DEAD [$code] $($gu.title)" 'WARN'
      }
    }catch{
      $errMsg=$_.Exception.Message
      $status='ERR'
      if($errMsg -match '404'){$status='404'}
      elseif($errMsg -match '403'){$status='403'}
      elseif($errMsg -match 'timeout'){$status='TIMEOUT'}
      [void]$deadUrls.Add(@{title=$gu.title;url=$gu.url;profile=$gu.profile;status=$status;reason=$errMsg})
      Write-Log "  DEAD [$status] $($gu.title)" 'WARN'
    }
    Start-Sleep -Milliseconds 300
  }
  Write-Log "URL check: $checkedCount checked, $($deadUrls.Count) dead/broken" $(if($deadUrls.Count -gt 0){'WARN'}else{'OK'})

  Save-KB $script:KB

  # Report table
  [void]$rpt.Add("| Profile | Type | Grants | Grade | Trend | Relevant | Irrelevant |")
  [void]$rpt.Add("|---------|------|--------|-------|-------|----------|------------|")
  foreach($pr in $profileResults){
    [void]$rpt.Add("| $($pr.name) | $($pr.type) | $($pr.total) | $($pr.grade) | $($pr.trend) | $($pr.good) | $($pr.bad) |")
  }
  [void]$rpt.Add("")

  foreach($pr in $profileResults){
    if($pr.irrelevant -and $pr.irrelevant.Count -gt 0){
      [void]$rpt.Add("### $($pr.name) - Irrelevant Grants")
      foreach($ig in $pr.irrelevant){[void]$rpt.Add("- **$($ig.title)**: $($ig.reason)")}
      [void]$rpt.Add("")
    }
    if($pr.missing -and $pr.missing.Count -gt 0){
      [void]$rpt.Add("### $($pr.name) - Missing Funding Sources")
      foreach($ms in $pr.missing){[void]$rpt.Add("- $ms")}
      [void]$rpt.Add("")
    }
  }

  # Grade trend across all audits
  if($script:KB.matchGrades -and $script:KB.matchGrades.Count -gt 20){
    [void]$rpt.Add("## Grade Trend (all-time)")
    $allGrades=$script:KB.matchGrades|Group-Object grade
    foreach($g in $allGrades|Sort-Object Name){[void]$rpt.Add("- Grade $($g.Name): $($g.Count) profile-audits")}
    [void]$rpt.Add("")
  }

  # Dead URL report section
  if($deadUrls.Count -gt 0){
    [void]$rpt.Add("## Dead / Broken URLs ($($deadUrls.Count) of $checkedCount checked)")
    foreach($du in $deadUrls){
      [void]$rpt.Add("- [$($du.status)] **$($du.title)** ($($du.profile))")
      [void]$rpt.Add("  $($du.url)")
    }
    [void]$rpt.Add("")
  } else {
    [void]$rpt.Add("## URL Health: All $checkedCount sampled URLs responding")
    [void]$rpt.Add("")
  }

  [void]$rpt.Add("---")
  [void]$rpt.Add("## Summary")
  [void]$rpt.Add("Profiles: $($profileResults.Count) | Good: $totalGood | Bad: $totalBad | Empty: $totalEmpty | Dead URLs: $($deadUrls.Count)/$checkedCount | Cost: `$$([math]::Round($script:S.ApiCost,2))")

  Set-Content -Path $script:M.MatchRpt -Value ($rpt -join "`n") -Encoding UTF8
  Write-Log "Match audit done. Good:$totalGood Bad:$totalBad Empty:$totalEmpty" 'OK'
  Send-Notify "Match Audit Done" "Good:$totalGood Bad:$totalBad Empty:$totalEmpty"
  Start-Process $script:M.MatchRpt
}

# ===================================================================
#  [8] ANYA MISSION AUDIT - Is Anya helping users find funding?
# ===================================================================
function Start-AnyaAudit{
  $sysCtx=Build-SystemContext
  Write-Log "=== ANYA MISSION AUDIT ===" 'AI'
  $anyaRpt=Join-Path $script:M.LogDir "anya_audit_$($script:M.RunId).md"
  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# Anya Mission Audit v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
  [void]$rpt.Add("")

  # Read all Anya-related files
  $anyaFiles=@(
    'backend/services/anyaAdminTools.js',
    'backend/services/anyaToolRegistry.js',
    'backend/services/anyaAutoRepairService.js',
    'backend/services/anyaAutonomousScheduler.js',
    'backend/services/anyaChatService.js',
    'backend/services/anyaSystemPrompt.js',
    'backend/services/anyaPromptBuilder.js',
    'backend/routes/anya.js',
    'backend/routes/anyaChat.js',
    'backend/prompts/anyaSystem.js',
    'backend/prompts/anyaTools.js',
    'src/components/anya/AnyaChat.jsx',
    'src/components/anya/AnyaPanel.jsx',
    'src/components/anya/AnyaTour.jsx',
    'src/components/anya/AnyaOnboarding.jsx',
    'src/pages/AnyaSettings.jsx'
  )

  Write-Log "Reading Anya source files..." 'AI'
  $anyaCtx=""
  $foundFiles=0
  foreach($af in $anyaFiles){
    $fd=Read-GH $af
    if($fd){
      $foundFiles++
      $lines=($fd.c -split "`n")|Select-Object -First 200
      $anyaCtx += "`n=== $af ===`n$($lines -join "`n")"
    }
  }

  # Also search for Anya-related files we might not know about
  $tree=Invoke-GH "git/trees/$($script:M.Branch)?recursive=1"
  if($tree){
    $extraAnya=$tree.tree|Where-Object{$_.type -eq 'blob' -and $_.path -match 'anya' -and $_.path -match '\.(js|jsx|ts|tsx)$' -and $_.path -notmatch 'node_modules'}
    foreach($ea in $extraAnya){
      if($anyaFiles -notcontains $ea.path){
        $fd=Read-GH $ea.path
        if($fd){
          $foundFiles++
          $lines=($fd.c -split "`n")|Select-Object -First 150
          $anyaCtx += "`n=== $($ea.path) (auto-discovered) ===`n$($lines -join "`n")"
        }
      }
    }
  }

  Write-Log "Found $foundFiles Anya-related files. Sending to Claude for mission audit..." 'AI'

  $audit=Invoke-CJ $sysCtx @"
ANYA MISSION AUDIT. Evaluate whether Anya serves GrantFlow's core purpose: helping users find real, relevant funding.

Standard: Anya should help users understand their profile, improve eligibility visibility, discover better funding, understand why matches appear, know what to do next, and recover when results are poor.

She must NOT merely: narrate the interface, offer generic encouragement, repeat static docs, pretend to know things she isn't grounded in, overpromise results, or distract from finding better matches.

For each Anya file, evaluate:
1. What is her explicit mission in code?
2. Is her system prompt grounded in live profile/opportunity data or generic?
3. Does she explain match relevance, next actions, profile weaknesses?
4. Can she point users to improve their profile for better matches?
5. Does she help recover from empty-result situations?
6. Does she explain why opportunities were matched or rejected?
7. Is she useful after onboarding or only theatrical?
8. Is her tour/onboarding content accurate to the current app?

Return JSON:
{"mission_alignment":"aligned|partially_aligned|misaligned|decorative","confidence":0.8,"overall_grade":"A|B|C|D|F","findings":[{"file":"path","issue":"what is wrong","severity":"CRITICAL|WARNING|INFO","mission_impact":"how this hurts users","fix":"what to change"}],"strengths":["what Anya does well"],"gaps":["what Anya should do but doesn't"],"redesign_needed":true,"redesign_summary":"if needed, what the new Anya role should be"}

ANYA FILES ($foundFiles files):
$anyaCtx
"@

  if($audit){
    [void]$rpt.Add("## Overall Assessment")
    [void]$rpt.Add("- Mission alignment: **$($audit.mission_alignment)**")
    [void]$rpt.Add("- Grade: **$($audit.overall_grade)**")
    [void]$rpt.Add("- Confidence: $($audit.confidence)")
    [void]$rpt.Add("")

    if($audit.strengths -and $audit.strengths.Count -gt 0){
      [void]$rpt.Add("## Strengths")
      foreach($s in $audit.strengths){[void]$rpt.Add("- $s")}
      [void]$rpt.Add("")
    }

    if($audit.gaps -and $audit.gaps.Count -gt 0){
      [void]$rpt.Add("## Mission Gaps")
      foreach($g in $audit.gaps){[void]$rpt.Add("- $g")}
      [void]$rpt.Add("")
    }

    if($audit.findings -and $audit.findings.Count -gt 0){
      [void]$rpt.Add("## File-by-File Findings")
      foreach($f in $audit.findings){
        [void]$rpt.Add("### [$($f.severity)] $($f.file)")
        [void]$rpt.Add("Issue: $($f.issue)")
        [void]$rpt.Add("Impact: $($f.mission_impact)")
        [void]$rpt.Add("Fix: $($f.fix)")
        [void]$rpt.Add("")
      }
    }

    if($audit.redesign_needed){
      [void]$rpt.Add("## Redesign Recommendation")
      [void]$rpt.Add($audit.redesign_summary)
      [void]$rpt.Add("")
    }

    $grd=$audit.overall_grade
    $lvl=if($grd -match 'A|B'){'OK'}elseif($grd -eq 'C'){'WARN'}else{'ERROR'}
    Write-Log "Anya audit: Grade ${grd} - $($audit.mission_alignment) (confidence: $($audit.confidence))" $lvl
  } else {
    [void]$rpt.Add("Audit failed - no response from Claude")
  }

  Set-Content -Path $anyaRpt -Value ($rpt -join "`n") -Encoding UTF8
  Save-KB $script:KB
  Write-Log "Anya audit complete. Cost:`$$([math]::Round($script:S.ApiCost,2))" 'OK'
  Send-Notify "Anya Audit Done" "See report"
  Start-Process $anyaRpt
}

# ===================================================================
#  [9] MISSION VERIFY - Functional proof that GrantFlow meets its goals
# ===================================================================
function Start-MissionVerify{
  $sysCtx=Build-SystemContext
  Write-Log "=== MISSION VERIFY - Testing all 15 GrantFlow goals against live deployment ===" 'OK'
  $adm=Get-Tok 'GRANTFLOW_ADMIN_TOKEN' 'ADMIN_TOKEN'
  $base=$script:M.Rail
  $ah=@{'Content-Type'='application/json';Accept='application/json'}
  if($adm){$ah['X-Admin-Token']=$adm;$ah['Authorization']="Bearer $adm"}

  $mvRpt=Join-Path $script:M.LogDir "mission_verify_$($script:M.RunId).md"
  $rpt=[System.Collections.ArrayList]::new()
  [void]$rpt.Add("# GrantFlow Mission Verification v$($script:M.V) | Run #$($script:KB.runCount)")
  [void]$rpt.Add("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Target: $base")
  [void]$rpt.Add("")

  $script:mvPass=0;$script:mvFail=0;$script:mvWarn=0;$script:mvRpt=$rpt

  function Write-Goal([int]$Num,[string]$Name,[string]$Status,[string]$Evidence){
    $lvl=switch($Status){'PASS'{'OK'}; 'FAIL'{'ERROR'}; default{'WARN'}}
    Write-Log "  Goal $Num [$Status]: $Name" $lvl
    [void]$script:mvRpt.Add("## Goal ${Num}: $Name")
    [void]$script:mvRpt.Add("**Result: $Status**")
    [void]$script:mvRpt.Add("")
    [void]$script:mvRpt.Add($Evidence)
    [void]$script:mvRpt.Add("")
    switch($Status){'PASS'{$script:mvPass++}'FAIL'{$script:mvFail++}default{$script:mvWarn++}}
  }

  function Fetch-Json([string]$Url){
    try{
      $r=Invoke-RestMethod -Uri $Url -Headers $ah -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      return $r
    }catch{return $null}
  }

  # --- GOAL 1: Real funding with application URLs ---
  Write-Log "Goal 1: Real funding opportunities..." 'INFO'
  $opps=Fetch-Json "$base/api/opportunities?limit=20"
  $oppList=if($opps -is [array]){$opps}elseif($opps.results){$opps.results}elseif($opps.opportunities){$opps.opportunities}else{@()}
  $withUrl=@($oppList|Where-Object{$_.url -or $_.application_url -or $_.source_url})
  $totalOpps=$oppList.Count
  $urlPct=if($totalOpps -gt 0){[math]::Round(($withUrl.Count/$totalOpps)*100)}else{0}
  if($totalOpps -eq 0){
    Write-Goal 1 "Real funding with application URLs" 'FAIL' "No opportunities found in the system. Pipeline is empty."
  }elseif($urlPct -ge 80){
    Write-Goal 1 "Real funding with application URLs" 'PASS' "$($withUrl.Count)/$totalOpps opportunities ($urlPct%) have URLs."
  }else{
    Write-Goal 1 "Real funding with application URLs" 'WARN' "Only $($withUrl.Count)/$totalOpps ($urlPct%) have URLs. Target: 80%+."
  }

  # --- GOAL 2: Match to actual needs ---
  Write-Log "Goal 2: Match to actual needs..." 'INFO'
  $profiles=Fetch-Json "$base/api/profiles?limit=10"
  $pList=if($profiles -is [array]){$profiles}else{@($profiles)}
  $needMatchCount=0;$needTestCount=0
  foreach($p in $pList){
    if(!$p.id){continue}
    $grants=Fetch-Json "$base/api/grants?profile_id=$($p.id)&limit=10"
    $gList=if($grants -is [array]){$grants}else{@($grants)}
    foreach($g in $gList){
      $needTestCount++
      if($g.matched_needs -or $g.need_alignment -or $g.match_score -gt 0){$needMatchCount++}
    }
    if($needTestCount -ge 30){break}
  }
  if($needTestCount -eq 0){
    Write-Goal 2 "Match funding to actual profile needs" 'FAIL' "No grants found in any profile pipeline."
  }elseif($needMatchCount -ge ($needTestCount * 0.7)){
    Write-Goal 2 "Match funding to actual profile needs" 'PASS' "$needMatchCount/$needTestCount grants have need-alignment or match score data."
  }else{
    Write-Goal 2 "Match funding to actual profile needs" 'WARN' "Only $needMatchCount/$needTestCount grants have need-alignment data. Many may be shallow matches."
  }

  # --- GOAL 3: Reject irrelevant results ---
  Write-Log "Goal 3: Reject irrelevant/misleading results..." 'INFO'
  $disc37=Fetch-Json "$base/api/discover-grants?zip=37311"
  $discResults=if($disc37.results){$disc37.results}elseif($disc37.opportunities){$disc37.opportunities}else{@()}
  $junkPatterns='(?i)(loan|repayment|(?<!\w)closed\b|coming soon|placeholder|test record)'
  $junkFound=@($discResults|Where-Object{$_.title -match $junkPatterns -or $_.description -match $junkPatterns})
  if($discResults.Count -eq 0){
    Write-Goal 3 "Reject irrelevant or misleading results" 'WARN' "Discovery returned 0 results for zip 37311. Cannot verify suppression."
  }elseif($junkFound.Count -eq 0){
    Write-Goal 3 "Reject irrelevant or misleading results" 'PASS' "$($discResults.Count) discovery results checked. No loans, closed, placeholder, or test records found."
  }else{
    $junkTitles=($junkFound|ForEach-Object{$_.title}) -join ', '
    Write-Goal 3 "Reject irrelevant or misleading results" 'FAIL' "Found $($junkFound.Count) junk result(s) in discovery: $junkTitles"
  }

  # --- GOAL 4: Single canonical decision engine ---
  Write-Log "Goal 4: Single canonical decision engine..." 'INFO'
  $matchHealth=Fetch-Json "$base/api/matching/health"
  if($matchHealth -and ($matchHealth.engine -or $matchHealth.status)){
    Write-Goal 4 "Single canonical decision engine" 'PASS' "Matching engine reports status: $($matchHealth.status). Engine: $($matchHealth.engine). Active version: $($matchHealth.version)"
  }else{
    Write-Goal 4 "Single canonical decision engine" 'WARN' "Cannot verify engine status from /api/matching/health. Check computeMatchDecision() paths via Cross-File analysis."
  }

  # --- GOAL 5: Use full profile, not just surface tags ---
  Write-Log "Goal 5: Full profile utilization..." 'INFO'
  $deepProfileCount=0;$shallowProfileCount=0
  foreach($p in $pList){
    $sections=@($p.PSObject.Properties.Name|Where-Object{$_ -match 'military|education|family|health|emergency|business|housing|employment|financial|disability'})
    if($sections.Count -ge 2){$deepProfileCount++}else{$shallowProfileCount++}
  }
  if($pList.Count -eq 0){
    Write-Goal 5 "Use full profile, not just surface tags" 'FAIL' "No profiles to inspect."
  }elseif($deepProfileCount -ge ($pList.Count * 0.5)){
    Write-Goal 5 "Use full profile, not just surface tags" 'PASS' "$deepProfileCount/$($pList.Count) profiles have 2+ deep sections (military, health, education, etc.)"
  }else{
    Write-Goal 5 "Use full profile, not just surface tags" 'WARN' "Only $deepProfileCount/$($pList.Count) profiles have deep structured sections. $shallowProfileCount have only surface-level data."
  }

  # --- GOAL 6: Handle many applicant types ---
  Write-Log "Goal 6: Multiple applicant types..." 'INFO'
  $types=@($pList|ForEach-Object{$_.primary_type}|Where-Object{$_}|Sort-Object -Unique)
  if($types.Count -ge 3){
    Write-Goal 6 "Handle many applicant types correctly" 'PASS' "Found $($types.Count) distinct profile types: $($types -join ', ')"
  }elseif($types.Count -ge 1){
    Write-Goal 6 "Handle many applicant types correctly" 'WARN' "Only $($types.Count) profile type(s): $($types -join ', '). System should serve individuals, families, students, veterans, businesses, nonprofits."
  }else{
    Write-Goal 6 "Handle many applicant types correctly" 'FAIL' "No profile types found."
  }

  # --- GOAL 7: Balance recall with correctness ---
  Write-Log "Goal 7: Recall vs. correctness balance..." 'INFO'
  $discOH=Fetch-Json "$base/api/discover-grants?zip=44114"
  $ohResults=if($discOH.results){$discOH.results}elseif($discOH.opportunities){$discOH.opportunities}else{@()}
  $discPA=Fetch-Json "$base/api/discover-grants?zip=15010"
  $paResults=if($discPA.results){$discPA.results}elseif($discPA.opportunities){$discPA.opportunities}else{@()}
  $totalDisc=$discResults.Count + $ohResults.Count + $paResults.Count
  if($totalDisc -ge 10){
    Write-Goal 7 "Balance recall with correctness" 'PASS' "Discovery returns results across geographies: TN=$($discResults.Count), OH=$($ohResults.Count), PA=$($paResults.Count). Total=$totalDisc. System is finding opportunities."
  }elseif($totalDisc -gt 0){
    Write-Goal 7 "Balance recall with correctness" 'WARN' "Low result counts: TN=$($discResults.Count), OH=$($ohResults.Count), PA=$($paResults.Count). May be over-filtering."
  }else{
    Write-Goal 7 "Balance recall with correctness" 'FAIL' "Discovery returns 0 results across all test ZIPs. Crawlers or matching may be broken."
  }

  # --- GOAL 8: Explainable and auditable pipeline ---
  Write-Log "Goal 8: Explainable pipeline..." 'INFO'
  $hasExplanation=0;$hasFingerprint=0;$hasDecision=0;$auditSample=0
  foreach($p in $pList){
    if(!$p.id){continue}
    $grants=Fetch-Json "$base/api/grants?profile_id=$($p.id)&limit=10"
    $gList=if($grants -is [array]){$grants}else{@($grants)}
    foreach($g in $gList){
      $auditSample++
      if($g.explanation -or $g.match_explanation){$hasExplanation++}
      if($g.fingerprint -or $g.content_fingerprint){$hasFingerprint++}
      if($g.match_decision -or $g.decision){$hasDecision++}
    }
    if($auditSample -ge 30){break}
  }
  $evidence="Of $auditSample grants sampled: $hasExplanation have explanations, $hasDecision have decisions, $hasFingerprint have fingerprints."
  if($auditSample -eq 0){
    Write-Goal 8 "Explainable and auditable pipeline" 'FAIL' "No grants to audit."
  }elseif($hasExplanation -ge ($auditSample * 0.5)){
    Write-Goal 8 "Explainable and auditable pipeline" 'PASS' $evidence
  }else{
    Write-Goal 8 "Explainable and auditable pipeline" 'WARN' "$evidence Most grants lack audit trail fields."
  }

  # --- GOAL 9: Re-evaluate on changes ---
  Write-Log "Goal 9: Re-evaluation capability..." 'INFO'
  $fpCount=$hasFingerprint
  if($fpCount -ge ($auditSample * 0.3)){
    Write-Goal 9 "Re-evaluate when profile/opportunity/logic changes" 'PASS' "$fpCount/$auditSample grants have fingerprints for change detection."
  }else{
    Write-Goal 9 "Re-evaluate when profile/opportunity/logic changes" 'WARN' "Only $fpCount/$auditSample grants have fingerprints. Changes may go undetected."
  }

  # --- GOAL 10: Help users improve profiles ---
  Write-Log "Goal 10: Profile improvement guidance..." 'INFO'
  $schemaResp=Fetch-Json "$base/api/profiles/schema"
  if($schemaResp){
    Write-Goal 10 "Help users improve results by improving profiles" 'PASS' "Profile schema endpoint exists and returns data. Users can see what fields affect matching."
  }else{
    Write-Goal 10 "Help users improve results by improving profiles" 'WARN' "Profile schema endpoint not reachable. Users may not know which fields improve matches."
  }

  # --- GOAL 11: Profile-driven crawling ---
  Write-Log "Goal 11: Profile-driven crawling..." 'INFO'
  $crawlers=Fetch-Json "$base/api/crawlers"
  $realCrawlers=Fetch-Json "$base/api/real-crawlers"
  $crawlData=if($crawlers){$crawlers}else{$realCrawlers}
  if($crawlData){
    $crawlList=if($crawlData -is [array]){$crawlData}else{@($crawlData)}
    Write-Goal 11 "Profile-driven crawling" 'PASS' "Crawler system active. $($crawlList.Count) crawler(s) registered."
  }else{
    Write-Goal 11 "Profile-driven crawling" 'WARN' "Cannot reach crawler endpoints. Verify crawlers are running."
  }

  # --- GOAL 12: Plain-language explanations ---
  Write-Log "Goal 12: Plain-language explanations..." 'INFO'
  if($hasExplanation -ge ($auditSample * 0.3)){
    Write-Goal 12 "Plain-language explanations for matches" 'PASS' "$hasExplanation/$auditSample grants have explanation text."
  }else{
    Write-Goal 12 "Plain-language explanations for matches" 'WARN' "Only $hasExplanation/$auditSample grants have explanation text. Most matches are unexplained."
  }

  # --- GOAL 13: Application workflow ---
  Write-Log "Goal 13: Application workflow..." 'INFO'
  $pipelineHealth=Fetch-Json "$base/api/admin/pipeline-health"
  $services=Fetch-Json "$base/api/services"
  if($pipelineHealth -or $services){
    Write-Goal 13 "Application workflow (discovery to management)" 'PASS' "Pipeline health and services endpoints respond. Workflow infrastructure exists."
  }else{
    Write-Goal 13 "Application workflow (discovery to management)" 'WARN' "Pipeline health/services endpoints not reachable. Workflow may be incomplete."
  }

  # --- GOAL 14: Anya as useful guide ---
  Write-Log "Goal 14: Anya as useful guide..." 'INFO'
  $anyaHealth=Fetch-Json "$base/api/anya/health"
  if($anyaHealth -and ($anyaHealth.status -eq 'ok' -or $anyaHealth.status -eq 'healthy')){
    Write-Goal 14 "Anya as a useful in-app guide" 'PASS' "Anya is healthy. Status: $($anyaHealth.status). Run [8] Anya Audit for deep mission evaluation."
  }elseif($anyaHealth){
    Write-Goal 14 "Anya as a useful in-app guide" 'WARN' "Anya responds but status is: $($anyaHealth.status). May not be fully functional."
  }else{
    Write-Goal 14 "Anya as a useful in-app guide" 'FAIL' "Anya health endpoint unreachable."
  }

  # --- GOAL 15: Anya grounded in app structure ---
  Write-Log "Goal 15: Anya grounded in real app data..." 'INFO'
  $anyaGrounded=$false
  if($anyaHealth){
    if($anyaHealth.help_knowledge -or $anyaHealth.tools -or $anyaHealth.capabilities){$anyaGrounded=$true}
  }
  if($anyaGrounded){
    Write-Goal 15 "Anya grounded in actual app structure" 'PASS' "Anya reports help knowledge or tool capabilities. Grounding infrastructure exists."
  }else{
    Write-Goal 15 "Anya grounded in actual app structure" 'WARN' "Cannot confirm Anya has grounded help knowledge from health endpoint. Run [8] Anya Audit for code-level verification."
  }

  # --- SCORECARD ---
  $gp=$script:mvPass;$gw=$script:mvWarn;$gf=$script:mvFail
  $totalGoals=$gp+$gf+$gw
  $pct=if($totalGoals -gt 0){[math]::Round(($gp/$totalGoals)*100)}else{0}
  [void]$rpt.Add("---")
  [void]$rpt.Add("# Mission Scorecard")
  [void]$rpt.Add("")
  [void]$rpt.Add("| Metric | Count |")
  [void]$rpt.Add("|--------|-------|")
  [void]$rpt.Add("| PASS | $gp |")
  [void]$rpt.Add("| WARN | $gw |")
  [void]$rpt.Add("| FAIL | $gf |")
  [void]$rpt.Add("| **Mission Score** | **${pct}%** ($gp/$totalGoals goals met) |")
  [void]$rpt.Add("")

  if($gf -gt 0){
    [void]$rpt.Add("## Critical Failures")
    [void]$rpt.Add("These goals FAIL and must be fixed before GrantFlow meets its mission.")
    [void]$rpt.Add("Review the FAIL sections above for specifics.")
    [void]$rpt.Add("")
  }
  if($gw -gt 0){
    [void]$rpt.Add("## Warnings")
    [void]$rpt.Add("$gw goal(s) partially met. Review WARN sections for improvement areas.")
    [void]$rpt.Add("")
  }

  [void]$rpt.Add("API cost: `$$([math]::Round($script:S.ApiCost,2))")

  Set-Content -Path $mvRpt -Value ($rpt -join "`n") -Encoding UTF8
  Save-KB $script:KB
  $lvl=if($gf -eq 0 -and $gw -le 3){'OK'}elseif($gf -le 2){'WARN'}else{'ERROR'}
  Write-Log "Mission Verify: $gp PASS, $gw WARN, $gf FAIL (${pct}%)" $lvl
  Send-Notify "Mission Verify" "Score: ${pct}% ($gp pass, $gw warn, $gf fail)"
  Start-Process $mvRpt
}

# ===================================================================
#  [7] BRAIN STATUS - Show what CodeGuard has learned
# ===================================================================
function Show-BrainStatus{
  Write-Host ""
  Write-Host "  === CodeGuard Brain ===" -ForegroundColor Cyan
  Write-Host "  Run #$($script:KB.runCount) | Last scan: $($script:KB.lastScanDate)" -ForegroundColor Gray

  if($script:KB.fileRisk -and $script:KB.fileRisk.PSObject.Properties.Count -gt 0){
    Write-Host ""
    Write-Host "  Top Risky Files:" -ForegroundColor Yellow
    $topRisk=$script:KB.fileRisk.PSObject.Properties|Sort-Object Value -Descending|Select-Object -First 8
    foreach($tr in $topRisk){Write-Host "    $($tr.Name) (risk: $($tr.Value))" -ForegroundColor White}
  }

  if($script:KB.bugPatterns -and $script:KB.bugPatterns.Count -gt 0){
    Write-Host ""
    Write-Host "  Recurring Bug Patterns:" -ForegroundColor Yellow
    $topBugs=$script:KB.bugPatterns|Sort-Object count -Descending|Select-Object -First 5
    foreach($bp in $topBugs){Write-Host "    $($bp.type): $($bp.count)x across $($bp.files.Count) file(s)" -ForegroundColor White}
  }

  if($script:KB.matchGrades -and $script:KB.matchGrades.Count -gt 0){
    Write-Host ""
    Write-Host "  Match Quality History:" -ForegroundColor Yellow
    $recent=$script:KB.matchGrades|Select-Object -Last 10
    foreach($mg in $recent){Write-Host "    $($mg.profile): $($mg.grade) ($($mg.relevant)/$($mg.irrelevant))" -ForegroundColor White}
  }

  if($script:KB.endpointHealth -and $script:KB.endpointHealth.PSObject.Properties.Count -gt 0){
    $flaky=$script:KB.endpointHealth.PSObject.Properties|Where-Object{$_.Value.failCount -gt 0}|Sort-Object {$_.Value.failCount} -Descending|Select-Object -First 5
    if($flaky){
      Write-Host ""
      Write-Host "  Flaky Endpoints:" -ForegroundColor Yellow
      foreach($fe in $flaky){Write-Host "    $($fe.Name): $($fe.Value.failCount) fails / $($fe.Value.passCount) passes" -ForegroundColor White}
    }
  }

  if($script:KB.fixHistory -and $script:KB.fixHistory.Count -gt 0){
    Write-Host ""
    Write-Host "  Recent Fixes ($($script:KB.fixHistory.Count) total):" -ForegroundColor Yellow
    $recentFixes=$script:KB.fixHistory|Select-Object -Last 5
    foreach($fx in $recentFixes){Write-Host "    $($fx.file): $($fx.description)" -ForegroundColor White}
  }

  if($script:KB.repoShape -and $script:KB.repoShape.totalFiles){
    $s=$script:KB.repoShape
    Write-Host ""
    Write-Host "  Repo Shape (discovered $($s.discoveredAt)):" -ForegroundColor Yellow
    Write-Host "    $($s.totalFiles) files | $($s.routeFiles) routes | $($s.serviceFiles) services | $($s.pageFiles) pages | $($s.crawlerFiles) crawlers" -ForegroundColor White
  }

  if($script:KB.discoveredEndpoints -and $script:KB.discoveredEndpoints.Count -gt 0){
    Write-Host ""
    Write-Host "  Auto-discovered endpoints: $($script:KB.discoveredEndpoints.Count)" -ForegroundColor Gray
  }

  Write-Host ""
}

# ===================================================================
#  MENU
# ===================================================================
function Show-Banner{
  Clear-Host
  Write-Host ""
  Write-Host "  GrantFlow CodeGuard v$($script:M.V) - Self-Learning Guardian" -ForegroundColor Cyan
  Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
  Write-Host "  Repo: github.com/$($script:M.Owner)/$($script:M.Repo)" -ForegroundColor Gray
  if($script:M.UseWorkBranch){
    Write-Host "  Commits: PR branch codeguard/run-* (not main) unless CODEGUARD_COMMIT_TO_MAIN=1" -ForegroundColor DarkCyan
  }else{
    Write-Host "  Commits: $($script:M.BaseBranch) (CODEGUARD_COMMIT_TO_MAIN set)" -ForegroundColor Yellow
  }
  Write-Host "  App:  $($script:M.App)" -ForegroundColor Gray
  Write-Host "  Logs: $($script:M.LogDir)" -ForegroundColor Gray
  Write-Host "  Brain: Run #$($script:KB.runCount)" -NoNewline -ForegroundColor DarkCyan
  if($script:KB.lastScanDate){Write-Host " | Last scan: $($script:KB.lastScanDate)" -ForegroundColor DarkGray}else{Write-Host "" }
  if($script:KB.bugPatterns -and $script:KB.bugPatterns.Count -gt 0){
    Write-Host "  Patterns learned: $($script:KB.bugPatterns.Count) | Files tracked: $(if($script:KB.fileRisk){$script:KB.fileRisk.PSObject.Properties.Count}else{0})" -ForegroundColor DarkCyan
  }
  Write-Host ""
}

function Show-Menu{
  Write-Host "  [1]  FULL SCAN      - Every file through Claude (expensive)" -ForegroundColor White
  Write-Host "  [Q]  QUICK SCAN     - Only changed files since last scan (cheap)" -ForegroundColor Green
  Write-Host "  [2]  TEST ENDPOINTS - Hit every API endpoint, validate responses" -ForegroundColor White
  Write-Host "  [3]  GEO CRAWL      - Launch crawlers for all 50 states" -ForegroundColor White
  Write-Host "  [4]  EVOLVE         - Claude analyzes app for improvements" -ForegroundColor Yellow
  Write-Host "  [5]  CROSS-FILE     - Deep cross-file dependency analysis" -ForegroundColor Magenta
  Write-Host "  [6]  MATCH AUDIT    - Test if profiles get relevant funding" -ForegroundColor Cyan
  Write-Host "  [7]  BRAIN STATUS   - Show what CodeGuard has learned" -ForegroundColor Blue
  Write-Host "  [8]  ANYA AUDIT     - Deep inspect Anya's mission alignment" -ForegroundColor DarkMagenta
  Write-Host "  [9]  MISSION VERIFY - Prove all 15 GrantFlow goals against live app" -ForegroundColor White -BackgroundColor DarkGreen
  Write-Host "  [A]  ALL            - Run Quick + Test + Match Audit" -ForegroundColor Green
  Write-Host "  [D]  DEEP SWEEP     - Full Scan + Test + Cross-File + Match Audit" -ForegroundColor DarkYellow
  Write-Host "  [X]  EXIT" -ForegroundColor Red
  Write-Host ""
}

# === AUTH AND LAUNCH ===
Show-Banner
$script:GH=Get-Tok 'GITHUB_TOKEN' 'GitHub PAT (repo scope)'
if(!$script:GH){Write-Host "  Need GitHub token" -ForegroundColor Red;exit 1}
$script:ANT=Get-Tok 'ANTHROPIC_API_KEY' 'Anthropic API key'
if(!$script:ANT){Write-Host "  Need Anthropic key" -ForegroundColor Red;exit 1}

$chk=Invoke-GH "git/refs/heads/$($script:M.BaseBranch)"
if(!$chk){Write-Host "  Cannot access repo. Check token." -ForegroundColor Red;exit 1}
Write-Log "Authenticated to $($script:M.Owner)/$($script:M.Repo)" 'OK'

# Startup API health check — fail fast if Claude key/model is broken
Write-Host "  Testing Claude API ($($script:M.Model))..." -ForegroundColor DarkGray -NoNewline
$testResult=Invoke-Claude "Reply with OK." "Say OK" 16
if($testResult){
  Write-Host " OK" -ForegroundColor Green
}else{
  Write-Host " FAILED" -ForegroundColor Red
  Write-Host "  Claude API returned an error. Check your ANTHROPIC_API_KEY and model ($($script:M.Model))." -ForegroundColor Red
  Write-Host "  CodeGuard cannot scan without a working Claude connection." -ForegroundColor Red
  Read-Host "  Press Enter to exit"
  exit 1
}

Start-Process $script:M.App
Start-Sleep -Milliseconds 500

function Run-Mode([string]$M){
  switch($M){
    'Scan'{Start-ScanAndFix}
    'QuickScan'{Start-QuickScan}
    'Test'{Start-TestAndFix}
    'GeoCrawl'{Start-GeoCrawl}
    'CrossFile'{Start-CrossFileAnalysis}
    'Evolve'{Start-Evolve}
    'MatchAudit'{Start-MatchAudit}
    'AnyaAudit'{Start-AnyaAudit}
    'MissionVerify'{Start-MissionVerify}
    'All'{Start-QuickScan;Start-TestAndFix;Start-MatchAudit}
    'Deep'{Start-ScanAndFix;Start-TestAndFix;Start-CrossFileAnalysis;Start-MatchAudit}
  }
}

if($Mode -ne 'Menu'){
  Run-Mode $Mode
  Save-KB $script:KB
  $el=(Get-Date)-$script:S.T0
  Write-Log "Done in $([math]::Round($el.TotalMinutes,1)) min | API cost: `$$([math]::Round($script:S.ApiCost,2))" 'OK'
  exit 0
}

$run=$true
while($run){
  Show-Menu
  $ch=Read-Host '  Select'
  switch($ch.ToUpper()){
    '1'{Run-Mode 'Scan'}
    'Q'{Run-Mode 'QuickScan'}
    '2'{Run-Mode 'Test'}
    '3'{Run-Mode 'GeoCrawl'}
    '4'{Run-Mode 'Evolve'}
    '5'{Run-Mode 'CrossFile'}
    '6'{Run-Mode 'MatchAudit'}
    '7'{Show-BrainStatus}
    '8'{Run-Mode 'AnyaAudit'}
    '9'{Run-Mode 'MissionVerify'}
    'A'{Run-Mode 'All'}
    'D'{Run-Mode 'Deep'}
    'X'{$run=$false}
    default{Write-Host "  Invalid choice" -ForegroundColor Red}
  }
  if($run -and $ch.ToUpper() -ne 'X'){
    Save-KB $script:KB
    $el=(Get-Date)-$script:S.T0
    Write-Host "  Runtime:$([math]::Round($el.TotalMinutes,1))m | Calls:$($script:S.Calls) | Fixes:$($script:S.Fixes) | Cost:`$$([math]::Round($script:S.ApiCost,2))" -ForegroundColor DarkGray
    Read-Host "`n  Press Enter for menu"
    Show-Banner
  }
}

Save-KB $script:KB
Write-Host ""
Write-Host "  Brain saved: $($script:M.KBFile)" -ForegroundColor DarkCyan
Write-Host "  Logs: $($script:M.LogDir)" -ForegroundColor Cyan
Write-Host "  Total API cost: `$$([math]::Round($script:S.ApiCost,2))" -ForegroundColor DarkCyan
Write-Host "  Goodbye." -ForegroundColor Gray
Write-Host ""
