# Anya AI Assistant Troubleshooting Guide

This guide helps you diagnose and fix issues with the Anya AI Assistant.

## Quick Diagnostics

### 1. Test the API Connection

Visit the test endpoint to check Anya's status:
```
GET /api/anya/test
```

This endpoint will tell you:
- Whether the ANTHROPIC_API_KEY is configured
- If the Claude API connection is working
- Any specific error messages

Example using curl:
```bash
curl https://your-app.railway.app/api/anya/test
```

### 2. Check Server Logs

Anya now has comprehensive logging. Look for lines starting with `[Anya]` in your server logs:

```
[Anya] === generateAssistantResponse called ===
[Anya] Session ID: abc-123
[Anya] User: user-456
[Anya] Message length: 25
[Anya] Attempting to initialize Claude client...
[Anya] ✓ Claude client initialized successfully
[Anya] === Calling Claude API ===
[Anya] ✓ Claude API call completed in 1234 ms
```

## Common Issues

### Issue 1: "I'm having trouble reaching the AI service"

**Symptoms:**
- User sees generic error message
- No AI responses

**Diagnosis:**
1. Check the `/api/anya/test` endpoint
2. Look for `[Anya]` logs in server output

**Solution:**
- Ensure `ANTHROPIC_API_KEY` is set in Railway environment variables
- Verify the API key starts with `sk-ant-`
- Check that your Anthropic account has available credits

### Issue 2: "Authentication failed"

**Symptoms:**
- Error about invalid API key
- Status 401 errors in logs

**Diagnosis:**
Look for log line:
```
[Anya] ✗ Authentication error - check API key
```

**Solution:**
1. Go to Railway dashboard
2. Navigate to your project → Variables
3. Update `ANTHROPIC_API_KEY` with a valid key from https://console.anthropic.com/
4. Redeploy the application

### Issue 3: Messages not getting responses

**Symptoms:**
- User message is saved
- No assistant response appears

**Diagnosis:**
Check logs for:
```
[Anya Route] === POST /sessions/:sessionId/messages ===
[Anya Route] ✓ User message saved, ID: xxx
[Anya Route] Generating assistant response...
```

**Solution:**
- Ensure messages are being received (check `[Anya Route]` logs)
- Verify database is accessible
- Check for any error messages in the generation step

### Issue 4: Slow responses

**Symptoms:**
- Long delays before Anya responds
- Timeout errors

**Diagnosis:**
Look for timing information:
```
[Anya] ✓ Claude API call completed in 5000 ms
```

**Solution:**
- Normal response time is 1-3 seconds
- If consistently over 5 seconds, check:
  - Network connectivity to Anthropic API
  - Anthropic service status
  - Railway resource limits

## Configuration Checklist

✅ Environment variables set:
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `ANYA_CLAUDE_MODEL` (optional) - Defaults to `claude-3-5-sonnet-20241022`

✅ Anthropic account:
- API key is valid
- Account has credits
- No rate limiting

✅ Database:
- `anya_sessions` table exists
- `anya_messages` table exists
- Database is writable

## Testing Manually

### Test 1: API Key Configuration
```bash
curl https://your-app.railway.app/api/anya/test
```

Expected response (when working):
```json
{
  "status": "ready",
  "anthropic": {
    "status": "connected",
    "api_key_configured": true,
    "model": {
      "model": "claude-3-haiku-20240307",
      "test_response": "ok"
    }
  },
  "message": "Anya is ready! Claude API connection successful."
}
```

### Test 2: Create a Session and Send a Message

1. First, create a session:
```bash
curl -X POST https://your-app.railway.app/api/anya/sessions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Session"}'
```

2. Send a message (use session ID from above):
```bash
curl -X POST https://your-app.railway.app/api/anya/sessions/SESSION_ID/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Anya, can you help me?"}'
```

## Log Messages Reference

### Success Indicators
- `[Anya] ✓ Claude client initialized successfully`
- `[Anya] ✓ Claude API call completed in X ms`
- `[Anya] ✓ Response text length: X`
- `[Anya Route] ✓ Assistant message saved`

### Warning Indicators
- `[Anya] ✗ Claude client initialization failed`
- `[Anya] ✗ Unable to load session history`
- `[Anya] ✗ Claude API returned empty response`

### Error Indicators
- `[Anya] === Claude API Error ===`
- `[Anya] ✗ Authentication error - check API key`
- `[Anya Route] ✗ Request failed`

## Getting Help

If issues persist after following this guide:

1. **Collect information:**
   - Response from `/api/anya/test`
   - Recent `[Anya]` log messages
   - Exact error message shown to user

2. **Check Anthropic status:**
   - Visit https://status.anthropic.com/

3. **Verify Railway deployment:**
   - Check Railway logs for any deployment errors
   - Ensure environment variables are set correctly

4. **Create an issue:**
   - Include all collected information
   - Steps to reproduce the problem
   - Expected vs actual behavior
