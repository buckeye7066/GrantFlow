/**
 * Utility functions for match scoring visualization
 */

/**
 * Get match tier information based on score
 * @param {number} score - Match score (0-100)
 * @returns {object} - { label, colorClass, bgClass, borderClass }
 */
export function getMatchTier(score) {
  if (score >= 80) {
    return {
      label: 'Excellent Match',
      colorClass: 'text-emerald-600',
      bgClass: 'bg-emerald-50',
      borderClass: 'border-emerald-200',
    };
  }
  
  if (score >= 60) {
    return {
      label: 'Good Match',
      colorClass: 'text-blue-600',
      bgClass: 'bg-blue-50',
      borderClass: 'border-blue-200',
    };
  }
  
  if (score >= 40) {
    return {
      label: 'Fair Match',
      colorClass: 'text-amber-600',
      bgClass: 'bg-amber-50',
      borderClass: 'border-amber-200',
    };
  }
  
  return {
    label: 'Low Match',
    colorClass: 'text-slate-600',
    bgClass: 'bg-slate-50',
    borderClass: 'border-slate-200',
  };
}