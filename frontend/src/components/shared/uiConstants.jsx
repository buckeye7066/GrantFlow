/**
 * Shared UI constants for consistent styling across components
 */

// Status enums for grants
export const GRANT_STATUS = {
  DISCOVERED: 'discovered',
  INTERESTED: 'interested',
  DRAFTING: 'drafting',
  APPLICATION_PREP: 'application_prep',
  REVISION: 'revision',
  PORTAL: 'portal',
  SUBMITTED: 'submitted',
  AWARDED: 'awarded',
  DECLINED: 'declined',
  CLOSED: 'closed',
};

// AI processing status
export const AI_STATUS = {
  IDLE: 'idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  ERROR: 'error',
  RATE_LIMITED: 'rate_limited',
};

// Document types
export const DOCUMENT_TYPE = {
  NOFO: 'nofo',
  PROPOSAL: 'proposal',
  BUDGET: 'budget',
  LETTER_OF_SUPPORT: 'letter_of_support',
  MOU: 'mou',
  RESUME: 'resume',
  IRS_DETERMINATION: 'irs_determination',
  FINANCIAL_STATEMENT: 'financial_statement',
  AUDIT: 'audit',
  OTHER: 'other',
};

// Source types
export const SOURCE_TYPE = {
  FOUNDATION: 'foundation',
  COMMUNITY_FOUNDATION: 'community_foundation',
  ROTARY: 'rotary',
  LIONS: 'lions',
  KIWANIS: 'kiwanis',
  GOVERNMENT: 'government',
  CORPORATE: 'corporate',
  OTHER: 'other',
};

// Invoice status
export const INVOICE_STATUS = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  OVERDUE: 'Overdue',
  PARTIALLY_PAID: 'PartiallyPaid',
  PAID: 'Paid',
  VOID: 'Void',
};

// Applicant types
export const APPLICANT_TYPE = {
  ORGANIZATION: 'organization',
  HIGH_SCHOOL_STUDENT: 'high_school_student',
  COLLEGE_STUDENT: 'college_student',
  GRADUATE_STUDENT: 'graduate_student',
  INDIVIDUAL_NEED: 'individual_need',
  MEDICAL_ASSISTANCE: 'medical_assistance',
  FAMILY: 'family',
  HOMESCHOOL_FAMILY: 'homeschool_family',
  OTHER: 'other',
};

// Color classes for consistent UI feedback
export const STATUS_COLORS = {
  // Success states
  success: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    text: 'text-emerald-700',
    icon: 'text-emerald-600',
    badge: 'bg-emerald-100 text-emerald-800',
  },
  // Warning states
  warning: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    text: 'text-amber-700',
    icon: 'text-amber-600',
    badge: 'bg-amber-100 text-amber-800',
  },
  // Error states
  error: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    text: 'text-red-700',
    icon: 'text-red-600',
    badge: 'bg-red-100 text-red-800',
  },
  // Info states
  info: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    text: 'text-blue-700',
    icon: 'text-blue-600',
    badge: 'bg-blue-100 text-blue-800',
  },
  // Neutral states
  neutral: {
    bg: 'bg-slate-50',
    border: 'border-slate-200',
    text: 'text-slate-700',
    icon: 'text-slate-500',
    badge: 'bg-slate-100 text-slate-800',
  },
  // Purple (AI/special)
  ai: {
    bg: 'bg-purple-50',
    border: 'border-purple-200',
    text: 'text-purple-700',
    icon: 'text-purple-600',
    badge: 'bg-purple-100 text-purple-800',
  },
};

// Grant status to color mapping
export const GRANT_STATUS_COLORS = {
  [GRANT_STATUS.DISCOVERED]: STATUS_COLORS.info,
  [GRANT_STATUS.INTERESTED]: STATUS_COLORS.ai,
  [GRANT_STATUS.DRAFTING]: STATUS_COLORS.warning,
  [GRANT_STATUS.APPLICATION_PREP]: STATUS_COLORS.warning,
  [GRANT_STATUS.REVISION]: STATUS_COLORS.warning,
  [GRANT_STATUS.PORTAL]: STATUS_COLORS.info,
  [GRANT_STATUS.SUBMITTED]: STATUS_COLORS.success,
  [GRANT_STATUS.AWARDED]: STATUS_COLORS.success,
  [GRANT_STATUS.DECLINED]: STATUS_COLORS.error,
  [GRANT_STATUS.CLOSED]: STATUS_COLORS.neutral,
};

// External link attributes for security
export const EXTERNAL_LINK_ATTRS = {
  target: '_blank',
  rel: 'noopener noreferrer',
};

/**
 * Safe external link opener with try/catch
 * @param {string} url - URL to open
 */
export const safeOpenExternalLink = (url) => {
  if (!url || typeof url !== 'string') {
    console.warn('[safeOpenExternalLink] Invalid URL:', url);
    return;
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('[safeOpenExternalLink] Failed to open:', err?.message);
  }
};

/**
 * Get status color classes by status type
 * @param {'success' | 'warning' | 'error' | 'info' | 'neutral' | 'ai'} type
 * @returns {object} Color classes
 */
export const getStatusColors = (type) => {
  return STATUS_COLORS[type] || STATUS_COLORS.neutral;
};

/**
 * Get grant-specific color classes
 * @param {string} status - Grant status
 * @returns {object} Color classes
 */
export const getGrantStatusColors = (status) => {
  return GRANT_STATUS_COLORS[status] || STATUS_COLORS.neutral;
};