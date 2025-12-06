/**
 * SCHEMA ALIGNMENT GUARD - Developer-Only Utility
 * 
 * This module performs lightweight schema alignment checks between:
 * - Entity schemas (Organization, ApplicationDraft, SourceDirectory)
 * - Wizard steps (form field usage)
 * - Backend functions (field access patterns)
 * - PrintableApplication.jsx (UI field references)
 * 
 * USAGE (development only):
 *   import { runAlignmentCheck, getBaseline } from '@/components/dev/schemaAlignmentGuard';
 *   const result = runAlignmentCheck();
 *   if (result.warnings.length > 0) console.warn(result.summary);
 * 
 * This is a READ-ONLY utility. It does NOT modify files.
 * It does NOT appear in navigation or UI.
 * It runs only when explicitly called during development.
 * 
 * @version 1.0.0
 * @author GrantFlow System
 */

// ============================================================================
// BASELINE FIELD DEFINITIONS
// These are the authoritative field names and types from the aligned schemas
// ============================================================================

const ORGANIZATION_FIELDS = {
  // Core Identity
  name: 'string',
  applicant_type: 'string',
  email: 'string',
  phone: 'string',
  website: 'string',
  profile_image_url: 'string',
  
  // Address
  address: 'string',
  city: 'string',
  state: 'string',
  zip: 'string',
  
  // Organization IDs
  ein: 'string',
  uei: 'string',
  cage_code: 'string',
  
  // Personal Info (individuals)
  date_of_birth: 'string',
  age: 'integer',
  ssn: 'string',
  green_card_number: 'string',
  
  // Organization Details
  organization_type: 'string',
  annual_budget: 'number',
  staff_count: 'integer',
  mission: 'string',
  
  // Education - CORRECT FIELD NAMES
  grade_levels: 'array',           // NOT student_grade_levels
  education_types: 'array',
  current_college: 'string',
  target_colleges: 'array',
  intended_major: 'string',
  gpa: 'number',
  test_scores: 'object',           // NESTED: {act, sat, gre, gmat, lsat, mcat}
  community_service_hours: 'integer',
  honor_societies: 'array',
  competitions_awards: 'array',
  academic_characteristics: 'array',
  student_qualifiers: 'array',
  student_housing_status: 'string',
  efc_sai_band: 'string',
  
  // Financial
  household_income: 'number',
  household_size: 'integer',
  financial_challenges: 'array',
  government_assistance: 'array',
  
  // Health
  health_conditions: 'array',
  health_condition_details: 'object',
  disabilities: 'array',
  disability_type: 'array',
  medicaid_enrolled: 'boolean',
  medicaid_waiver_program: 'string',
  medicaid_number: 'string',
  
  // Demographics
  immigration_status: 'string',
  race_ethnicity: 'array',
  tribal_affiliation: 'string',
  cultural_heritage: 'array',
  religious_affiliation: 'string',
  lgbtq_plus: 'boolean',
  
  // Military
  military_service: 'object',      // NESTED object with multiple fields
  
  // Occupation
  occupation_work: 'array',
  occupation_details: 'object',
  
  // Focus/Keywords
  focus_areas: 'array',
  keywords: 'array',
  extracurricular_activities: 'array',
  awards_achievements: 'array',
  
  // Narrative
  goals: 'string',
  unique_story: 'string',
  funding_need: 'string',
  challenges_barriers: 'string',
  support_system: 'string',
};

const SOURCE_DIRECTORY_FIELDS = {
  name: 'string',
  source_type: 'string',
  website_url: 'string',
  scholarship_page_url: 'string',
  city: 'string',
  state: 'string',
  zip: 'string',
  service_area: 'array',
  eligibility_tags: 'array',
  focus_areas: 'array',
  typical_award_min: 'number',
  typical_award_max: 'number',
  contact_email: 'string',
  contact_phone: 'string',
  requires_membership: 'boolean',
  application_method: 'string',
  confidence_score: 'number',
  verification_notes: 'string',
  discovered_for_organization_id: 'string',
  opportunities_found: 'number',
  ai_discovered: 'boolean',
  verified: 'boolean',
  discovery_confidence: 'number',
  active: 'boolean',
  last_crawled: 'string',
};

const APPLICATION_DRAFT_FIELDS = {
  grant_id: 'string',
  organization_id: 'string',
  current_step: 'integer',
  form_data: 'object',
  status: 'string',
  completion_percentage: 'integer',
  last_saved_at: 'string',
  completed_at: 'string',
};

// ============================================================================
// DEPRECATED FIELD MAPPINGS
// These field names should NOT be used - use the replacement instead
// ============================================================================

const DEPRECATED_FIELDS = {
  // Education field renames
  'student_grade_levels': { replacement: 'grade_levels', entity: 'Organization' },
  'act_score': { replacement: 'test_scores.act', entity: 'Organization' },
  'sat_score': { replacement: 'test_scores.sat', entity: 'Organization' },
  'gre_score': { replacement: 'test_scores.gre', entity: 'Organization' },
  'gmat_score': { replacement: 'test_scores.gmat', entity: 'Organization' },
  'lsat_score': { replacement: 'test_scores.lsat', entity: 'Organization' },
  'mcat_score': { replacement: 'test_scores.mcat', entity: 'Organization' },
  
  // Old flat test score fields
  'test_score_act': { replacement: 'test_scores.act', entity: 'Organization' },
  'test_score_sat': { replacement: 'test_scores.sat', entity: 'Organization' },
};

// ============================================================================
// WIZARD FORM_DATA EXPECTED FIELDS
// These are the fields that wizard steps save to ApplicationDraft.form_data
// ============================================================================

const WIZARD_FORM_DATA_FIELDS = {
  // BasicInfoStep
  project_title: 'string',
  requested_amount: 'number',
  executive_summary: 'string',
  contact_name: 'string',
  contact_email: 'string',
  project_start_date: 'string',
  project_end_date: 'string',
  
  // ProjectNarrativeStep
  problem_statement: 'string',
  project_goals: 'string',
  methods: 'string',
  outcomes: 'string',
  organizational_capacity: 'string',
  sustainability: 'string',
  evaluation: 'string',
  
  // BudgetStep
  budget_items: 'array',
  budget_narrative: 'string',
  indirect_rate: 'number',
  match_required: 'string',
  match_amount: 'number',
  
  // OrganizationInfoStep
  organization_name: 'string',
  organization_ein: 'string',
  organization_address: 'string',
  organization_city: 'string',
  organization_state: 'string',
  organization_zip: 'string',
  organization_phone: 'string',
  organization_website: 'string',
  organization_mission: 'string',
  organization_history: 'string',
  annual_budget: 'number',
  staff_count: 'integer',
  
  // AttachmentsStep
  attachments: 'array',
};

// ============================================================================
// CRITICAL FUNCTION-TO-FIELD MAPPINGS
// These are fields that backend functions access - must match entity schemas
// ============================================================================

const FUNCTION_FIELD_USAGE = {
  'matchProfileToGrants': [
    'grade_levels',
    'test_scores.act',
    'test_scores.sat',
    'gpa',
    'intended_major',
    'focus_areas',
    'city',
    'state',
  ],
  'searchOpportunities': [
    'grade_levels',
    'focus_areas',
    'city',
    'state',
  ],
  'aiGrantMatcher': [
    'grade_levels',
    'test_scores.act',
    'test_scores.sat',
    'gpa',
    'focus_areas',
  ],
  'discoverLocalSources': [
    'city',
    'state',
    'focus_areas',
    'applicant_type',
  ],
  'generateApplicationResponse': [
    'name',
    'mission',
    'focus_areas',
    'annual_budget',
    'staff_count',
    'target_population',
  ],
};

// ============================================================================
// ALIGNMENT CHECK FUNCTIONS
// ============================================================================

/**
 * Get the baseline field definitions
 */
export function getBaseline() {
  return {
    organization: ORGANIZATION_FIELDS,
    sourceDirectory: SOURCE_DIRECTORY_FIELDS,
    applicationDraft: APPLICATION_DRAFT_FIELDS,
    wizardFormData: WIZARD_FORM_DATA_FIELDS,
    deprecatedFields: DEPRECATED_FIELDS,
    functionFieldUsage: FUNCTION_FIELD_USAGE,
  };
}

/**
 * Check if a field name is deprecated
 */
export function isDeprecated(fieldName) {
  return DEPRECATED_FIELDS[fieldName] || null;
}

/**
 * Check if a field exists in Organization entity
 */
export function organizationHasField(fieldName) {
  // Handle nested paths like test_scores.act
  if (fieldName.includes('.')) {
    const [parent] = fieldName.split('.');
    return ORGANIZATION_FIELDS[parent] === 'object';
  }
  return fieldName in ORGANIZATION_FIELDS;
}

/**
 * Check if a field exists in SourceDirectory entity
 */
export function sourceDirectoryHasField(fieldName) {
  return fieldName in SOURCE_DIRECTORY_FIELDS;
}

/**
 * Validate a set of field accesses against entity schemas
 * @param {string[]} fieldNames - Array of field names to check
 * @param {string} entity - Entity name ('Organization', 'SourceDirectory', 'ApplicationDraft')
 * @returns {object} - { valid: [], invalid: [], deprecated: [] }
 */
export function validateFieldAccesses(fieldNames, entity) {
  const result = { valid: [], invalid: [], deprecated: [] };
  
  const entityFields = {
    'Organization': ORGANIZATION_FIELDS,
    'SourceDirectory': SOURCE_DIRECTORY_FIELDS,
    'ApplicationDraft': APPLICATION_DRAFT_FIELDS,
  }[entity] || {};
  
  for (const fieldName of fieldNames) {
    // Check deprecation first
    const deprecation = DEPRECATED_FIELDS[fieldName];
    if (deprecation && deprecation.entity === entity) {
      result.deprecated.push({
        field: fieldName,
        replacement: deprecation.replacement,
      });
      continue;
    }
    
    // Check if field exists (handle nested paths)
    if (fieldName.includes('.')) {
      const [parent] = fieldName.split('.');
      if (entityFields[parent] === 'object') {
        result.valid.push(fieldName);
      } else {
        result.invalid.push(fieldName);
      }
    } else if (fieldName in entityFields) {
      result.valid.push(fieldName);
    } else {
      result.invalid.push(fieldName);
    }
  }
  
  return result;
}

/**
 * Run a full alignment check and return warnings
 * @returns {object} - { status, warnings, summary }
 */
export function runAlignmentCheck() {
  const warnings = [];
  
  // Check function field usage against Organization entity
  for (const [funcName, fields] of Object.entries(FUNCTION_FIELD_USAGE)) {
    const validation = validateFieldAccesses(fields, 'Organization');
    
    if (validation.invalid.length > 0) {
      warnings.push({
        type: 'MISSING_FIELD',
        location: `functions/${funcName}`,
        fields: validation.invalid,
        message: `Function references fields not in Organization entity: ${validation.invalid.join(', ')}`,
      });
    }
    
    if (validation.deprecated.length > 0) {
      for (const dep of validation.deprecated) {
        warnings.push({
          type: 'DEPRECATED_FIELD',
          location: `functions/${funcName}`,
          field: dep.field,
          replacement: dep.replacement,
          message: `Function uses deprecated field "${dep.field}", should use "${dep.replacement}"`,
        });
      }
    }
  }
  
  // Build summary
  const status = warnings.length === 0 ? 'PASS' : 'WARNINGS';
  const summary = warnings.length === 0
    ? '✅ Schema alignment check passed. All fields aligned.'
    : `⚠️ WARNING: Schema alignment deviation detected.\n` +
      `Found ${warnings.length} issue(s):\n` +
      warnings.map(w => `  - ${w.location}: ${w.message}`).join('\n');
  
  return { status, warnings, summary };
}

/**
 * Quick check for a single field access
 * @param {string} fieldName - Field name to check
 * @param {string} entity - Entity name
 * @returns {object|null} - Warning object or null if valid
 */
export function checkFieldAccess(fieldName, entity = 'Organization') {
  const deprecation = DEPRECATED_FIELDS[fieldName];
  if (deprecation && deprecation.entity === entity) {
    return {
      type: 'DEPRECATED',
      field: fieldName,
      replacement: deprecation.replacement,
      message: `Use "${deprecation.replacement}" instead of "${fieldName}"`,
    };
  }
  
  const entityFields = {
    'Organization': ORGANIZATION_FIELDS,
    'SourceDirectory': SOURCE_DIRECTORY_FIELDS,
    'ApplicationDraft': APPLICATION_DRAFT_FIELDS,
  }[entity] || {};
  
  if (fieldName.includes('.')) {
    const [parent] = fieldName.split('.');
    if (entityFields[parent] !== 'object') {
      return {
        type: 'INVALID',
        field: fieldName,
        message: `Field "${fieldName}" not found in ${entity} entity`,
      };
    }
  } else if (!(fieldName in entityFields)) {
    return {
      type: 'INVALID',
      field: fieldName,
      message: `Field "${fieldName}" not found in ${entity} entity`,
    };
  }
  
  return null; // Valid
}

/**
 * Log alignment status to console (development only)
 */
export function logAlignmentStatus() {
  const result = runAlignmentCheck();
  
  if (result.status === 'PASS') {
    console.log('%c✅ Schema Alignment: PASS', 'color: green; font-weight: bold');
  } else {
    console.warn('%c⚠️ Schema Alignment: WARNINGS', 'color: orange; font-weight: bold');
    console.warn(result.summary);
  }
  
  return result;
}

// Export baseline for external tools
export const BASELINE = {
  ORGANIZATION_FIELDS,
  SOURCE_DIRECTORY_FIELDS,
  APPLICATION_DRAFT_FIELDS,
  WIZARD_FORM_DATA_FIELDS,
  DEPRECATED_FIELDS,
  FUNCTION_FIELD_USAGE,
};

export default {
  getBaseline,
  isDeprecated,
  organizationHasField,
  sourceDirectoryHasField,
  validateFieldAccesses,
  runAlignmentCheck,
  checkFieldAccess,
  logAlignmentStatus,
  BASELINE,
};