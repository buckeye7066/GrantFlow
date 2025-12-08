import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';
import { createSafeServer } from './_shared/safeHandler.js';
import { createLogger } from './_shared/logger.js';

const ErrorCodes = {
  MISSING_REQUEST_BODY: 'MISSING_REQUEST_BODY',
  MISSING_RAW_GRANT: 'MISSING_RAW_GRANT',
  MISSING_OPPORTUNITY_ID: 'MISSING_OPPORTUNITY_ID',
  INVALID_GRANT_DATA: 'INVALID_GRANT_DATA',
  MAPPING_FAILED: 'MAPPING_FAILED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR'
};

// Base44 integration: Use centralized logger
const logger = createLogger('processOpportunity');

function validateRawGrant(rawGrant) {
  const errors = [];
  const warnings = [];
  if (!rawGrant.opportunityId) errors.push('opportunityId is required');
  if (!rawGrant.opportunityTitle) errors.push('opportunityTitle is required');
  if (!rawGrant.agencyName) warnings.push('agencyName is missing');
  if (!rawGrant.description) warnings.push('description is missing');
  return { errors, warnings, isValid: errors.length === 0 };
}

// Base44 integration: Removed custom logSafe in favor of centralized logger
// The centralized logger does NOT log sensitive data by design.
// If you need to log data here, use logger.error() or logger.warn() and
// ensure you are only passing non-sensitive context (no PHI/PII).

function createErrorResponse(errorCode, message, details = {}, statusCode = 400) {
  return new Response(JSON.stringify({
    success: false,
    error: { code: errorCode, message, details, timestamp: new Date().toISOString() }
  }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
}

createSafeServer(async (req) => {
  const base44 = createClientFromRequest(req);
  const requestId = crypto.randomUUID();
  logSafe('info', 'Processing opportunity request started', { requestId });

  try {
    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      return createErrorResponse(ErrorCodes.MISSING_REQUEST_BODY, 'Invalid JSON in request body', { parseError: parseError.message });
    }

    const { rawGrant } = body;
    if (!rawGrant) {
      return createErrorResponse(ErrorCodes.MISSING_RAW_GRANT, 'Missing rawGrant in request body', { received: Object.keys(body) });
    }

    const validation = validateRawGrant(rawGrant);
    if (!validation.isValid) {
      return createErrorResponse(ErrorCodes.INVALID_GRANT_DATA, 'Invalid grant data structure', { errors: validation.errors });
    }

    let mappedItem;
    try {
      mappedItem = {
        source: 'grants_gov',
        source_id: rawGrant.opportunityId,
        title: rawGrant.opportunityTitle,
        sponsor: rawGrant.agencyName || 'Unknown Agency',
        url: 'https://www.grants.gov/search-results-detail/' + rawGrant.opportunityId,
        description_raw: rawGrant.description || '',
        open_date: rawGrant.postDate || null,
        close_date: rawGrant.closeDate || null,
        funding_type: 'grant',
        award_min: rawGrant.awardFloor || null,
        award_max: rawGrant.awardCeiling || null,
        categories: rawGrant.categories || [],
        regions: rawGrant.eligibleApplicants || []
      };
    } catch (mappingError) {
      return createErrorResponse(ErrorCodes.MAPPING_FAILED, 'Failed to map grant data', { error: mappingError.message }, 500);
    }

    try {
      await base44.asServiceRole.functions.invoke('processCrawledItem', { item: mappedItem });
      return new Response(JSON.stringify({ 
        success: true, status: 'processed',
        data: { opportunityId: rawGrant.opportunityId, title: mappedItem.title, source: 'grants_gov' },
        requestId
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (processingError) {
      return createErrorResponse(ErrorCodes.PROCESSING_FAILED, 'Failed to process grant', { error: processingError.message }, 500);
    }
  } catch (error) {
    return createErrorResponse(ErrorCodes.UNEXPECTED_ERROR, 'Unexpected error', { error: error.message }, 500);
  }
});