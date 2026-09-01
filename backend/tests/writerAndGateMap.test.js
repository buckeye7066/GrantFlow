import fs from 'fs'
import path from 'path'

/**
 * Writer-and-gate map — executable, not prose.
 *
 * Asserts:
 * - Only approved files perform raw "INSERT INTO grants"
 * - Each approved writer references its gate function(s)
 */

const repoRoot = path.resolve(__dirname, '..', '..')

function readFile(p) {
  return fs.readFileSync(path.join(repoRoot, p), 'utf8')
}

function grepInsertIntoGrants() {
  const results = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && full.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8')
        if (/INSERT\s+INTO\s+grants/i.test(text)) {
          results.push(full.replace(repoRoot + path.sep, ''))
        }
      }
    }
  }
  walk(repoRoot)
  return results.sort()
}

describe('writer-and-gate map', () => {
  it('only approved files perform raw "INSERT INTO grants"', () => {
    const allowed = new Set([
      'backend/services/opportunityMatcher.js',
      'backend/services/robert/robertSourceAcquisition.js',
      'backend/services/robert/robertFunderLeads.js',
    ])
    const writers = grepInsertIntoGrants()
    // Useful snapshot for humans when the set changes
    // console.log('writers:', writers)
    for (const w of writers) {
      expect(allowed.has(w)).toBeTruthy()
    }
  })

  it('opportunityMatcher writer references admission gates', () => {
    const text = readFile('backend/services/opportunityMatcher.js')
    expect(text).toMatch(/Gate:NEED_COVERAGE/)
    expect(text).toMatch(/classifyFundingResult/)
    expect(text).toMatch(/RELEVANCE_FLOOR/)
  })

  it('robertSourceAcquisition uses qualifyForProfile before insert', () => {
    const text = readFile('backend/services/robert/robertSourceAcquisition.js')
    expect(text).toMatch(/qualifyForProfile\s*\(/)
    expect(text).toMatch(/INSERT\s+INTO\s+grants/i)
  })

  it('robertFunderLeads uses qualifyFunderLead before insert', () => {
    const text = readFile('backend/services/robert/robertFunderLeads.js')
    expect(text).toMatch(/qualifyFunderLead\s*\(/)
    expect(text).toMatch(/INSERT\s+INTO\s+grants/i)
  })
})

