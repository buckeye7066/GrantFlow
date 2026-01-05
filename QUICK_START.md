# Quick Start Guide: Auth & Claude Integration

## 🎯 What Changed

This PR fixes authentication token refresh errors and migrates Anya from OpenAI to Claude API.

## ⚡ Quick Setup (3 Steps)

### 1. Get Your Anthropic API Key
1. Visit https://console.anthropic.com/
2. Sign up or log in
3. Generate an API key (starts with `sk-ant-`)

### 2. Configure Environment
```bash
# Copy the example file
cp .env.example .env

# Edit .env and add your key
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here

# Optional: Use a different model
ANYA_CLAUDE_MODEL=claude-sonnet-4-20250514
```

### 3. Install & Test
```bash
# Install new dependency
cd backend && npm install

# Run integration tests
cd .. && node test-integration.js

# Start the backend
npm run backend
```

## ✅ Verify It Works

### Test Auth Refresh
1. Log into the app
2. Wait for token to expire (or simulate)
3. Verify no 401 errors appear
4. Check that refresh happens seamlessly

### Test Anya AI
1. Open Anya chat in the app
2. Ask: "How can you help me with grants?"
3. Verify you get a contextual response
4. Check backend logs for Claude API calls

## 🐛 Troubleshooting

### "Missing API key" Error
```bash
# Make sure .env file has the key
cat .env | grep ANTHROPIC_API_KEY

# Should show: ANTHROPIC_API_KEY=sk-ant-...
```

### "Module not found" Error
```bash
# Reinstall dependencies
cd backend && npm install
```

### Anya Not Responding
```bash
# Check backend logs
npm run backend

# Should see: "[anya] Claude client initialized"
# Not: "[anya] Claude client unavailable"
```

### Auth Still Failing
- Clear browser cache and localStorage
- Check browser console for errors
- Verify refresh token in localStorage

## 📖 Full Documentation

See `IMPLEMENTATION_AUTH_CLAUDE.md` for:
- Detailed technical changes
- Migration guide
- Security considerations
- Rollback procedures

## 🔍 What to Look For

**Good Signs:**
- ✅ Anya responds with contextual advice
- ✅ No 401 errors in console
- ✅ Token refresh happens silently
- ✅ Backend logs show Claude API calls

**Bad Signs:**
- ❌ "Missing API key" in backend logs
- ❌ Repeated 401 errors in browser
- ❌ "Invalid refresh token" messages
- ❌ Anya shows fallback messages

## 🚨 Emergency Rollback

If something breaks:

```bash
# Option 1: Revert commits
git revert HEAD~3..HEAD

# Option 2: Checkout previous version
git checkout <previous-commit-hash>

# Option 3: Manually restore OpenAI
# 1. Set OPENAI_API_KEY in .env
# 2. Revert anyaOrchestrator.js from git history
# 3. Remove @anthropic-ai/sdk from package.json
# 4. npm install && npm run backend
```

## 📞 Need Help?

Check these in order:
1. Run `node test-integration.js` - all tests pass?
2. Check `.env` file - API key set correctly?
3. Check `backend/package.json` - has @anthropic-ai/sdk?
4. Check backend logs - any errors?
5. Check browser console - any 401s?

## 🎉 Success Criteria

You're all set when:
- [x] Integration tests pass
- [x] Backend starts without errors
- [x] Anya provides helpful responses
- [x] Auth refresh works silently
- [x] No 401 errors in console
- [x] Tokens clear properly on errors

---

**Time to Complete:** ~5 minutes  
**Difficulty:** Easy  
**Dependencies:** Anthropic API key (free tier available)
