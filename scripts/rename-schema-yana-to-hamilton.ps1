# Rename autopilot-only yana_* identifiers to hamilton_* inside
# backend/db/schema.sql while leaving John's `yana_lead_id` column
# (which belongs to the existing Yana lead-discovery agent) alone.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$path = 'backend/db/schema.sql'
$txt = Get-Content -Raw -LiteralPath $path

$tokens = @(
  'yana_authorizations',
  'yana_blockers',
  'yana_blocker_resolutions',
  'yana_saved_sessions',
  'yana_payment_authorizations',
  'yana_attestation_authorizations',
  'yana_portal_policies',
  'yana_resolved_fields',
  'yana_portal_providers',
  'yana_autopilot_runs',
  'yana_runs',
  'idx_yana_blockers',
  'idx_yana_auth',
  'idx_yana_autopilot',
  'idx_yana_blocker_res',
  'idx_yana_sessions',
  'idx_yana_pay',
  'idx_yana_attest',
  'idx_yana_policy',
  'idx_yana_resolved',
  'idx_yana_runs'
)

foreach ($t in $tokens) {
  $replacement = $t.Replace('yana_', 'hamilton_')
  $txt = $txt.Replace($t, $replacement)
}

$txt = $txt.Replace(
  '-- Yana student-university portal layer + application tasks (migration 085).',
  '-- Hamilton (formerly Yana autopilot) student portal layer + application tasks (migration 085).'
)
$txt = $txt.Replace(
  'Yana Autopilot authorization model',
  'Hamilton Autopilot authorization model'
)

Set-Content -LiteralPath $path -Value $txt -NoNewline -Encoding UTF8
Write-Host "schema.sql updated"
