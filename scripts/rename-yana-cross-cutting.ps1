# scripts/rename-yana-cross-cutting.ps1
#
# Targeted in-file renames for cross-cutting consumers of the Hamilton
# (formerly Yana autopilot) namespace. We do NOT touch any string that
# refers to the existing Yana lead-discovery agent.

$ErrorActionPreference = 'Stop'

$includeFiles = @(
  'src/components/pipeline/GrantCard.jsx',
  'src/components/profiles/StudentPortalsCard.jsx',
  'src/pages/Admin.jsx',
  'src/components/shared/toastHelpers.jsx',
  'backend/services/schoolPortalImportService.js',
  'backend/routes/studentPortals.js',
  'backend/routes/applicationTasks.js',
  'shared/adminEmail.js'
)

# Replacement table (longest tokens first).
$replacements = @(
  # Notification types - admin-side first.
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

  # API base.
  @{ from = '/api/yana/automation'; to = '/api/hamilton/automation' },
  @{ from = '/api/yana/'; to = '/api/hamilton/' },

  # Module / file path imports for autopilot.
  @{ from = 'backend/services/yana/'; to = 'backend/services/hamilton/' },
  @{ from = '/services/yana/'; to = '/services/hamilton/' },
  @{ from = '../yana/'; to = '../hamilton/' },
  @{ from = 'components/yana/'; to = 'components/hamilton/' },
  @{ from = '@/components/yana/'; to = '@/components/hamilton/' },
  @{ from = '@/api/yana'; to = '@/api/hamilton' },

  # Module identifiers.
  @{ from = 'yanaAutomationOrchestrator'; to = 'hamiltonAutomationOrchestrator' },
  @{ from = 'yanaAutomationClassifier'; to = 'hamiltonAutomationClassifier' },
  @{ from = 'yanaAutopilotEngine'; to = 'hamiltonAutopilotEngine' },
  @{ from = 'yanaPreflightResolver'; to = 'hamiltonPreflightResolver' },
  @{ from = 'yanaPreflight'; to = 'hamiltonPreflight' },
  @{ from = 'yanaHardStopResolver'; to = 'hamiltonHardStopResolver' },
  @{ from = 'yanaBlockerClassifier'; to = 'hamiltonBlockerClassifier' },
  @{ from = 'yanaBlockerStore'; to = 'hamiltonBlockerStore' },
  @{ from = 'yanaCredentialSessionService'; to = 'hamiltonCredentialSessionService' },
  @{ from = 'yanaPaymentAuthorizationService'; to = 'hamiltonPaymentAuthorizationService' },
  @{ from = 'yanaESignatureService'; to = 'hamiltonESignatureService' },
  @{ from = 'yanaAttestationStore'; to = 'hamiltonAttestationStore' },
  @{ from = 'yanaPortalPolicyRegistry'; to = 'hamiltonPortalPolicyRegistry' },
  @{ from = 'yanaResolvedFieldStore'; to = 'hamiltonResolvedFieldStore' },
  @{ from = 'yanaAuthorizationStore'; to = 'hamiltonAuthorizationStore' },
  @{ from = 'yanaPortalProviders'; to = 'hamiltonPortalProviders' },
  @{ from = 'yanaApplicationPacketGenerator'; to = 'hamiltonApplicationPacketGenerator' },
  @{ from = 'yanaNotifications'; to = 'hamiltonNotifications' },
  @{ from = 'yanaAdminAccount'; to = 'hamiltonAdminAccount' },
  @{ from = 'yanaApplicationAgent'; to = 'hamiltonApplicationAgent' },
  @{ from = 'yanaAutomation.js'; to = 'hamiltonAutomation.js' },

  # Component / hook renames.
  @{ from = 'YanaToastBridge'; to = 'HamiltonToastBridge' },
  @{ from = 'YanaTaskDrawer'; to = 'HamiltonTaskDrawer' },
  @{ from = 'YanaAutopilotAuthorization'; to = 'HamiltonAutopilotAuthorization' },
  @{ from = 'YanaAutomationQueue'; to = 'HamiltonAutomationQueue' },
  @{ from = 'YanaSelectionToolbar'; to = 'HamiltonSelectionToolbar' },
  @{ from = 'YanaSelectionContext'; to = 'HamiltonSelectionContext' },
  @{ from = 'YanaSelectionProvider'; to = 'HamiltonSelectionProvider' },
  @{ from = 'YanaTaskBadge'; to = 'HamiltonTaskBadge' },
  @{ from = 'YanaPortalsPanel'; to = 'HamiltonPortalsPanel' },
  @{ from = 'AdminYanaHardStops'; to = 'AdminHamiltonHardStops' },
  @{ from = 'useYanaSelection'; to = 'useHamiltonSelection' },
  @{ from = 'yanaSelection'; to = 'hamiltonSelection' },
  @{ from = 'yanaSelectionSource'; to = 'hamiltonSelectionSource' },
  @{ from = 'yanaIsSelected'; to = 'hamiltonIsSelected' },
  @{ from = 'yanaTask'; to = 'hamiltonTask' },
  @{ from = 'yanaDrawerOpen'; to = 'hamiltonDrawerOpen' },
  @{ from = 'setYanaTask'; to = 'setHamiltonTask' },
  @{ from = 'setYanaDrawerOpen'; to = 'setHamiltonDrawerOpen' },

  # UI labels.
  @{ from = 'Selected for Yana'; to = 'Selected for Hamilton' },
  @{ from = 'Select for Yana automation'; to = 'Select for Hamilton automation' },
  @{ from = 'Automate with Yana'; to = 'Automate with Hamilton' },
  @{ from = 'Remove from Yana selection'; to = 'Remove from Hamilton selection' },
  @{ from = 'Resume / view Yana task'; to = 'Resume / view Hamilton task' },
  @{ from = 'Yana Autopilot'; to = 'Hamilton Autopilot' },
  @{ from = 'Run Yana to completion'; to = 'Run Hamilton to completion' },
  @{ from = 'Let Yana help'; to = 'Let Hamilton help' },

  # Constants used outside Hamilton scope.
  @{ from = 'YANA_ADMIN_EMAIL'; to = 'HAMILTON_ADMIN_EMAIL' },
  @{ from = 'isYanaAdminEmail'; to = 'isHamiltonAdminEmail' }
)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$total = 0
foreach ($rel in $includeFiles) {
  $path = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $orig = Get-Content -Raw -LiteralPath $path
  if ($null -eq $orig) { continue }
  $next = $orig
  foreach ($r in $replacements) {
    $next = $next.Replace($r.from, $r.to)
  }
  if ($next -ne $orig) {
    Set-Content -LiteralPath $path -Value $next -NoNewline -Encoding UTF8
    Write-Host "  rewrote $rel"
    $total += 1
  }
}
Write-Host "Done. $total files rewritten."
