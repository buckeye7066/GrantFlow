import { format } from 'date-fns';

/**
 * Build comprehensive profile summary for email generation
 * 
 * @param {Object} organization - Organization data
 * @param {Array} contactMethods - Contact methods
 * @returns {string} Formatted profile summary
 */
export function buildProfileSummary(organization, contactMethods = []) {
  if (!organization) return 'No profile information available.';

  const parts = [];

  parts.push(`Organization Name: ${organization.name}`);

  if (organization.applicant_type) {
    parts.push(`Type: ${organization.applicant_type.replace(/_/g, ' ')}`);
  }

  if (organization.ein) parts.push(`EIN: ${organization.ein}`);
  if (organization.uei) parts.push(`UEI: ${organization.uei}`);

  // Address
  if (organization.address || organization.city || organization.state) {
    const addressParts = [];
    if (organization.address) addressParts.push(organization.address);
    const cityState = [organization.city, organization.state, organization.zip]
      .filter(Boolean)
      .join(' ');
    if (cityState) addressParts.push(cityState);
    parts.push(`Address: ${addressParts.join(', ')}`);
  }

  // Contact methods
  const emails = contactMethods.filter(c => c.type === 'email').map(c => c.value);
  const phones = contactMethods.filter(c => c.type === 'phone').map(c => c.value);
  
  if (emails.length > 0) parts.push(`Email: ${emails.join(', ')}`);
  if (phones.length > 0) parts.push(`Phone: ${phones.join(', ')}`);
  if (organization.website) parts.push(`Website: ${organization.website}`);

  // Additional info
  if (organization.mission) parts.push(`\nMission: ${organization.mission}`);
  if (organization.annual_budget) {
    parts.push(`Annual Budget: $${organization.annual_budget.toLocaleString()}`);
  }
  if (organization.staff_count) parts.push(`Staff Count: ${organization.staff_count}`);

  return parts.join('\n');
}

/**
 * Build pipeline summary for email generation
 * 
 * @param {Array} grants - Array of grants
 * @returns {string} Formatted pipeline summary
 */
export function buildPipelineSummary(grants = []) {
  if (!grants || grants.length === 0) {
    return 'No grants currently in the pipeline.';
  }

  const STATUS_LABELS = {
    discovered: 'Recently Discovered',
    interested: 'Under Assessment',
    drafting: 'Application in Progress',
    application_prep: 'Ready for Submission',
    portal: 'Portal Entry in Progress',
    submitted: 'Submitted - Awaiting Decision',
    pending_review: 'Under Review',
    follow_up: 'Follow-Up Required',
    awarded: '✅ AWARDED',
    declined: 'Declined',
    closed: 'Closed',
    report: 'Reporting Phase'
  };

  return grants.map(grant => {
    const parts = [];
    
    parts.push(`• ${grant.title}`);
    parts.push(`  Funder: ${grant.funder}`);
    parts.push(`  Status: ${STATUS_LABELS[grant.status] || grant.status}`);

    // Handle deadline formatting safely
    if (grant.deadline) {
      if (typeof grant.deadline === 'string' && grant.deadline.toLowerCase() === 'rolling') {
        parts.push('  Deadline: Rolling');
      } else {
        const deadlineDate = new Date(grant.deadline);
        if (!isNaN(deadlineDate.getTime())) {
          parts.push(`  Deadline: ${format(deadlineDate, 'MMM d, yyyy')}`);
        }
      }
    }

    if (grant.award_ceiling) {
      parts.push(`  Award Amount: Up to $${grant.award_ceiling.toLocaleString()}`);
    }

    return parts.join('\n');
  }).join('\n\n');
}

/**
 * Generate LLM prompt for pipeline update email
 * 
 * @param {string} organizationName - Organization name
 * @param {string} profileSummary - Profile information summary
 * @param {string} pipelineSummary - Pipeline status summary
 * @returns {string} Complete prompt for LLM
 */
export function generatePipelineEmailPrompt(organizationName, profileSummary, pipelineSummary) {
  return `You are Dr. John White, a professional grant consultant. Write a warm, professional email to ${organizationName} providing a status update on their grant-seeking efforts.

**CONTEXT:**

**PROFILE INFORMATION ON FILE**
${profileSummary}

**CURRENT GRANT PIPELINE:**

${pipelineSummary}

**EMAIL REQUIREMENTS:**
- Start with a friendly greeting
- Provide a brief summary of their current pipeline activity (1-2 sentences)
- List each grant opportunity with its current status
- Reference the profile information you have on file
- Ask them to review everything and reply with any updates, corrections, or additions
- Emphasize that keeping information current helps find the best opportunities
- Keep the tone encouraging and supportive
- Sign as "Dr. John White, Grant Consultant"
- Keep under 300 words
- Format as plain text (no HTML, no markdown)

Write the complete email body:`;
}

/**
 * Validate email address format
 * 
 * @param {string} email - Email to validate
 * @returns {boolean} Whether email is valid
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}