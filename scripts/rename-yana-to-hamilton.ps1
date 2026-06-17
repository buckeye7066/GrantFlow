# scripts/rename-yana-to-hamilton.ps1
#
# One-shot rename of the application-autopilot agent from "Yana" to
# "Hamilton" inside the files that belong to that agent. The existing
# Yana lead-discovery agent (YanaLeadFunnel, johnYanaBridge, agent
# telemetry kind=yana) is intentionally LEFT ALONE.
#
# Usage:
#   pwsh ./scripts/rename-yana-to-hamilton.ps1
#
# The script does string-level replacements only inside the
# autopilot/Hamilton scope. It exits cleanly so it can be re-run.

$ErrorActionPreference = 'Stop'

# Files in the Hamilton scope. We only rewrite content inside these.
$includePatterns = @(
  'backend/services/hamilton/*.js',
  'backend/services/hamiltonApplicationAgent.js',
  'backend/routes/hamiltonAutomation.js',
  'src/components/hamilton/*.jsx',
  'src/components/hamilton/*.js',
  'src/components/admin/AdminHamiltonHardStops.jsx',
  'src/api/hamilton.js',
  'tests/unit/hamilton-*.test.mjs',
  'docs/HAMILTON_APPLICATION_AGENT.md',
  'docs/HAMILTON_AUTOMATION_AGENT.md'
)

# Repository root (script lives in scripts/).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$files = @()
foreach ($pat in $includePatterns) {
  $matches = Get-ChildItem -Path $pat -ErrorAction SilentlyContinue
  if ($matches) { $files += $matches }
}
Write-Host "Sweeping $($files.Count) Hamilton-scope files..."

# Replacement table — order matters. Run LONGEST tokens first so we
# don't double-replace.
$replacements = @(
  # Notification types (admin first to avoid clash with yana_admin_*).
  @{ from = 'yana_admin_hard_stop'; to = 'hamilton_admin_hard_stop' },
  @{ from = 'yana_admin_missing_info'; to = 'hamilton_admin_missing_info' },
  @{ from = 'yana_admin_login_required'; to = 'hamilton_admin_login_required' },
  @{ from = 'yana_admin_document_required'; to = 'hamilton_admin_document_required' },
  @{ from = 'yana_admin_payment_required'; to = 'hamilton_admin_payment_required' },
  @{ from = 'yana_admin_attestation_required'; to = 'hamilton_admin_attestation_required' },
  @{ from = 'yana_admin_portal_blocked'; to = 'hamilton_admin_portal_blocked' },
  @{ from = 'yana_admin_task_failed'; to = 'hamilton_admin_task_failed' },
  @{ from = 'yana_admin_task_completed'; to = 'hamilton_admin_task_completed' },

  # User-side notification types.
  @{ from = 'yana_application_submitted'; to = 'hamilton_application_submitted' },
  @{ from = 'yana_application_failed'; to = 'hamilton_application_failed' },
  @{ from = 'yana_application_blocked'; to = 'hamilton_application_blocked' },
  @{ from = 'yana_application_ready'; to = 'hamilton_application_ready' },
  @{ from = 'yana_generated_document_saved'; to = 'hamilton_generated_document_saved' },
  @{ from = 'yana_attestation_required'; to = 'hamilton_attestation_required' },
  @{ from = 'yana_payment_required'; to = 'hamilton_payment_required' },
  @{ from = 'yana_document_required'; to = 'hamilton_document_required' },
  @{ from = 'yana_login_required'; to = 'hamilton_login_required' },
  @{ from = 'yana_2fa_required'; to = 'hamilton_2fa_required' },
  @{ from = 'yana_captcha_required'; to = 'hamilton_captcha_required' },
  @{ from = 'yana_review_required'; to = 'hamilton_review_required' },
  @{ from = 'yana_missing_info'; to = 'hamilton_missing_info' },
  @{ from = 'yana_task_completed'; to = 'hamilton_task_completed' },
  @{ from = 'yana_task_started'; to = 'hamilton_task_started' },
  @{ from = 'yana_task_blocked'; to = 'hamilton_task_blocked' },
  @{ from = 'yana_task_progress'; to = 'hamilton_task_progress' },
  @{ from = 'yana_hard_stop'; to = 'hamilton_hard_stop' },
  @{ from = 'yana_submitted'; to = 'hamilton_submitted' },
  @{ from = 'yana_failed'; to = 'hamilton_failed' },

  # DB tables.
  @{ from = 'yana_authorizations'; to = 'hamilton_authorizations' },
  @{ from = 'yana_blocker_resolutions'; to = 'hamilton_blocker_resolutions' },
  @{ from = 'yana_blockers'; to = 'hamilton_blockers' },
  @{ from = 'yana_saved_sessions'; to = 'hamilton_saved_sessions' },
  @{ from = 'yana_payment_authorizations'; to = 'hamilton_payment_authorizations' },
  @{ from = 'yana_attestation_authorizations'; to = 'hamilton_attestation_authorizations' },
  @{ from = 'yana_portal_policies'; to = 'hamilton_portal_policies' },
  @{ from = 'yana_resolved_fields'; to = 'hamilton_resolved_fields' },
  @{ from = 'yana_portal_providers'; to = 'hamilton_portal_providers' },
  @{ from = 'yana_autopilot_runs'; to = 'hamilton_autopilot_runs' },

  # API base.
  @{ from = '/api/yana/automation'; to = '/api/hamilton/automation' },
  @{ from = '/api/yana/'; to = '/api/hamilton/' },

  # Env / constants.
  @{ from = 'YANA_ADMIN_EMAIL'; to = 'HAMILTON_ADMIN_EMAIL' },
  @{ from = 'YANA_BROWSER_STORAGE_DIR'; to = 'HAMILTON_BROWSER_STORAGE_DIR' },
  @{ from = 'YANA_NOTIFICATION_TYPES'; to = 'HAMILTON_NOTIFICATION_TYPES' },
  @{ from = 'YANA_USER_NOTIFICATION_TYPES'; to = 'HAMILTON_USER_NOTIFICATION_TYPES' },
  @{ from = 'YANA_ADMIN_NOTIFICATION_TYPES'; to = 'HAMILTON_ADMIN_NOTIFICATION_TYPES' },
  @{ from = 'YANA_SEVERITIES'; to = 'HAMILTON_SEVERITIES' },
  @{ from = 'YANA_TYPES'; to = 'HAMILTON_TYPES' },

  # File path imports — directory rename.
  @{ from = "backend/services/yana/"; to = "backend/services/hamilton/" },
  @{ from = "../yana/"; to = "../hamilton/" },
  @{ from = "/services/yana/"; to = "/services/hamilton/" },
  @{ from = "../../backend/services/yana/"; to = "../../backend/services/hamilton/" },
  @{ from = "components/yana/"; to = "components/hamilton/" },

  # Module name imports — file-level renames.
  @{ from = "yanaAutomationOrchestrator"; to = "hamiltonAutomationOrchestrator" },
  @{ from = "yanaAutomationClassifier"; to = "hamiltonAutomationClassifier" },
  @{ from = "yanaAutopilotEngine"; to = "hamiltonAutopilotEngine" },
  @{ from = "yanaPreflightResolver"; to = "hamiltonPreflightResolver" },
  @{ from = "yanaPreflight"; to = "hamiltonPreflight" },
  @{ from = "yanaHardStopResolver"; to = "hamiltonHardStopResolver" },
  @{ from = "yanaBlockerClassifier"; to = "hamiltonBlockerClassifier" },
  @{ from = "yanaBlockerStore"; to = "hamiltonBlockerStore" },
  @{ from = "yanaCredentialSessionService"; to = "hamiltonCredentialSessionService" },
  @{ from = "yanaPaymentAuthorizationService"; to = "hamiltonPaymentAuthorizationService" },
  @{ from = "yanaESignatureService"; to = "hamiltonESignatureService" },
  @{ from = "yanaAttestationStore"; to = "hamiltonAttestationStore" },
  @{ from = "yanaPortalPolicyRegistry"; to = "hamiltonPortalPolicyRegistry" },
  @{ from = "yanaResolvedFieldStore"; to = "hamiltonResolvedFieldStore" },
  @{ from = "yanaAuthorizationStore"; to = "hamiltonAuthorizationStore" },
  @{ from = "yanaPortalProviders"; to = "hamiltonPortalProviders" },
  @{ from = "yanaApplicationPacketGenerator"; to = "hamiltonApplicationPacketGenerator" },
  @{ from = "yanaNotifications"; to = "hamiltonNotifications" },
  @{ from = "yanaAdminAccount"; to = "hamiltonAdminAccount" },
  @{ from = "yanaApplicationAgent"; to = "hamiltonApplicationAgent" },
  @{ from = "yanaAutomation.js"; to = "hamiltonAutomation.js" },

  # Component / hook renames.
  @{ from = "YanaToastBridge"; to = "HamiltonToastBridge" },
  @{ from = "YanaTaskDrawer"; to = "HamiltonTaskDrawer" },
  @{ from = "YanaAutopilotAuthorization"; to = "HamiltonAutopilotAuthorization" },
  @{ from = "YanaAutomationQueue"; to = "HamiltonAutomationQueue" },
  @{ from = "YanaSelectionToolbar"; to = "HamiltonSelectionToolbar" },
  @{ from = "YanaSelectionContext"; to = "HamiltonSelectionContext" },
  @{ from = "YanaTaskBadge"; to = "HamiltonTaskBadge" },
  @{ from = "YanaPortalsPanel"; to = "HamiltonPortalsPanel" },
  @{ from = "AdminYanaHardStops"; to = "AdminHamiltonHardStops" },
  @{ from = "useYanaSelection"; to = "useHamiltonSelection" },
  @{ from = "yanaSelection"; to = "hamiltonSelection" },

  # UI labels — phrases first (before generic Yana -> Hamilton).
  @{ from = 'Automate with Yana'; to = 'Automate with Hamilton' },
  @{ from = 'Yana Autopilot'; to = 'Hamilton Autopilot' },
  @{ from = 'Run Yana to completion'; to = 'Run Hamilton to completion' },
  @{ from = 'Yana is completing this application'; to = 'Hamilton is completing this application' },
  @{ from = 'Yana generated printable packet'; to = 'Hamilton generated printable packet' },
  @{ from = 'Yana submitted through portal'; to = 'Hamilton submitted through portal' },
  @{ from = 'Resolve blocker and continue Yana'; to = 'Resolve blocker and continue Hamilton' },

  # Generic identifier replacements LAST.
  @{ from = 'YANA_ADMIN'; to = 'HAMILTON_ADMIN' },
  @{ from = 'YANA'; to = 'HAMILTON' },
  @{ from = 'Yana'; to = 'Hamilton' },
  @{ from = 'yana'; to = 'hamilton' }
)

$total = 0
foreach ($file in $files) {
  $path = $file.FullName
  $orig = Get-Content -Raw -LiteralPath $path -ErrorAction SilentlyContinue
  if ($null -eq $orig) { continue }
  $next = $orig
  foreach ($r in $replacements) {
    $next = $next.Replace($r.from, $r.to)
  }
  if ($next -ne $orig) {
    Set-Content -LiteralPath $path -Value $next -NoNewline -Encoding UTF8
    Write-Host "  rewrote $($file.FullName.Substring($root.Length+1))"
    $total += 1
  }
}
Write-Host "Done. $total files rewritten."
