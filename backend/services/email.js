import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL = process.env. FROM_EMAIL || 'onboarding@resend.dev';

let resendClient = null;
if (RESEND_API_KEY) {
  resendClient = new Resend(RESEND_API_KEY);
}

export async function sendVerificationEmail(email, code) {
  if (!resendClient) {
    console.warn('[email] Resend not configured; code:', code);
    return false;
  }

  try {
    await resendClient.emails. send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Your GrantFlow verification code',
      html: \
        <h2>GrantFlow Verification</h2>
        <p>Your verification code is: </p>
        <h1 style="font-size: 32px; letter-spacing: 5px;">\</h1>
        <p>This code expires in 10 minutes.</p>
      \,
    });
    return true;
  } catch (error) {
    console.error('[email] Failed to send:', error.message);
    return false;
  }
}
