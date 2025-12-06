import { Building2, GraduationCap, Heart } from 'lucide-react';

/**
 * Color schemes for different profile types
 * All classes are statically defined so Tailwind JIT can detect them
 */
export const COLOR_SCHEMES = {
  blue: {
    gradient: 'from-blue-500 to-blue-600',
    border: 'border-blue-500',
    bg: 'bg-blue-50',
    bgHover: 'bg-blue-100',
    icon: 'text-blue-600',
  },
  indigo: {
    gradient: 'from-indigo-500 to-indigo-600',
    border: 'border-indigo-500',
    bg: 'bg-indigo-50',
    bgHover: 'bg-indigo-100',
    icon: 'text-indigo-600',
  },
  rose: {
    gradient: 'from-rose-500 to-rose-600',
    border: 'border-rose-500',
    bg: 'bg-rose-50',
    bgHover: 'bg-rose-100',
    icon: 'text-rose-600',
  },
};

/**
 * Get profile type metadata (color scheme, icon, labels)
 * 
 * @param {string} applicantType - The applicant_type value
 * @returns {{ colorScheme: object, icon: Component, label: string, category: string }}
 */
export function getProfileTypeMeta(applicantType) {
  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(applicantType);
  const isIndividual = ['individual_need', 'medical_assistance', 'family'].includes(applicantType);
  
  if (isStudent) {
    return {
      colorScheme: COLOR_SCHEMES.indigo,
      icon: GraduationCap,
      label: 'Student',
      category: 'student',
      opportunityLabel: 'Scholarships',
    };
  }
  
  if (isIndividual) {
    return {
      colorScheme: COLOR_SCHEMES.rose,
      icon: Heart,
      label: 'Individual',
      category: 'individual',
      opportunityLabel: 'Programs',
    };
  }
  
  return {
    colorScheme: COLOR_SCHEMES.blue,
    icon: Building2,
    label: 'Organization',
    category: 'organization',
    opportunityLabel: 'Grants',
  };
}

/**
 * Format grade level for display
 * 
 * @param {string} gradeLevel - Raw grade level value
 * @returns {string} Formatted label
 */
export function formatGradeLevel(gradeLevel) {
  return gradeLevel
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Get assistance category labels from taxonomy
 * 
 * @param {Array} categories - Array of assistance category slugs
 * @param {Array} taxonomyItems - Taxonomy items to map from
 * @param {number} limit - Maximum number of labels to return
 * @returns {Array} Array of formatted labels
 */
export function getAssistanceCategoryLabels(categories, taxonomyItems, limit = 2) {
  if (!categories || !Array.isArray(categories)) return [];
  
  return categories
    .slice(0, limit)
    .map(slug => {
      const item = taxonomyItems.find(t => 
        t.group === 'individual_assistance' && t.slug === slug
      );
      return item ? item.label : slug;
    });
}