// Updated email.js to resolve FROM email and add structured logging.
const { validateApiKey } = require('utils/validation');
const logger = require('utils/logger');

const FROM_EMAIL = process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'safe_default@example.com';

function sendEmail(to, subject, body) {
    // Validate API Key
    if (!validateApiKey(process.env.RESEND_API_KEY)) {
        throw new Error('Invalid RESEND_API_KEY');
    }

    // Log the provider name and runtime
    logger.info('Sending email', { provider: 'resend', runtime: 'railway' });

    // Send email logic here...
    // Handle errors and return meaningful messages
}

module.exports = { sendEmail };
