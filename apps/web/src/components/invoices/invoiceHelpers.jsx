/**
 * Generate invoice number in format INV-YYYYMM-XXX
 * @param {number} lastNumber - The last invoice number used
 * @returns {string} - Formatted invoice number
 */
export function generateInvoiceNumber(lastNumber) {
  const nextNumber = (lastNumber || 0) + 1;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const sequence = String(nextNumber).padStart(3, '0');
  return `INV-${year}${month}-${sequence}`;
}

/**
 * Validate invoice form data before submission
 * @param {Object} formData - Invoice form data
 * @param {Object} pricingInfo - Calculated pricing information
 * @returns {Object} - { isValid: boolean, error: string }
 */
export function validateInvoice(formData, pricingInfo) {
  if (!formData.organization_id) {
    return {
      isValid: false,
      error: 'Please select a client organization.'
    };
  }

  if (!formData.service_type) {
    return {
      isValid: false,
      error: 'Please select a service type.'
    };
  }

  if (!pricingInfo) {
    return {
      isValid: false,
      error: 'Unable to calculate pricing. Please check your selections.'
    };
  }

  return { isValid: true, error: null };
}

/**
 * Calculate due date based on payment terms
 * @param {string} issueDate - Issue date in YYYY-MM-DD format
 * @param {string} paymentTerms - Payment terms enum value
 * @returns {string} - Due date in YYYY-MM-DD format
 */
export function calculateDueDate(issueDate, paymentTerms) {
  const dueDate = new Date(issueDate);
  const termsDays = 
    paymentTerms === 'net_15' ? 15 :
    paymentTerms === 'net_30' ? 30 :
    paymentTerms === 'net_45' ? 45 : 0;
  
  dueDate.setDate(dueDate.getDate() + termsDays);
  return dueDate.toISOString().split('T')[0];
}

/**
 * Get milestone description for contract terms
 * @param {string} milestoneType - Milestone type enum value
 * @returns {string} - Milestone description
 */
export function getMilestoneDescription(milestoneType) {
  const descriptions = {
    kickoff: '40% due at project kickoff (scope locked; calendar set)',
    draft_delivery: '40% due at complete draft delivery',
    final_submission: '20% due at submission and handoff package delivery',
    full_payment: 'Full payment due',
  };
  return descriptions[milestoneType] || 'Payment due';
}