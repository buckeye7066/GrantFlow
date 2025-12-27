import fs from 'fs/promises'
import path from 'path'

class ActionLogStore {
  constructor(filename, options = {}) {
    this.filePath = path.resolve(filename)
    this.maxEntries = options.maxEntries ?? 1000
    this.writeQueue = Promise.resolve()
  }

  async append(entry) {
    this.writeQueue = this.writeQueue.then(() => this.#appendInternal(entry))
    return this.writeQueue
  }

  async getAll(limit = 50) {
    const entries = await this.#readEntries()
    if (limit <= 0) return entries
    return entries.slice(-limit).reverse()
  }

  async #appendInternal(entry) {
    const entries = await this.#readEntries()
    entries.push(entry)
    const trimmed = entries.slice(-this.maxEntries)
    await fs.writeFile(this.filePath, JSON.stringify(trimmed, null, 2), 'utf8')
  }

  async #readEntries() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.writeFile(this.filePath, '[]', 'utf8')
        return []
      }
      throw error
    }
  }
}

export default ActionLogStore
