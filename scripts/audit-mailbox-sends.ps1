# Identifies WHO/WHAT sent John's outreach drafts from dr.johnwhite's mailbox.
# Run:  pwsh -File C:\Users\firer\GrantFlow\scripts\audit-mailbox-sends.ps1
# A browser sign-in window will open — sign in as dr.johnwhite@axiombiolabs.org.

$ErrorActionPreference = 'Stop'
if (-not (Get-Module -ListAvailable ExchangeOnlineManagement)) {
  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName dr.johnwhite@axiombiolabs.org -ShowBanner:$false

# Unified audit log: every Send/SendAs/SendOnBehalf out of the tenant 7/1-7/4,
# with the client app id, client info string, and IP that performed it.
$results = Search-UnifiedAuditLog -StartDate '2026-07-01' -EndDate '2026-07-05' `
  -Operations Send, SendAs, SendOnBehalf -ResultSize 500

$parsed = $results | ForEach-Object {
  $d = $_.AuditData | ConvertFrom-Json
  [pscustomobject]@{
    Time       = $d.CreationTime
    Operation  = $d.Operation
    UserId     = $d.UserId
    ClientIP   = $d.ClientIPAddress
    ClientInfo = $d.ClientInfoString
    AppId      = $d.AppId
    Subject    = $d.Item.Subject
  }
}
$parsed | Sort-Object Time | Format-Table -AutoSize -Wrap
$parsed | Export-Csv "$HOME\mailbox-send-audit-20260701-04.csv" -NoTypeInformation
Write-Host "`nSaved full results to $HOME\mailbox-send-audit-20260701-04.csv"
Disconnect-ExchangeOnline -Confirm:$false
