# Anya AI Configuration Guide

## Quick Fix: Enable Anya's AI Capabilities

Anya needs API keys to provide full AI-powered assistance. Without them, she provides basic guided help.

## Setting Up API Keys in Railway

### 1. Get Your Anthropic API Key

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Go to **API Keys** section
4. Click **"Create Key"**
5. Copy the key (starts with `sk-ant-`)

### 2. Get Your OpenAI API Key (for grant matching)

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign up or log in
3. Go to **API keys** section
4. Click **"Create new secret key"**
5. Copy the key (starts with `sk-`)

### 3. Add to Railway

1. Go to your [Railway Dashboard](https://railway.app/dashboard)
2. Select your GrantFlow project
3. Click on your service
4. Go to **Variables** tab
5. Add these variables:

```env
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
OPENAI_API_KEY=sk-your-actual-key-here
```

6. Railway will automatically redeploy

## What Each API Does

- **ANTHROPIC_API_KEY**: Powers Anya's conversational AI and intelligent assistance
- **OPENAI_API_KEY**: Powers grant matching, proposal generation, and crawler intelligence

## Testing After Setup

1. Wait for Railway to redeploy (1-2 minutes)
2. Open GrantFlow and click on Anya
3. Ask: "Hello Anya, can you help me find grants?"
4. You should get an intelligent, contextual response

## Anya's Capabilities With AI

When properly configured, Anya can:

### 🔍 Grant Discovery
- Understand natural language grant queries
- Recommend specific opportunities based on profile
- Explain why grants match your organization

### 📝 Application Assistance
- Help write grant proposals
- Review application requirements
- Generate compelling narratives

### 🎯 Smart Recommendations
- Analyze your profile for optimization
- Suggest missing information
- Recommend grant categories to explore

### 🤖 Autonomous Operations (Admin Only)
- Run comprehensive code scans
- Test all API endpoints
- Execute intelligent crawlers
- Fix common code issues

## Anya Without AI (Fallback Mode)

If API keys aren't configured, Anya still helps with:
- Navigation guidance
- Feature explanations
- Quick links to key functions
- Basic troubleshooting

## Troubleshooting

### "I'm having trouble reaching the AI service"
- **Cause**: Missing or invalid ANTHROPIC_API_KEY
- **Fix**: Add the API key in Railway Variables

### Anya responds but not intelligently
- **Cause**: API key is set but invalid
- **Fix**: Verify your key at [Anthropic Console](https://console.anthropic.com/)

### Grant matching not working
- **Cause**: Missing OPENAI_API_KEY
- **Fix**: Add OpenAI key in Railway Variables

## Cost Management

### Anthropic (Claude)
- **Free Tier**: $5 credit to start
- **Typical Usage**: ~$0.01-0.05 per conversation
- **Monthly Estimate**: $5-20 for active use

### OpenAI
- **Free Tier**: $5 credit to start
- **Typical Usage**: ~$0.002 per grant match
- **Monthly Estimate**: $3-10 for active use

## Security Notes

- API keys are server-side only (never exposed to frontend)
- Keys are encrypted in Railway's infrastructure
- Consider rotating keys monthly for security
- Set spending limits in both platforms

## Environment Variable Reference

```env
# Required for Anya AI
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required for grant matching
OPENAI_API_KEY=sk-proj-...

# Optional: Specify model
ANYA_CLAUDE_MODEL=claude-3-sonnet-20240229

# Optional: Anya admin token
ANYA_ADMIN_TOKEN=your-secret-token
```

## Testing Commands

After configuration, test with:

```bash
# Test Anthropic connection
curl -X POST https://your-app.up.railway.app/api/anya/sessions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Session"}'

# Send test message
curl -X POST https://your-app.up.railway.app/api/anya/sessions/SESSION_ID/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Anya, can you help me?"}'
```

## Next Steps

1. Set up API keys in Railway
2. Wait for redeploy
3. Test Anya in the app
4. Enable autonomous operations (optional)
5. Monitor usage in API dashboards