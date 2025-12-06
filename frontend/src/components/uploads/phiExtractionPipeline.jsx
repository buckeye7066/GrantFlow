/**
 * PHI Data Extraction Pipeline
 * Multi-pass extraction with pattern matching, normalization, and required field enforcement
 * Pass 1: LLM structured extraction
 * Pass 2: Pattern-based regex fallback
 * Pass 3: Hardcoded heuristics for messy documents
 * Pass 4: Normalization and confidence scoring
 * Pass 5: Required field enforcement
 */

import { base44 } from '@/api/base44Client';

/**
 * Required fields that must be checked for in every document
 * Note: These are "nice to have" - extraction proceeds even if missing
 */
const REQUIRED_FIELDS = [
  'full_name'
  // Other fields are optional - id_number, ssn, etc. are only required if present on document
];

/**
 * Regex patterns for Pass 2 fallback extraction
 */
const PATTERNS = {
  dob: /\b(0?[1-9]|1[0-2])[\/\.\-](0?[1-9]|[12][0-9]|3[01])[\/\.\-](19|20)\d{2}\b/,
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
  phone: /\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}/,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  zip: /\b\d{5}(?:-\d{4})?\b/,
  state: /\b[A-Z]{2}\b/
};

/**
 * LLM extraction schema targeting required PHI fields
 */
const LLM_SCHEMA = {
  type: "object",
  properties: {
    full_name: { type: "string", description: "Full legal name as printed on document" },
    date_of_birth: { type: "string", description: "Date of birth in MM/DD/YYYY format" },
    age: { type: "number", description: "Age in years if visible" },
    address: { type: "string", description: "Complete street address with number and street name" },
    city: { type: "string", description: "City name" },
    state: { type: "string", description: "State abbreviation" },
    zip: { type: "string", description: "ZIP code" },
    phone: { type: "string", description: "Phone number" },
    email: { type: "string", description: "Email address" },
    ssn: { type: "string", description: "Social security number (may be masked)" },
    id_number: { type: "string", description: "Driver license, passport, or state ID number" },
    document_type: { type: "string", description: "Type: drivers_license, passport, state_id, birth_certificate, green_card, medical_form, utility_bill, other" },
    green_card_number: { type: "string" }
  }
};

/**
 * Normalize field names to standard keys
 */
function normalizeFieldName(fieldName) {
  const name = fieldName.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  
  const mappings = {
    'name': 'full_name',
    'first_name': 'full_name',
    'last_name': 'full_name',
    'dob': 'date_of_birth',
    'birth_date': 'date_of_birth',
    'birthdate': 'date_of_birth',
    'social_security': 'ssn',
    'social_security_number': 'ssn',
    'ss_number': 'ssn',
    'street': 'address',
    'street_address': 'address',
    'mailing_address': 'address',
    'zip_code': 'zip',
    'postal_code': 'zip',
    'zipcode': 'zip',
    'phone_number': 'phone',
    'telephone': 'phone',
    'cell': 'phone',
    'mobile': 'phone',
    'email_address': 'email',
    'drivers_license': 'id_number',
    'license_number': 'id_number',
    'dl_number': 'id_number',
    'passport_number': 'id_number',
    'state_id': 'id_number'
  };
  
  return mappings[name] || name;
}

/**
 * Normalize extracted values to standard formats (Pass 4)
 */
function normalizeValue(fieldName, value) {
  if (!value || typeof value !== 'string') return value;
  
  const trimmed = value.trim();
  
  switch (fieldName) {
    case 'date_of_birth':
      // Format as MM/DD/YYYY, handle malformed dates like 10/11/196400
      if (trimmed.length >= 10 && trimmed.includes('/')) {
        return trimmed.slice(0, 10);
      }
      return trimmed;
      
    case 'ssn':
      // Keep only digits and format as XXX-XX-XXXX
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length === 9) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
      }
      return trimmed;
      
    case 'phone':
      // Format as (XXX) XXX-XXXX
      const phoneDigits = trimmed.replace(/\D/g, '');
      if (phoneDigits.length === 10) {
        return `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
      }
      return trimmed;
      
    case 'full_name':
      // Capitalize each word
      return trimmed.split(/\s+/).map(w => 
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      ).join(' ');
      
    case 'state':
      // Uppercase state codes
      return trimmed.toUpperCase();
      
    case 'address':
    case 'city':
      // Remove duplicate whitespace
      return trimmed.replace(/\s+/g, ' ');
      
    default:
      return trimmed;
  }
}

/**
 * Pass 2: Pattern-based regex extraction from raw text
 */
function extractWithPatterns(rawText) {
  const fields = {};
  
  if (!rawText) return fields;
  
  // DOB
  const dobMatch = rawText.match(PATTERNS.dob);
  if (dobMatch) {
    fields.date_of_birth = { value: dobMatch[0], confidence: 0.70 };
  }
  
  // SSN
  const ssnMatch = rawText.match(PATTERNS.ssn);
  if (ssnMatch) {
    fields.ssn = { value: ssnMatch[0], confidence: 0.65 };
  }
  
  // Phone
  const phoneMatch = rawText.match(PATTERNS.phone);
  if (phoneMatch) {
    fields.phone = { value: phoneMatch[0], confidence: 0.70 };
  }
  
  // Email
  const emailMatch = rawText.match(PATTERNS.email);
  if (emailMatch) {
    fields.email = { value: emailMatch[0], confidence: 0.75 };
  }
  
  // ZIP
  const zipMatch = rawText.match(PATTERNS.zip);
  if (zipMatch) {
    fields.zip = { value: zipMatch[0], confidence: 0.70 };
  }
  
  return fields;
}

/**
 * Pass 3: Hardcoded heuristics for messy documents
 */
function extractWithHeuristics(rawText, existingFields) {
  if (!rawText) return {};
  
  const fields = { ...existingFields };
  
  // Look for "Name:" or "Printed Name:" labels
  if (!fields.full_name) {
    const nameMatch = rawText.match(/(?:name|printed\s+name|full\s+name)\s*:?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
    if (nameMatch && nameMatch[1]) {
      fields.full_name = { value: nameMatch[1].trim(), confidence: 0.65 };
    }
  }
  
  // Infer document type from keywords
  if (!fields.document_type) {
    const text = rawText.toLowerCase();
    if (text.includes('driver') || text.includes('license')) {
      fields.document_type = { value: 'drivers_license', confidence: 0.80 };
    } else if (text.includes('passport')) {
      fields.document_type = { value: 'passport', confidence: 0.85 };
    } else if (text.includes('birth certificate')) {
      fields.document_type = { value: 'birth_certificate', confidence: 0.85 };
    } else if (text.includes('green card') || text.includes('permanent resident')) {
      fields.document_type = { value: 'green_card', confidence: 0.80 };
    } else if (text.includes('state') && text.includes('id')) {
      fields.document_type = { value: 'state_id', confidence: 0.75 };
    }
  }
  
  // Extract address heuristically (multi-line pattern)
  if (!fields.address) {
    const addressMatch = rawText.match(/(\d+\s+[A-Za-z\s]+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way|court|ct)\.?)/i);
    if (addressMatch && addressMatch[1]) {
      fields.address = { value: addressMatch[1].trim(), confidence: 0.60 };
    }
  }
  
  return fields;
}

/**
 * Pass 4: Normalize and score all fields
 */
function normalizeAndScore(fields) {
  const normalized = {};
  
  Object.entries(fields).forEach(([key, data]) => {
    const normalizedKey = normalizeFieldName(key);
    const rawValue = typeof data === 'object' ? data.value : data;
    const confidence = typeof data === 'object' ? (data.confidence || 0.7) : 0.7;
    
    // Skip invalid values
    if (!rawValue) return;
    if (rawValue === 'null' || rawValue === 'NULL') return;
    if (typeof rawValue === 'string' && rawValue.trim() === '') return;
    if (typeof rawValue === 'string' && rawValue.toLowerCase() === 'n/a') return;
    if (typeof rawValue === 'string' && rawValue.toLowerCase() === 'unknown') return;
    
    // Normalize value
    const normalizedValue = normalizeValue(normalizedKey, rawValue);
    
    // Keep field with highest confidence if duplicate
    if (normalized[normalizedKey]) {
      if (confidence > normalized[normalizedKey].confidence) {
        normalized[normalizedKey] = { 
          value: normalizedValue, 
          confidence,
          userCorrected: false
        };
      }
    } else {
      normalized[normalizedKey] = { 
        value: normalizedValue, 
        confidence,
        userCorrected: false
      };
    }
  });
  
  return normalized;
}

/**
 * Pass 5: Check for missing required fields
 */
function checkRequiredFields(fields) {
  const missing = [];
  
  REQUIRED_FIELDS.forEach(fieldName => {
    if (!fields[fieldName] || !fields[fieldName].value) {
      missing.push(fieldName);
    }
  });
  
  return missing;
}

/**
 * Pass 1: LLM structured extraction
 */
async function extractWithLLM(fileUrl) {
  try {
    const response = await base44.integrations.Core.ExtractDataFromUploadedFile({
      file_url: fileUrl,
      json_schema: LLM_SCHEMA
    });
    
    if (response?.status === 'success' && response?.output) {
      const fields = {};
      
      Object.entries(response.output).forEach(([key, value]) => {
        if (value && value !== 'null' && value !== '') {
          const normalizedKey = normalizeFieldName(key);
          fields[normalizedKey] = {
            value: String(value),
            confidence: 0.85
          };
        }
      });
      
      if (Object.keys(fields).length > 0) {
        console.log('[PHI Pipeline] Pass 1 (LLM) extracted', Object.keys(fields).length, 'fields');
        return fields;
      }
    }
  } catch (error) {
    console.warn('[PHI Pipeline] Pass 1 (LLM) failed');
  }
  
  return {};
}

/**
 * Get raw text from document using LLM
 */
async function getRawText(fileUrl) {
  try {
    const response = await base44.integrations.Core.InvokeLLM({
      prompt: "Extract ALL text from this document exactly as it appears. Include every word, number, and line. Do not interpret or structure the data, just return the raw text.",
      file_urls: [fileUrl]
    });
    
    if (response && typeof response === 'string') {
      return response;
    }
  } catch (error) {
    console.warn('[PHI Pipeline] Raw text extraction failed');
  }
  
  return '';
}

/**
 * Main extraction pipeline
 * @param {string} fileUrl - URL of uploaded file
 * @param {string} fileType - MIME type of file
 * @param {string} preExtractedText - Optional pre-extracted OCR text (from hybrid OCR)
 * @returns {Promise<{success: boolean, fields: object, method: string, missing: array}>}
 */
export async function extractPHIData(fileUrl, fileType, preExtractedText = null) {
  console.log('[PHI Pipeline] Starting multi-pass extraction');
  
  // Pass 1: LLM structured extraction
  let fields = await extractWithLLM(fileUrl);
  
  // Pass 2: Pattern-based fallback (if LLM missed fields)
  // Use pre-extracted OCR text if available, otherwise fetch raw text
  let rawText = preExtractedText || '';
  if (Object.keys(fields).length < 5) {
    console.log('[PHI Pipeline] Pass 1 incomplete, running Pass 2 (Patterns)');
    if (!rawText) {
      rawText = await getRawText(fileUrl);
    }
    const patternFields = extractWithPatterns(rawText);
    
    // Merge pattern fields (don't overwrite existing)
    Object.entries(patternFields).forEach(([key, data]) => {
      if (!fields[key]) {
        fields[key] = data;
      }
    });
  }
  
  // Pass 3: Heuristics for messy documents
  if (rawText && Object.keys(fields).length < 5) {
    console.log('[PHI Pipeline] Running Pass 3 (Heuristics)');
    fields = extractWithHeuristics(rawText, fields);
  }
  
  // Pass 4: Normalize all fields and score
  const normalizedFields = normalizeAndScore(fields);
  
  // Pass 5: Check for missing required fields
  const missing = checkRequiredFields(normalizedFields);
  
  console.log('[PHI Pipeline] Extraction complete:', {
    extracted: Object.keys(normalizedFields).length,
    missing: missing.length
  });
  
  return {
    success: Object.keys(normalizedFields).length > 0,
    fields: normalizedFields,
    method: Object.keys(normalizedFields).length >= 5 ? 'llm' : 'hybrid',
    missing
  };
}