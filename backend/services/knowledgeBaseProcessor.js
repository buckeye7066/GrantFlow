/**
 * Knowledge Base Document AI Processor
 * 
 * Analyzes uploaded KB documents to:
 * - Classify document type (funding opportunity, profile info, form, etc.)
 * - Extract funding source URLs
 * - Identify eligibility requirements
 * - Extract deadline and amount information
 */

import { createOpenAIClient } from '../utils/openaiClient.js'

const ANALYSIS_PROMPT = `You are analyzing a knowledge base document to identify its purpose and extract key information.

Classify the document and extract relevant details:

1. Document Type: Identify if this is a:
   - "funding_opportunity" - Contains information about grants, funding sources, or financial assistance programs
   - "profile_info" - Contains information about an organization or individual
   - "form" - An application form or template
   - "guidance" - Instructions, guidelines, or how-to documents
   - "other" - Does not fit the above categories

2. If the document is about FUNDING OPPORTUNITIES, extract:
   - funding_source_urls: Array of URLs for grant portals, funder websites, or application pages
   - opportunity_names: Array of specific grant/funding program names mentioned
   - eligibility_keywords: Key eligibility criteria (e.g., "nonprofit", "small business", "veteran", geographic restrictions)
   - funding_amounts: Any mentioned dollar amounts or funding ranges
   - deadlines: Any mentioned deadlines or application periods
   - contact_info: Email addresses, phone numbers, or contact persons for the funding

3. If the document contains PROFILE/ORGANIZATION INFO:
   - organization_names: Names of organizations mentioned
   - ein_tax_ids: Any EIN or tax ID numbers
   - addresses: Physical addresses
   - contact_emails: Email addresses
   - phone_numbers: Phone numbers

Return your analysis as a JSON object with these fields.
If a field has no data, use null or an empty array.`

/**
 * Analyze a knowledge base document using AI
 * @param {Object} params
 * @param {string} params.documentId - Document ID
 * @param {string} params.extractedText - Text extracted from document
 * @param {Object} params.db - Database connection
 * @returns {Promise<Object>} Analysis results
 */
export async function analyzeKnowledgeBaseDocument({ documentId, extractedText, db }) {
  if (!extractedText || extractedText.trim().length < 50) {
    return {
      success: false,
      error: 'Insufficient text content for analysis',
    }
  }

  try {
    const { openai } = createOpenAIClient()
    
    // Truncate very long documents to manage token usage
    const maxLength = 50000 // ~12.5k tokens
    const textToAnalyze = extractedText.length > maxLength 
      ? extractedText.substring(0, maxLength) + '\n\n[Document truncated for analysis]'
      : extractedText

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { 
          role: 'user', 
          content: `Analyze this document:\n\n${textToAnalyze}` 
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 2000,
    })

    const analysisText = completion.choices[0]?.message?.content
    if (!analysisText) {
      throw new Error('No analysis returned from AI')
    }

    const analysis = JSON.parse(analysisText)
    
    // Store analysis results in document metadata
    await db
      .prepare(
        `
          UPDATE documents 
          SET 
            processing_status = 'analyzed',
            processing_metadata = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      )
      .run(JSON.stringify(analysis), documentId)

    return {
      success: true,
      document_id: documentId,
      analysis,
    }
  } catch (error) {
    console.error('[KB Processor] Analysis failed', {
      documentId,
      error: error?.message || String(error),
    })

    // Mark document as having a processing error
    try {
      await db
        .prepare(
          `
            UPDATE documents 
            SET 
              processing_status = 'error',
              processing_error = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
        )
        .run(String(error?.message || error), documentId)
    } catch (dbError) {
      console.error('[KB Processor] Failed to update error status', dbError)
    }

    return {
      success: false,
      error: error?.message || String(error),
    }
  }
}

/**
 * Process a batch of unanalyzed KB documents
 * @param {Object} db - Database connection
 * @param {number} limit - Maximum number of documents to process (default: 10)
 * @returns {Promise<Object>} Processing results
 */
export async function processPendingKBDocuments(db, limit = 10) {
  try {
    // Find KB documents that haven't been analyzed yet
    const pendingDocs = await db
      .prepare(
        `
          SELECT id, extracted_text
          FROM documents
          WHERE type = 'knowledge'
            AND processing_status IN ('completed', 'pending')
            AND (processing_metadata IS NULL OR processing_metadata = '')
            AND extracted_text IS NOT NULL
            AND length(extracted_text) > 50
          ORDER BY created_at DESC
          LIMIT ?
        `
      )
      .all(limit)

    if (pendingDocs.length === 0) {
      return {
        success: true,
        processed: 0,
        message: 'No pending KB documents to analyze',
      }
    }

    const results = []
    for (const doc of pendingDocs) {
      const result = await analyzeKnowledgeBaseDocument({
        documentId: doc.id,
        extractedText: doc.extracted_text,
        db,
      })
      results.push(result)
    }

    const successCount = results.filter(r => r.success).length
    const failCount = results.filter(r => !r.success).length

    return {
      success: true,
      processed: pendingDocs.length,
      succeeded: successCount,
      failed: failCount,
      results,
    }
  } catch (error) {
    console.error('[KB Processor] Batch processing failed', error)
    return {
      success: false,
      error: error?.message || String(error),
    }
  }
}

/**
 * Extract funding opportunities from analyzed KB documents
 * @param {Object} db - Database connection
 * @returns {Promise<Array>} Array of potential funding opportunities
 */
export async function extractFundingOpportunitiesFromKB(db) {
  try {
    const docs = await db
      .prepare(
        `
          SELECT id, name, processing_metadata, extracted_text
          FROM documents
          WHERE type = 'knowledge'
            AND processing_status = 'analyzed'
            AND processing_metadata IS NOT NULL
            AND processing_metadata != ''
          ORDER BY created_at DESC
        `
      )
      .all()

    const opportunities = []

    for (const doc of docs) {
      try {
        const metadata = JSON.parse(doc.processing_metadata)
        
        // Only process documents classified as funding opportunities
        if (metadata.document_type !== 'funding_opportunity') {
          continue
        }

        // Extract relevant opportunity data
        const fundingUrls = Array.isArray(metadata.funding_source_urls) 
          ? metadata.funding_source_urls 
          : []
        
        const opportunityNames = Array.isArray(metadata.opportunity_names)
          ? metadata.opportunity_names
          : []

        // Create opportunity records for each URL or name
        if (fundingUrls.length > 0 || opportunityNames.length > 0) {
          opportunities.push({
            source_document_id: doc.id,
            source_document_name: doc.name,
            funding_urls: fundingUrls,
            opportunity_names: opportunityNames,
            eligibility_keywords: metadata.eligibility_keywords || [],
            funding_amounts: metadata.funding_amounts || [],
            deadlines: metadata.deadlines || [],
            contact_info: metadata.contact_info || {},
            extracted_text_preview: doc.extracted_text?.substring(0, 500) || null,
          })
        }
      } catch (parseError) {
        console.warn('[KB Processor] Failed to parse metadata for doc', doc.id, parseError)
      }
    }

    return opportunities
  } catch (error) {
    console.error('[KB Processor] Failed to extract opportunities', error)
    return []
  }
}
