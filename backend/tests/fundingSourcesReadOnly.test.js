import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routePath = path.resolve(__dirname, '../routes/fundingSources.js')

describe('GET funding-sources is SELECT-only presentation', () => {
  it('does not run schema setup or reconcile/write scores while reading', () => {
    const source = fs.readFileSync(routePath, 'utf8')
    expect(source).not.toContain('ensurePipelineDismissalsSchema')
    expect(source).not.toContain('reconcileNeedFirstProfileMatches')
    expect(source).toContain('deferred_to_background: true')
    expect(source).toContain('read_only: true')
  })
})
