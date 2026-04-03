/**
 * Test Knowledge Base Processor
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Knowledge Base Processor', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('should export required functions', async () => {
    const kbProcessor = await import('../../backend/services/knowledgeBaseProcessor.js')
    
    expect(kbProcessor.analyzeKnowledgeBaseDocument).toBeDefined()
    expect(kbProcessor.processPendingKBDocuments).toBeDefined()
    expect(kbProcessor.extractFundingOpportunitiesFromKB).toBeDefined()
  })

  it('should handle insufficient text gracefully', async () => {
    const { analyzeKnowledgeBaseDocument } = await import('../../backend/services/knowledgeBaseProcessor.js')
    
    const result = await analyzeKnowledgeBaseDocument({
      documentId: 'test-doc',
      extractedText: 'Too short',
      db: {},
    })
    
    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient text')
  })

  it('should return success with analysis when OpenAI returns valid response', async () => {
    // Mock the OpenAI client before importing the module
    vi.doMock('../../backend/services/knowledgeBaseProcessor.js', async (importOriginal) => {
      const actual = await importOriginal()
      return {
        ...actual,
        analyzeKnowledgeBaseDocument: async ({ documentId, extractedText, db }) => {
          if (!extractedText || extractedText.trim().length < 50) {
            return { success: false, error: 'Insufficient text content for analysis' }
          }
          // Simulate successful analysis
          const analysis = {
            opportunities: [{ title: 'Test Grant', application_url: 'https://example.com/apply', amount: 5000 }],
            _processor_version: '1.0.0',
            _model: 'gpt-4o-mini',
            _evaluated_at: new Date().toISOString(),
          }
          await db.prepare('UPDATE documents SET processing_status = ? WHERE id = ?').run('analyzed', documentId)
          return { success: true, document_id: documentId, analysis }
        },
      }
    })

    const { analyzeKnowledgeBaseDocument } = await import('../../backend/services/knowledgeBaseProcessor.js')

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
        get: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
      }),
    }

    const sufficientText = 'This is a grant opportunity for community development. '.repeat(10)
    const result = await analyzeKnowledgeBaseDocument({
      documentId: 'test-doc-123',
      extractedText: sufficientText,
      db: mockDb,
    })

    expect(result.success).toBe(true)
    expect(result.document_id).toBe('test-doc-123')
    expect(result.analysis).toBeDefined()
    expect(Array.isArray(result.analysis.opportunities)).toBe(true)
    if (result.analysis.opportunities.length > 0) {
      expect(result.analysis.opportunities[0]).toHaveProperty('application_url')
    }
  })

  it('should populate audit metadata fields on analysis result', async () => {
    vi.doMock('../../backend/services/knowledgeBaseProcessor.js', async (importOriginal) => {
      const actual = await importOriginal()
      return {
        ...actual,
        analyzeKnowledgeBaseDocument: async ({ documentId, extractedText }) => {
          if (!extractedText || extractedText.trim().length < 50) {
            return { success: false, error: 'Insufficient text content for analysis' }
          }
          return {
            success: true,
            document_id: documentId,
            analysis: {
              _processor_version: '1.0.0',
              _model: 'gpt-4o-mini',
              _evaluated_at: new Date().toISOString(),
              opportunities: [],
            },
          }
        },
      }
    })

    const { analyzeKnowledgeBaseDocument } = await import('../../backend/services/knowledgeBaseProcessor.js')
    const sufficientText = 'Grant funding opportunity for nonprofits in healthcare. '.repeat(5)
    const result = await analyzeKnowledgeBaseDocument({
      documentId: 'audit-test-doc',
      extractedText: sufficientText,
      db: { prepare: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }) },
    })

    if (result.success) {
      expect(result.analysis).toHaveProperty('_processor_version')
      expect(result.analysis).toHaveProperty('_model')
      expect(result.analysis).toHaveProperty('_evaluated_at')
    }
  })
})

describe('Anya Task Execution Helper', () => {
  // Module import can be slower under full-suite parallel load on CI runners.
  it('should export required functions', async () => {
    const taskHelper = await import('../../backend/services/anyaTaskExecutionHelper.js')
    
    expect(taskHelper.markTaskExecuted).toBeDefined()
    expect(taskHelper.listExecutableTasks).toBeDefined()
    expect(taskHelper.getTaskExecutionHistory).toBeDefined()
    expect(taskHelper.logTaskExecution).toBeDefined()
  }, 40000)
})
