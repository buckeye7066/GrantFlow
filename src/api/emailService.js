/**
 * Email Service
 * Handles sending profile update notifications to users
 */

class EmailService {
    constructor(apiBaseUrl) {
          this.apiBaseUrl = apiBaseUrl || (typeof window !== 'undefined' ? '/api' : 'http://localhost:3000/api');
          this.maxRetries = 3;
          this.retryDelay = 1000;
    }

  escapeHtml(value) {
          return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
    }

  /**
     * Send profile update notification emails
     * @param {Object} params - Email parameters
     * @param {string} params.profileId - Profile ID
     * @param {Array} params.recipients - Array of recipient email addresses
     * @param {string} params.updateType - Type of update (PROFILE_UPDATED, STATUS_CHANGED, etc)
     * @param {Object} params.updateDetails - Details about the update
     * @returns {Promise<Object>} Result with success status
     */
  async sendProfileUpdateNotification(params) {
        if (!params) {
              return { success: false, error: 'Missing parameters' };
        }
        const { profileId, recipients, updateType, updateDetails } = params;

      if (!recipients || recipients.length === 0) {
              return { success: false, error: 'No recipients provided' };
      }

      const emailPayload = this.buildEmailPayload(profileId, recipients, updateType, updateDetails);

      try {
              const response = await this.sendEmailWithRetry(emailPayload);
              return { success: true, response, timestamp: new Date().toISOString() };
      } catch (error) {
              console.error('Failed to send profile update notification:', error);
              return { success: false, error: error.message, timestamp: new Date().toISOString() };
      }
  }

  /**
     * Build email payload for sending
     * @private
     */
  buildEmailPayload(profileId, recipients, updateType, updateDetails) {
        const emailTemplate = this.getEmailTemplate(updateType, updateDetails);

      return {
              to: recipients,
              subject: emailTemplate.subject,
              html: emailTemplate.html,
              text: emailTemplate.text,
              profileId: profileId,
              updateType: updateType,
              timestamp: new Date().toISOString()
      };
  }

  /**
     * Get email template based on update type
     * @private
     */
  getEmailTemplate(updateType, updateDetails) {
        const templates = {
                PROFILE_UPDATED: {
                          subject: 'Profile Update Completed',
                          html: `<h2>Profile Update Completed</h2><p>Your profile has been updated with new information:</p><pre>${this.escapeHtml(JSON.stringify(updateDetails, null, 2))}</pre>`,
                          text: 'Your profile has been updated with new information.'
                },
                STATUS_CHANGED: {
                          subject: 'Student Status Updated',
                          html: `<h2>Student Status Changed</h2><p>Your student status has been updated to: ${this.escapeHtml(updateDetails.newStatus)}</p>`,
                          text: `Your student status has been updated to: ${updateDetails.newStatus}`
                },
                GRANTS_MATCHED: {
                          subject: 'New Grants Matched for Your Profile',
                          html: `<h2>Grants Matched</h2><p>${updateDetails.count} new grants have been matched to your profile.</p>`,
                          text: `${updateDetails.count} new grants have been matched to your profile.`
                },
                ELIGIBILITY_REVIEW: {
                          subject: 'Eligibility Review Complete',
                          html: `<h2>Eligibility Review Complete</h2><p>Your profile eligibility has been reviewed.</p>`,
                          text: 'Your profile eligibility has been reviewed.'
                }
        };

      return templates[updateType] || {
              subject: 'Profile Notification',
              html: '<p>Your profile has been updated.</p>',
              text: 'Your profile has been updated.'
      };
  }

  /**
     * Send email with retry logic
     * @private
     */
  async sendEmailWithRetry(emailPayload, attempt = 1) {
        try {
                const response = await fetch(`${this.apiBaseUrl}/emails/send`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(emailPayload)
                });

          if (!response.ok) {
                    throw new Error(`Email service error: ${response.status}`);
          }

          return await response.json();
        } catch (error) {
                if (attempt < this.maxRetries) {
                          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
                          return this.sendEmailWithRetry(emailPayload, attempt + 1);
                }
                throw error;
        }
  }

  /**
     * Send batch emails
     * @param {Array} emailList - Array of email objects with recipients and content
     * @returns {Promise<Object>} Batch send result
     */
  async sendBatchEmails(emailList) {
        if (!Array.isArray(emailList)) {
              return { success: false, error: 'emailList must be an array' };
        }
        try {
                const results = await Promise.all(
                          emailList.map(email => this.sendEmailWithRetry(email))
                        );
                return { success: true, results, timestamp: new Date().toISOString() };
        } catch (error) {
                return { success: false, error: error.message, timestamp: new Date().toISOString() };
        }
  }

  /**
     * Get email notification preferences for a profile
     * @param {string} profileId - Profile ID
     * @returns {Promise<Object>} Notification preferences
     */
  async getNotificationPreferences(profileId) {
        try {
                const response = await fetch(`${this.apiBaseUrl}/profiles/${profileId}/notifications`);
                if (!response.ok) throw new Error('Failed to fetch preferences');
                return await response.json();
        } catch (error) {
                console.error('Error fetching notification preferences:', error);
                return { success: false, error: error.message };
        }
  }

  /**
     * Update email notification preferences
     * @param {string} profileId - Profile ID
     * @param {Object} preferences - Notification preferences
     * @returns {Promise<Object>} Update result
     */
  async updateNotificationPreferences(profileId, preferences) {
        try {
                const response = await fetch(`${this.apiBaseUrl}/profiles/${profileId}/notifications`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(preferences)
                });

          if (!response.ok) throw new Error('Failed to update preferences');
                return { success: true, data: await response.json() };
        } catch (error) {
                console.error('Error updating notification preferences:', error);
                return { success: false, error: error.message };
        }
  }
}

const emailService = new EmailService();
export default emailService;
