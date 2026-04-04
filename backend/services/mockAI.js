/**
 * Mock AI Service
 * DEPRECATED: Only for development/testing when OpenAI is not available
 * Production code should NEVER use these mock responses
 * 
 * @deprecated Use real AI service instead
 */

function assertNotProduction() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MOCK_AI !== 'true') {
    throw new Error('mockAI must not be used in production — set ALLOW_MOCK_AI=true to override');
  }
}

export function getMockFieldSuggestion(fieldName, fieldLabel) {
  assertNotProduction();
  console.warn('[MOCK AI] Using mock suggestion for:', fieldName, '— NOT grounded in real profile data. For development/test only.');
  
  // Return clearly-labelled placeholder text so callers and testers can
  // identify mock data at a glance. Never return fake statistics or
  // fabricated history that could be mistaken for real profile data.
  return `[MOCK] Placeholder for "${fieldLabel}" (field: ${fieldName}). Replace with real AI response in production.`;
}

export function getMockSectionSuggestion(sectionKey) {
  assertNotProduction();
  console.warn('[MOCK AI] Using mock section suggestion for:', sectionKey, '— NOT grounded in real profile data. For development/test only.');
  
  // Return an empty object so callers receive a safe, schema-compatible
  // response without injecting fabricated demographics into the profile
  // or match pipeline. Callers must handle empty-object gracefully.
  return {};
}

export default { getMockFieldSuggestion, getMockSectionSuggestion }
