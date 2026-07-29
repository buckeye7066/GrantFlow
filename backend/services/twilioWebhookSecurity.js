export function twilioWebhookPosture(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
  const configured = Boolean(
    String(
      env.TWILIO_MESSAGING_SERVICE_SID ||
      env.TWILIO_FROM_NUMBER ||
      env.TWILIO_ACCOUNT_SID ||
      env.TWILIO_PUBLIC_BASE_URL ||
      '',
    ).trim(),
  )
  const tokenConfigured = Boolean(String(env.TWILIO_AUTH_TOKEN || '').trim())
  const validationExplicitlyDisabled =
    String(env.TWILIO_VALIDATE_SIGNATURE || '').trim().toLowerCase() === 'false'

  return {
    production,
    configured,
    token_configured: tokenConfigured,
    validation_explicitly_disabled: validationExplicitlyDisabled,
    validation_required: production || (tokenConfigured && !validationExplicitlyDisabled),
    secure: !production || !configured || (tokenConfigured && !validationExplicitlyDisabled),
  }
}

export default { twilioWebhookPosture }
