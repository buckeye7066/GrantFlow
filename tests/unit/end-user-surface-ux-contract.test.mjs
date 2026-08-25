import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

test('calendar exposes non-color status, selected-day, loading, and failure semantics', () => {
  const source = read('src/pages/EndUserCalendar.jsx')

  assert.match(source, /describeCalendarDay\(day, items\)/)
  assert.match(source, /aria-pressed=\{Boolean\(selected\)\}/)
  assert.match(source, /aria-current=\{today \? 'date'/)
  assert.match(source, /role="alert"/)
  assert.match(source, /role="status"/)
  assert.match(source, /statusIcon\(kind\)/)
})

test('pipeline preserves local calendar dates and states human submission boundaries', () => {
  const source = read('src/pages/EndUserPipeline.jsx')

  assert.match(source, /parseLocalDate\(grant\.deadline\)/)
  assert.match(source, /GrantFlow cannot bypass those steps/)
  assert.match(source, /Hamilton submits and records confirmation/)
  const obsoleteOwnerCheckpoint = new RegExp(['owner', 'appro' + 'val'].join('\\s+'), 'i')
  assert.doesNotMatch(source, obsoleteOwnerCheckpoint)
  assert.match(source, /tasksQuery\.isLoading \|\| tasksQuery\.isError/)
  assert.match(source, /aria-pressed=\{selected\}/)
})

test('item search never reuses canonical match scores as item relevance', () => {
  const page = read('src/pages/ItemFunding.jsx')
  const needs = read('src/components/ai/NeedsDiscoveryPanel.jsx')

  assert.match(page, /opp\.item_relevance_score/)
  assert.match(page, /Item relevance estimate/)
  assert.doesNotMatch(page, /opp\.combined_score/)
  assert.doesNotMatch(page, /opp\.match_score/)
  assert.doesNotMatch(page, /\|\|\s*50/)
  assert.match(needs, /source\.item_relevance_score/)
  assert.doesNotMatch(needs, /combined_score/)
  assert.doesNotMatch(needs, /src\.match_score/)
})

test('Help Center and Anya provide named composer, disclosure, and conversation regions', () => {
  const help = read('src/pages/EndUserHelp.jsx')
  const chat = read('src/components/anya/AnyaChat.jsx')

  assert.match(help, />Help Center</)
  assert.match(help, /Questions you can ask Anya/)
  assert.match(chat, /role="log"/)
  assert.match(chat, /aria-expanded=\{isTasksExpanded\}/)
  assert.match(chat, />Message Anya</)
  assert.match(chat, /aria-label="Start a new conversation"/)
})

test('simplified Dashboard routes end users only through visible workflow surfaces', () => {
  const dashboard = read('src/pages/Dashboard.jsx')
  const actions = read('src/components/dashboard/PipelineActionsCard.jsx')

  assert.match(dashboard, /END_USER_DASHBOARD_PATHS/)
  assert.match(dashboard, /!isSimplified \? <PersonalizationPanel/)
  assert.match(actions, /isSimplified[\s\S]*createPageUrl\('Pipeline'\)/)
  assert.match(actions, /isSimplified[\s\S]*createPageUrl\('Help'\)/)
})

test('mobile layouts constrain grid tracks and preserve minimum target dimensions', () => {
  const calendar = read('src/pages/EndUserCalendar.jsx')
  const pipeline = read('src/pages/EndUserPipeline.jsx')
  const item = read('src/pages/ItemFunding.jsx')
  const breadcrumb = read('src/components/ui/breadcrumb.jsx')
  const dialog = read('src/components/ui/dialog.jsx')
  const pipelineStatus = read('src/components/dashboard/PipelineStatusCard.jsx')

  assert.match(calendar, /grid-cols-\[minmax\(0,1fr\)\]/)
  assert.match(calendar, /!min-w-0/)
  assert.match(pipeline, /grid-cols-\[minmax\(0,1fr\)\]/)
  assert.match(pipeline, /whitespace-normal/)
  assert.match(item, /className="h-6 w-10/)
  assert.match(breadcrumb, /inline-flex min-h-6/)
  assert.match(dialog, /min-h-\[24px\][\s\S]*min-w-\[24px\]/)
  assert.match(pipelineStatus, /if \(!isAdmin\)[\s\S]*?<Card className="border/)
})
