/**
 * Utility functions for GrantCard component
 */

import { format, isPast } from 'date-fns';

/**
 * Get match score badge configuration
 * @param {number} score - Match score (0-100)
 * @returns {Object} Badge config with label, colors, and tooltip
 */
export function getMatchScoreBadge(score) {
  if (!score || score === 0) {
    return null;
  }

  if (score >= 80) {
    return {
      label: `${Math.round(score)}% Match`,
      tooltip: 'Excellent Match - Highly recommended',
      bgColor: 'bg-emerald-500',
      textColor: 'text-white',
      borderColor: 'border-emerald-600',
    };
  }
  
  if (score >= 65) {
    return {
      label: `${Math.round(score)}% Match`,
      tooltip: 'Good Match - Worth pursuing',
      bgColor: 'bg-green-500',
      textColor: 'text-white',
      borderColor: 'border-green-600',
    };
  }
  
  if (score >= 50) {
    return {
      label: `${Math.round(score)}% Match`,
      tooltip: 'Fair Match - Review carefully',
      bgColor: 'bg-blue-500',
      textColor: 'text-white',
      borderColor: 'border-blue-600',
    };
  }
  
  if (score >= 35) {
    return {
      label: `${Math.round(score)}% Match`,
      tooltip: 'Potential Match - Requires consideration',
      bgColor: 'bg-amber-500',
      textColor: 'text-white',
      borderColor: 'border-amber-600',
    };
  }
  
  return {
    label: `${Math.round(score)}% Match`,
    tooltip: 'Low Match - May not be suitable',
    bgColor: 'bg-slate-400',
    textColor: 'text-white',
    borderColor: 'border-slate-500',
  };
}

/**
 * Format and validate grant deadline
 * @param {string|Date} deadline - Deadline value
 * @returns {Object} Formatted deadline info
 */
export function formatGrantDeadline(deadline) {
  if (!deadline) {
    return { text: null, isRolling: false, isExpired: false, date: null };
  }

  // Check for rolling deadline
  const deadlineStr = typeof deadline === 'string' ? deadline : '';
  if (deadlineStr.toLowerCase() === 'rolling') {
    return {
      text: 'Rolling',
      isRolling: true,
      isExpired: false,
      date: null,
    };
  }

  // Try to parse as date
  const deadlineDate = deadline instanceof Date ? deadline : new Date(deadline);
  
  if (isNaN(deadlineDate.getTime())) {
    return { text: null, isRolling: false, isExpired: false, date: null };
  }

  const isExpired = isPast(deadlineDate);
  
  return {
    text: format(deadlineDate, 'MMM d, yyyy'),
    isRolling: false,
    isExpired,
    date: deadlineDate,
  };
}

/**
 * Truncate text with word boundary awareness
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
export function truncateText(text, maxLength = 180) {
  if (!text || text.length <= maxLength) return text;
  
  // Find last space before maxLength
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > 0) {
    return truncated.slice(0, lastSpace) + '…';
  }
  
  return truncated + '…';
}

/**
 * Format award amount
 * @param {number} amount - Award amount
 * @returns {string|null} Formatted amount or null
 */
export function formatAwardAmount(amount) {
  if (typeof amount !== 'number' || isNaN(amount) || amount === 0) {
    return null;
  }
  
  return `$${amount.toLocaleString()}`;
}