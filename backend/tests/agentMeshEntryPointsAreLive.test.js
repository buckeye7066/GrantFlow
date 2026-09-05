import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_MESH_REGISTRY } from '../services/agentMesh/agentMeshRegistry.js'

/**
 * An entry point must be a door someone can actually walk through.
 *
 * agentMeshRegistry.js listed `backend/crawler-os/agents/{robert,yana,john,
 * hamilton}.js` as entry points for those agents. Nothing imports any of them:
 * `createFleet()` in that directory has no caller outside backend/tests/, and
 * the registry itself only ever mentioned the paths as STRINGS.
 *
 * That is not a cosmetic inaccuracy. A reader following the registry to learn
 * what an agent does lands on a module that is materially weaker than the one
 * that ships — `crawler-os/agents/john.js` composes email from a fixed
 * template, while the live `services/john/` composer embeds the organisation's
 * mission, revenue, website excerpt and live web research. An audit of this
 * repository reported the live agents as placeholders using descriptions that
 * match the dead modules almost verbatim.
 *
 * The existing agentMesh test only asserted `entry_points.length > 0`, which a
 * list of dead paths satisfies perfectly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** Registry entries read like "path/to/file.js someFunction()" — take the path. */
function filePathOf(entry) {
  return String(entry).trim().split(/\s+/)[0]
}

/** Every non-test source file, so "is this imported anywhere real?" is answerable. */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      // Tests importing a module do NOT make it a live entry point — that is
      // exactly how a dead module keeps looking alive.
      if (/(^|[\\/])(tests?|__tests__)$/.test(full)) continue
      sourceFiles(full, out)
    } else if (/\.(js|mjs|jsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const ALL_SOURCE = [
  ...sourceFiles(path.join(REPO_ROOT, 'backend')),
  ...sourceFiles(path.join(REPO_ROOT, 'src')),
]
const HAYSTACK = ALL_SOURCE.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))

const entries = Object.entries(AGENT_MESH_REGISTRY).flatMap(([agent, meta]) =>
  (meta.entry_points ?? []).map((raw) => ({ agent, raw, file: filePathOf(raw) })),
)

describe('agent-mesh entry points are real', () => {
  it('the registry actually declares some', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it.each(entries)('$agent: $file exists on disk', ({ file }) => {
    expect(existsSync(path.join(REPO_ROOT, file)), `${file} is not in the repository`).toBe(true)
  })

  /**
   * A path can exist and still be dead. An entry point must be imported by
   * something that is not a test — otherwise the registry points readers at
   * code that never runs.
   *
   * HONEST LIMIT OF THIS CHECK, stated because a test that oversells itself is
   * the same defect it is here to catch: this is ONE HOP, not reachability. A
   * dead module imported by another dead module passes it. That is not
   * hypothetical — `crawler-os/agents/john.js` is imported by
   * `crawler-os/agents/index.js`, and `createFleet()` there has no caller
   * outside tests, so the whole cluster would slip through on this assertion
   * alone. Verified by canary: restoring that path to the registry reddens only
   * the explicit crawler-os assertion below, not this one.
   *
   * Real reachability would need a graph walk from server.js. Until someone
   * writes that, this catches the common case (a path nothing references at
   * all) and the next test names the one known dead cluster outright.
   */
  it.each(entries)('$agent: $file is imported by real code, not just tests', ({ file }) => {
    const base = path.basename(file)
    const importers = HAYSTACK.filter(({ file: f, text }) => {
      if (path.resolve(REPO_ROOT, file) === f) return false // not itself
      // An import/require/dynamic-import naming this module.
      return new RegExp(`(from|import|require)\\s*\\(?\\s*['"\`][^'"\`]*${base.replace('.', '\\.')}['"\`]`).test(text)
    })
    expect(
      importers.length,
      `${file} is declared an entry point for ${JSON.stringify(base)} but nothing outside tests imports it`,
    ).toBeGreaterThan(0)
  })

  it('no entry point points into the dead crawler-os agent fleet', () => {
    const dead = entries.filter((e) => e.file.includes('crawler-os/agents/'))
    expect(
      dead.map((e) => `${e.agent} -> ${e.file}`),
      'crawler-os/agents/* has no caller outside tests; see the banner on those files',
    ).toEqual([])
  })
})
