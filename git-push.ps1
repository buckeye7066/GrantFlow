#!/usr/bin/env pwsh

Write-Host "Git Push Script Starting..." -ForegroundColor Green

# Navigate to project directory
Set-Location "C:\Users\firer\GrantFlow"
Write-Host "Directory: $(Get-Location)"

# Add all changes
Write-Host "`nAdding all changes..." -ForegroundColor Yellow
& git add -A
if ($LASTEXITCODE -eq 0) {
    Write-Host "Files added successfully" -ForegroundColor Green
} else {
    Write-Host "Error adding files" -ForegroundColor Red
    exit 1
}

# Commit changes
Write-Host "`nCommitting changes..." -ForegroundColor Yellow
$commitMessage = @"
Fix multi-selection and 80%+ match filtering in Discover Grants

- Fixed multi-selection state management bug that only allowed 1 selection
  * Properly clone Set instances to ensure React state updates
  * Added debug logging to track selection state changes
  
- Added filtering to only show opportunities with 80%+ match scores
  * Filter comprehensive match results to 80%+ matches only
  * Log match scores for debugging
  * Update message to show filtered count
  
- Files modified:
  * src/components/discovery/SearchResults.jsx - Fixed selection state
  * src/components/discovery/discoveryHelpers.jsx - Added 80% filtering
"@

& git commit -m $commitMessage
if ($LASTEXITCODE -eq 0) {
    Write-Host "Commit successful" -ForegroundColor Green
} else {
    Write-Host "Error committing (may already be committed)" -ForegroundColor Yellow
}

# Push to GitHub
Write-Host "`nPushing to GitHub..." -ForegroundColor Yellow
& git push origin main
if ($LASTEXITCODE -eq 0) {
    Write-Host "`nSuccessfully pushed to GitHub!" -ForegroundColor Green
} else {
    Write-Host "Error pushing to GitHub" -ForegroundColor Red
    exit 1
}

Write-Host "`n✅ All done!" -ForegroundColor Green