import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import {
  executeQuery,
  updateSetting,
  generateReport,
  clearCache,
  rebuildSearchIndex,
} from './adminOperations.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const AUDIT_DIR = path.join(__dirname, '..', 'anya', 'audit')

class AnyaRuntimeController {
  constructor(logStore) {
    this.logStore = logStore
    this.status = 'idle'
    this.currentAction = null
    this.lastError = null
    this.auditReady = false
  }

  getStatus() {
    return {
      status: this.status,
      currentAction: this.currentAction,
      lastError: this.lastError,
    }
  }

  async execute(action, actor, payload = {}) {
    if (!action) throw new Error('Action is required')
    if (this.status === 'running') {
      throw new Error('Anya is currently executing another task')
    }

    await this.#ensureAuditDirectory()

    const startedAt = new Date().toISOString()
    this.status = 'running'
    this.currentAction = { action, startedAt, payload }
    this.lastError = null

    const startLog = {
      id: uuid(),
      timestamp: startedAt,
      actor,
      action,
      input: payload,
      status: 'started',
      message: `${action} requested`,
    }
    await this.logStore.append(startLog)
    await this.#appendAudit(startLog)

    try {
      const result = await this.#executeAction(action, payload)
      const finishedAt = new Date().toISOString()
      const successLog = {
        id: uuid(),
        timestamp: finishedAt,
        actor,
        action,
        input: payload,
        status: 'completed',
        message: result.message,
        data: result.data,
      }
      await this.logStore.append(successLog)
      await this.#appendAudit(successLog)
      this.status = 'idle'
      this.currentAction = null
      return successLog
    } catch (error) {
      const failedAt = new Date().toISOString()
      const errorLog = {
        id: uuid(),
        timestamp: failedAt,
        actor,
        action,
        input: payload,
        status: 'failed',
        message: error.message,
      }
      await this.logStore.append(errorLog)
      await this.#appendAudit(errorLog)
      this.status = 'error'
      this.lastError = { message: error.message, occurredAt: failedAt }
      this.currentAction = null
      throw error
    }
  }

  async #executeAction(action, payload) {
    switch (action) {
      case 'scan':
        return this.#simulateScan(payload)
      case 'crawl':
        return this.#simulateCrawl(payload)
      case 'explain':
        return this.#simulateExplain(payload)
      case 'run-query':
        return executeQuery(payload)
      case 'update-setting':
        return updateSetting(payload)
      case 'generate-report':
        return generateReport(payload)
      case 'clear-cache':
        return clearCache(payload)
      case 'rebuild-search-index':
        return rebuildSearchIndex(payload)
      default:
        throw new Error(`Unsupported action: ${action}`)
    }
  }

  async #simulateScan(payload) {
    const { target = 'repository', approve = false, autoFix = false } = payload

    if (autoFix && !approve) {
      throw new Error('Auto-fix requested without explicit admin approval. Action cancelled.')
    }

    await this.#delay(600)

    return {
      message: `Scan of ${target} completed` + (autoFix ? ' with approved remediations' : ''),
      data: {
        target,
        issuesFound: Math.round(Math.random() * 5),
        autoFixApplied: Boolean(autoFix && approve),
      },
    }
  }

  async #simulateCrawl(payload) {
    const { scope = 'default-datasets', depth = 1 } = payload
    await this.#delay(800)
    return {
      message: `Crawl of ${scope} completed`,
      data: {
        scope,
        depth,
        recordsDiscovered: Math.round(Math.random() * 20 + depth * 5),
      },
    }
  }

  async #simulateExplain(payload) {
    const { context = 'latest-scan' } = payload
    await this.#delay(400)
    return {
      message: 'Explanation generated',
      data: {
        context,
        summary: `Anya generated an explanation for ${context}.`,
      },
    }
  }

  async #delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export default AnyaRuntimeController

  async #ensureAuditDirectory() {
    if (this.auditReady) return
    await fs.mkdir(AUDIT_DIR, { recursive: true })
    this.auditReady = true
  }

  async #appendAudit(entry) {
    try {
      const stamp = entry.timestamp ?? new Date().toISOString()
      const file = path.join(AUDIT_DIR, `${stamp.slice(0, 10)}.log`)
      await fs.appendFile(file, `${JSON.stringify({ ...entry, timestamp: stamp })}\n`, 'utf8')
    } catch (error) {
      console.error('[AnyaRuntime] Unable to persist audit log', error)
    }
  }
}

export default AnyaRuntimeController
