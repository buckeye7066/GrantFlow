# PowerShell script to commit and push changes

Write-Host "=== Git Commit and Push ===" -ForegroundColor Cyan

# Add all changes
Write-Host "`nStaging all changes..." -ForegroundColor Yellow
git add -A

# Show status
Write-Host "`nCurrent status:" -ForegroundColor Yellow
git status --short

# Create commit message
$commitMessage = @"
Fix: Major improvements to GrantFlow

Key fixes and enhancements:

Authentication & Email:
- Add missing 'resend' package to fix login timeout
- Implement email service fallback when Resend unavailable
- Add timeout protection (5s backend, 30s frontend)
- Always show verification code when email fails

Anya AI Assistant:
- Enhanced fallback mode when AI keys missing
- Provide guided help without AI
- Better error messages and user guidance
- Support for autonomous operations

Environment & Config:
- Document all required environment variables
- Add test scripts for email and AI services
- Create comprehensive setup guides

Files changed:
- package.json: Added resend dependency
- backend/services/email.js: Timeout and fallback handling
- backend/services/emailFallback.js: Fallback email service
- backend/routes/auth.js: Email fallback and timeout
- src/api/client.js: Request timeout (30s)
- src/api/auth.js: Emergency fallback code
- backend/services/anyaOrchestrator.js: Better AI fallback
- backend/services/anyaAutonomous*.js: Enhanced tools
- Multiple documentation files for setup and configuration
"@

# Commit changes
Write-Host "`nCreating commit..." -ForegroundColor Yellow
git commit -m $commitMessage

# Push to origin main
Write-Host "`nPushing to origin main..." -ForegroundColor Yellow
git push origin main

Write-Host "`n✅ Changes pushed to GitHub successfully!" -ForegroundColor Green
Write-Host "Railway will automatically deploy the changes." -ForegroundColor Cyan