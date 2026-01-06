# Email Authentication API Improvements

## POST /api/auth/email/start

### Response Changes

The response structure has been **enhanced** with additional fields. All existing fields remain intact, so this is a **non-breaking** change.

#### New Fields Added

1. **`email_sent`** (boolean): Indicates whether the email was successfully sent
   - `true`: Email was sent via Resend
   - `false`: Email service not configured or sending failed

2. **`notice`** (string, optional): User-friendly message explaining the situation
   - Only included when email service is not configured or in development mode
   - Helps users understand they should use the preview code

3. **`error_type`** (string): Specific error classification for better debugging
   - `validation_error`: Invalid or missing email
   - `database_error`: Database operation failed
   - `rate_limit_cooldown`: User must wait before requesting another code
   - `internal_error`: Unexpected error occurred

#### Example Responses

**Success (Email Service Configured)**
```json
{
  "message": "Verification code sent to your email",
  "email_sent": true,
  "user_hint": {
    "id": "uuid",
    "display_name": "user",
    "primary_email": "user@example.com"
  }
}
```

**Success (Email Service Not Configured - Development)**
```json
{
  "message": "Verification code generated (email service unavailable)",
  "email_sent": false,
  "user_hint": {
    "id": "uuid",
    "display_name": "user",
    "primary_email": "user@example.com"
  },
  "previewCode": "123456",
  "notice": "Email service is not configured. Use the preview code to continue."
}
```

**Error (Rate Limited)**
```json
{
  "error": "Please wait 42 seconds before requesting another code",
  "error_type": "rate_limit_cooldown",
  "retry_after_seconds": 42
}
```

**Error (Invalid Email)**
```json
{
  "error": "Invalid email address",
  "error_type": "validation_error"
}
```

**Error (Database Error)**
```json
{
  "error": "Database error occurred. Please try again.",
  "error_type": "database_error",
  "details": "Connection timeout" // Only in non-production
}
```

### Benefits

1. **Better Client Experience**: Clients can distinguish between email being sent vs not sent
2. **Clearer Error Messages**: Specific error types help clients handle errors appropriately
3. **Improved Development**: Preview codes always available when needed
4. **Backward Compatible**: Existing clients continue to work without changes
5. **Better Monitoring**: Error types enable better logging and alerting

### Migration Guide

No migration needed! The changes are additive and backward compatible.

If you want to take advantage of the new fields:

```javascript
// Check if email was actually sent
const response = await fetch('/api/auth/email/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' })
});

const data = await response.json();

if (response.ok) {
  if (data.email_sent) {
    showMessage('Check your email for the verification code');
  } else if (data.previewCode) {
    showMessage(`Your code is: ${data.previewCode}`);
  }
}

// Handle specific error types
if (!response.ok) {
  switch (data.error_type) {
    case 'validation_error':
      // Show validation error to user
      break;
    case 'rate_limit_cooldown':
      // Show countdown timer with retry_after_seconds
      break;
    case 'database_error':
      // Show generic error, maybe retry
      break;
    default:
      // Show generic error message
  }
}
```
