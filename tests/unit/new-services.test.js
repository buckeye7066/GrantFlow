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
})

describe('Anya Task Execution Helper', () => {
  it('should export required functions', async () => {
    const taskHelper = await import('../../backend/services/anyaTaskExecutionHelper.js')
    
    expect(taskHelper.markTaskExecuted).toBeDefined()
    expect(taskHelper.listExecutableTasks).toBeDefined()
    expect(taskHelper.getTaskExecutionHistory).toBeDefined()
    expect(taskHelper.logTaskExecution).toBeDefined()
  })
})
