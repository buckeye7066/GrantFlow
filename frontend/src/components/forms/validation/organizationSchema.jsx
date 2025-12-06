/**
 * Validation schema for organization profiles
 * Can be used with Zod or custom validation
 * 
 * This provides a centralized place to define validation rules
 * that can be enforced on both frontend and backend
 */

export const REQUIRED_FIELDS = {
  all: ['name'],
  organization: ['name', 'website'],
  high_school_student: ['name', 'student_grade_levels'],
  college_student: ['name', 'student_grade_levels'],
  graduate_student: ['name', 'student_grade_levels'],
  individual_need: ['name'],
  medical_assistance: ['name'],
  family: ['name'],
  other: ['name'],
};

export const FIELD_CONSTRAINTS = {
  gpa: { min: 0, max: 4.0 },
  act_score: { min: 1, max: 36 },
  sat_score: { min: 400, max: 1600 },
  age: { min: 0, max: 150 },
  household_size: { min: 1, max: 20 },
  cancer_diagnosis_year: { min: 1900, max: new Date().getFullYear() },
  indirect_rate: { min: 0, max: 100 },
};

/**
 * Get required fields for a specific applicant type
 */
export function getRequiredFields(applicantType) {
  return REQUIRED_FIELDS[applicantType] || REQUIRED_FIELDS.all;
}

/**
 * Validate a field value
 */
export function validateField(fieldName, value, applicantType) {
  const errors = [];

  // Required field validation
  const required = getRequiredFields(applicantType);
  if (required.includes(fieldName) && (!value || value === '')) {
    errors.push(`${fieldName.replace(/_/g, ' ')} is required`);
  }

  // Constraint validation
  if (FIELD_CONSTRAINTS[fieldName] && value !== null && value !== '') {
    const constraints = FIELD_CONSTRAINTS[fieldName];
    const numValue = parseFloat(value);
    
    if (constraints.min !== undefined && numValue < constraints.min) {
      errors.push(`${fieldName.replace(/_/g, ' ')} must be at least ${constraints.min}`);
    }
    if (constraints.max !== undefined && numValue > constraints.max) {
      errors.push(`${fieldName.replace(/_/g, ' ')} must be at most ${constraints.max}`);
    }
  }

  // Email validation
  if (fieldName === 'email' && Array.isArray(value)) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    value.forEach(email => {
      if (email && !emailRegex.test(email)) {
        errors.push(`"${email}" is not a valid email address`);
      }
    });
  }

  // Website validation for organizations
  if (fieldName === 'website' && value && applicantType === 'organization') {
    try {
      new URL(value);
    } catch {
      errors.push('Please enter a valid website URL');
    }
  }

  return errors;
}

/**
 * Validate entire form
 */
export function validateForm(formData) {
  const errors = {};
  const requiredFields = getRequiredFields(formData.applicant_type);

  requiredFields.forEach(field => {
    const fieldErrors = validateField(field, formData[field], formData.applicant_type);
    if (fieldErrors.length > 0) {
      errors[field] = fieldErrors;
    }
  });

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}