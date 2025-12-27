import { calculateConfidence } from './extract/common.js'

/**
 * Document type definitions with keyword weights
 */
const DOCUMENT_TYPES = {
  drivers_license: {
    keywords: {
      'driver': 3,
      'license': 3,
      'licence': 3,
      'dl': 2,
      'dob': 2,
      'date of birth': 2,
      'exp': 2,
      'expires': 2,
      'iss': 1,
      'issued': 1,
      'class': 1,
      'restrictions': 1,
      'endorsements': 1,
    },
    minConfidence: 0.4,
  },
  scholarship_letter: {
    keywords: {
      'scholarship': 4,
      'award': 3,
      'recipient': 3,
      'congratulations': 2,
      'pleased to inform': 2,
      'grant': 2,
      'financial aid': 2,
      'tuition': 2,
      'academic': 1,
      'university': 1,
      'college': 1,
      'foundation': 1,
    },
    minConfidence: 0.3,
  },
}

/**
 * Classify document type based on text content
 */
export function classifyDocument(text) {
  const normalizedText = text.toLowerCase()
  const scores = {}
  
  // Calculate confidence scores for each document type
  for (const [docType, config] of Object.entries(DOCUMENT_TYPES)) {
    const confidence = calculateConfidence(text, config.keywords)
    
    if (confidence >= config.minConfidence) {
      scores[docType] = confidence
    }
  }
  
  // Find the highest scoring type
  let bestType = 'unknown'
  let bestScore = 0
  
  for (const [docType, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestType = docType
      bestScore = score
    }
  }
  
  return {
    type: bestType,
    confidence: bestScore,
    scores,
  }
}

export default classifyDocument
