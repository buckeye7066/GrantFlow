/**
 * profileTodoPlan.js
 *
 * Pure helpers for the Profile Action Plan ("Generate Checklist") generator in
 * routes/ai.js. Kept dependency-free and exported so they can be unit-tested
 * without spinning up the whole AI route (which pulls in many service deps).
 *
 * These keep the generated checklist:
 *   - anchored to the CURRENT server date (the LLM emits dates from its training
 *     period, e.g. 2023-2024, so we post-process every deadline), and
 *   - honest about completion (never ask the user to "complete" a section that
 *     is already populated).
 */

// A profile_sections value is "meaningful" (i.e. the section is populated) when
// it holds at least one non-empty, non-false, non-sentinel value. Mirrors the
// frontend hasMeaningfulProfileValue so the plan agrees with the UI's
// "Captured" / "Pending" badges and the completion bar.
const TODO_SENTINEL_VALUES = new Set(['', 'unknown', 'n/a', 'none', 'null', 'undefined'])

export function todoHasMeaningfulValue(value) {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') {
    return !TODO_SENTINEL_VALUES.has(value.trim().toLowerCase())
  }
  if (Array.isArray(value)) return value.some(todoHasMeaningfulValue)
  if (typeof value === 'object') return Object.values(value).some(todoHasMeaningfulValue)
  return true // numbers, true
}

export function todoSectionIsComplete(data) {
  if (!data || typeof data !== 'object') return false
  return Object.values(data).some(todoHasMeaningfulValue)
}

// Parse a deadline string the LLM returned. Returns a Date or null. We only
// treat clearly-dated values (anything with a 4-digit year that Date can parse)
// as dates; vague timeframes ("within 2 weeks", "ASAP") stay as-is.
export function parseTodoDeadline(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/\d{4}/.test(trimmed)) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d
}

export function formatTodoDate(date) {
  // YYYY-MM-DD in UTC for stability.
  return date.toISOString().slice(0, 10)
}

// Recompute a sensible future deadline relative to `today`, spaced by priority,
// so a freshly generated plan never emits an already-overdue date.
export function futureDeadlineFor(priority, today) {
  const offsets = { critical: 7, high: 14, medium: 30, low: 60 }
  const days = offsets[String(priority || 'medium').toLowerCase()] ?? 30
  const d = new Date(today.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return formatTodoDate(d)
}

// Should a "complete this section" todo be suppressed because the section it
// targets is already populated? Only suppresses items that clearly ask the user
// to FILL IN the section (not real-world actions that merely reference it).
export function todoTargetsCompleteSection(item, completeSectionKeys) {
  const section = String(item?.profile_section || '').trim().toLowerCase()
  if (!section) return false
  if (!completeSectionKeys.has(section)) return false
  const title = String(item?.title || '').toLowerCase()
  const fillVerbs = /(complete|fill (in|out)|finish|add|provide|update|enter|populate)/
  return fillVerbs.test(title)
}

/**
 * Post-process the LLM checklist so it is anchored to `today` and honest about
 * completion: drop "complete an already-complete section" items, and rewrite any
 * past-dated deadline into a future offset by priority.
 *
 * @param {object} todo - parsed LLM output ({ categories: [...] })
 * @param {{ today: Date, completeSectionKeys: Set<string> }} opts
 */
export function sanitizeTodoPlan(todo, { today, completeSectionKeys }) {
  if (!todo || typeof todo !== 'object' || !Array.isArray(todo.categories)) return todo
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  let total = 0
  todo.categories = todo.categories
    .map((cat) => {
      if (!cat || !Array.isArray(cat.items)) return cat
      const items = cat.items.filter((item) => !todoTargetsCompleteSection(item, completeSectionKeys))
      for (const item of items) {
        const parsed = parseTodoDeadline(item.deadline)
        if (parsed && parsed < startOfToday) {
          item.deadline = futureDeadlineFor(item.priority, startOfToday)
        }
      }
      total += items.length
      return { ...cat, items }
    })
    .filter((cat) => Array.isArray(cat.items) && cat.items.length > 0)
  todo.total_items = total
  todo.generated_date = formatTodoDate(startOfToday)
  return todo
}
