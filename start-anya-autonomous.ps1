#!/usr/bin/env pwsh
# Enable Anya's Full Autonomous Capabilities

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   🤖 ACTIVATING ANYA AUTONOMY 🤖" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Kill existing processes
Write-Host "Stopping existing services..." -ForegroundColor Yellow
taskkill /F /IM node.exe 2>$null | Out-Null

# Set all required environment variables
Write-Host "Configuring Anya's autonomous environment..." -ForegroundColor Green

# Core API Keys
$env:RESEND_API_KEY = "re_R2csV8Pm_LeAvTMhbTfimAcmygCvZuPZs"
$env:FROM_EMAIL = "onboarding@resend.dev"

# Enable Anya Autonomy
$env:ANYA_AUTONOMOUS_ENABLED = "true"
$env:ANYA_RUN_ON_STARTUP = "true"
$env:ANYA_CLAUDE_MODEL = "claude-3-5-sonnet-20241022"

# Set OpenAI key if available
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match "OPENAI_API_KEY=(.+)") {
            $env:OPENAI_API_KEY = $matches[1]
            Write-Host "✓ OpenAI API key configured" -ForegroundColor Green
        }
        if ($_ -match "ANTHROPIC_API_KEY=(.+)") {
            $env:ANTHROPIC_API_KEY = $matches[1]
            Write-Host "✓ Anthropic API key configured" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "Anya Configuration:" -ForegroundColor Cyan
Write-Host "  Autonomous Mode: ENABLED" -ForegroundColor Green
Write-Host "  Startup Operations: ENABLED" -ForegroundColor Green
Write-Host "  Model: $env:ANYA_CLAUDE_MODEL" -ForegroundColor Green
Write-Host ""

Write-Host "Starting GrantFlow with Anya fully autonomous..." -ForegroundColor Yellow
Write-Host ""

# Start the services
npm run dev:full

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   ✅ ANYA IS NOW FULLY AUTONOMOUS!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Anya will now:" -ForegroundColor White
Write-Host "  • Scan code for errors on startup" -ForegroundColor Gray
Write-Host "  • Run crawler operations automatically" -ForegroundColor Gray
Write-Host "  • Monitor system health" -ForegroundColor Gray
Write-Host "  • Respond to admin commands" -ForegroundColor Gray
Write-Host "  • Process profiles autonomously" -ForegroundColor Gray
Write-Host "  • Save 80%+ matches to pipelines" -ForegroundColor Gray
Write-Host ""
Write-Host "Access Anya at: http://localhost:5173/grantflow" -ForegroundColor Cyan