import { readFile, writeFile } from 'node:fs/promises'

const registryPath = 'backend/services/anyaToolRegistry.js'
const orchestratorPath = 'backend/services/anyaOrchestrator.js'
const handlerPath = 'backend/services/anyaMaintenanceStatus.js'
const testPath = 'tests/unit/anya-maintenance-status-tool.test.mjs'

function replaceRequired(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`Could not locate ${label}`)
  }
  return source.replace(needle, replacement)
}

let registry = await readFile(registryPath, 'utf8')
let orchestrator = await readFile(orchestratorPath, 'utf8')

const handlerImport = "import { getAnyaMaintenanceStatus } from './anyaMaintenanceStatus.js'"
if (!registry.includes(handlerImport)) {
  const importMarker = "} from './applicationWorkflow.js'\n\nconst tools = new Map()"
  registry = replaceRequired(
    registry,
    importMarker,
    "} from './applicationWorkflow.js'\n" + handlerImport + "\n\nconst tools = new Map()",
    'Anya registry import insertion point',
  )
}

if (!registry.includes("name: 'app.getMaintenanceStatus'")) {
  const toolBlock = `registerTool({
  name: 'app.getMaintenanceStatus',
  description: 'Read the current live GrantFlow maintenance state. Use this whenever a user asks whether the maintenance banner is on or off, whether GrantFlow is in maintenance, or when it will reopen.',
  schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: getAnyaMaintenanceStatus,
})

`
  registry = replaceRequired(
    registry,
    'export function listToolMetadata(ctx = null) {',
    toolBlock + 'export function listToolMetadata(ctx = null) {',
    'Anya registry metadata export',
  )
}

const maintenanceToolDoc = "  ['app.getMaintenanceStatus', 'Read the live maintenance state and report whether the banner is on or off. Use whenever asked about maintenance, the banner, downtime, or reopening.'],"
if (!orchestrator.includes(maintenanceToolDoc)) {
  const docsMarker = "  ['app.explainField', 'Explain what a specific profile field does, why it matters for matching, and whether it affects crawlers (field key e.g. zip, state, health_conditions).'],"
  orchestrator = replaceRequired(
    orchestrator,
    docsMarker,
    docsMarker + '\n' + maintenanceToolDoc,
    'Anya chat-callable tool documentation',
  )
}

const oldBoundaryClause = "and system-health checks run through GrantFlow\\'s app panels, not this chat. If the user needs one, explain it and point them to the exact screen — do NOT claim you executed it."
const newBoundaryClause = "and broad system-health checks run through GrantFlow\\'s app panels, not this chat. The live maintenance state is the exception: call app.getMaintenanceStatus and report the result. For everything else, point the user to the exact screen — do NOT claim you executed it."
if (!orchestrator.includes(newBoundaryClause)) {
  orchestrator = replaceRequired(
    orchestrator,
    oldBoundaryClause,
    newBoundaryClause,
    'Anya system-health boundary',
  )
}

const maintenanceRule = "  '- When asked whether the maintenance banner is on or off, whether GrantFlow is in maintenance, or when it will reopen, call app.getMaintenanceStatus. Never send the user to Admin Tools for this public live status.',"
if (!orchestrator.includes(maintenanceRule)) {
  const routingMarker = "  '',\n  'CHAT APPEARANCE (you control it):',"
  orchestrator = replaceRequired(
    orchestrator,
    routingMarker,
    maintenanceRule + '\n' + routingMarker,
    'Anya answer-routing section',
  )
}

const progressLabel = "          'app.getMaintenanceStatus': 'Checking the live maintenance status',"
if (!orchestrator.includes(progressLabel)) {
  const progressMarker = "          'app.explainField': 'Looking up what this field does',"
  orchestrator = replaceRequired(
    orchestrator,
    progressMarker,
    progressMarker + '\n' + progressLabel,
    'Anya tool progress labels',
  )
}

const handlerSource = `import { getMaintenanceStatus } from './maintenance/maintenanceMode.js'

/**
 * Read-only tool used by Anya chat to answer live maintenance/banner questions.
 * The underlying state is the same database-backed source polled by the UI.
 */
export async function getAnyaMaintenanceStatus(_params = {}, context = {}) {
  if (!context?.db) throw new Error('Database connection unavailable')

  const status = await getMaintenanceStatus(context.db)
  const phase = status?.phase || 'open'
  const bannerVisible = phase !== 'open'
  const estimatedEnd = status?.estimated_end_at || null

  return {
    ...status,
    phase,
    active: Boolean(status?.active),
    banner_visible: bannerVisible,
    banner_state: bannerVisible ? 'on' : 'off',
    checked_at: new Date().toISOString(),
    answer: bannerVisible
      ? 'The maintenance banner is on. GrantFlow is in ' + phase + ' maintenance' + (estimatedEnd ? ' and is estimated to reopen at ' + estimatedEnd : '') + '.'
      : 'The maintenance banner is off. GrantFlow is open.',
  }
}
`

const testSource = `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { getAnyaMaintenanceStatus } from '../../backend/services/anyaMaintenanceStatus.js'
import { listToolMetadata } from '../../backend/services/anyaToolRegistry.js'
import { CHAT_CALLABLE_TOOL_DOCS, CHAT_TOOL_WHITELIST } from '../../backend/services/anyaOrchestrator.js'

function makeMaintenanceDb(state) {
  return {
    prepare(sql) {
      const normalized = String(sql).replace(/\\s+/g, ' ').trim()
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS system_kv')) {
        return { run: async () => ({ changes: 0 }) }
      }
      if (normalized.startsWith('SELECT value FROM system_kv')) {
        return {
          get: async () => (state ? { value: JSON.stringify(state) } : undefined),
        }
      }
      throw new Error('Unexpected SQL in maintenance test: ' + normalized)
    },
  }
}

test('Anya chat advertises the live maintenance-status tool', async () => {
  const metadata = listToolMetadata()
  assert.ok(metadata.some((entry) => entry.name === 'app.getMaintenanceStatus'))
  assert.ok(CHAT_TOOL_WHITELIST.includes('app.getMaintenanceStatus'))
  assert.match(
    CHAT_CALLABLE_TOOL_DOCS.find(([name]) => name === 'app.getMaintenanceStatus')?.[1] || '',
    /banner is on or off/i,
  )

  const source = await readFile('backend/services/anyaOrchestrator.js', 'utf8')
  assert.match(source, /Never send the user to Admin Tools for this public live status/)
})

test('Anya reports the maintenance banner off when GrantFlow is open', async () => {
  const result = await getAnyaMaintenanceStatus({}, { db: makeMaintenanceDb(null) })
  assert.equal(result.phase, 'open')
  assert.equal(result.active, false)
  assert.equal(result.banner_visible, false)
  assert.equal(result.banner_state, 'off')
  assert.match(result.answer, /banner is off/i)
})

test('Anya reports the maintenance banner on for an active warning window', async () => {
  const now = Date.now()
  const result = await getAnyaMaintenanceStatus({}, {
    db: makeMaintenanceDb({
      active: true,
      reason: 'deploy',
      message: 'Finishing an update.',
      started_at: new Date(now - 60_000).toISOString(),
      grace_until: new Date(now + 10 * 60_000).toISOString(),
      estimated_end_at: new Date(now + 25 * 60_000).toISOString(),
      scheduled_by: 'test',
    }),
  })

  assert.equal(result.phase, 'warning')
  assert.equal(result.active, true)
  assert.equal(result.banner_visible, true)
  assert.equal(result.banner_state, 'on')
  assert.match(result.answer, /banner is on/i)
})
`

await Promise.all([
  writeFile(registryPath, registry, 'utf8'),
  writeFile(orchestratorPath, orchestrator, 'utf8'),
  writeFile(handlerPath, handlerSource, 'utf8'),
  writeFile(testPath, testSource, 'utf8'),
])

console.log('Applied focused Anya maintenance-status wiring.')
