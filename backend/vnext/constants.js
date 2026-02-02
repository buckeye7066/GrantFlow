export const VNEXT_STATES = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  DEDUPED: 'DEDUPED',
  QUALIFIED: 'QUALIFIED',
  SCHEMA_READY: 'SCHEMA_READY',
  MAPPED: 'MAPPED',
  MISSING_RESOLVED: 'MISSING_RESOLVED',
  DRAFTING: 'DRAFTING',
  REVIEW_READY: 'REVIEW_READY',
  BOUNDARY_REACHED: 'BOUNDARY_REACHED',
})

export const VNEXT_STATE_ORDER = Object.freeze([
  VNEXT_STATES.DISCOVERED,
  VNEXT_STATES.DEDUPED,
  VNEXT_STATES.QUALIFIED,
  VNEXT_STATES.SCHEMA_READY,
  VNEXT_STATES.MAPPED,
  VNEXT_STATES.MISSING_RESOLVED,
  VNEXT_STATES.DRAFTING,
  VNEXT_STATES.REVIEW_READY,
  VNEXT_STATES.BOUNDARY_REACHED,
])

export function normalizeVNextState(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return null
  return Object.values(VNEXT_STATES).includes(raw) ? raw : null
}

export const VNEXT_TASK_STATUS = Object.freeze({
  TODO: 'todo',
  DOING: 'doing',
  BLOCKED: 'blocked',
  DONE: 'done',
})

export const VNEXT_TASK_TYPES = Object.freeze({
  GATHER_DOC: 'gather_doc',
  FILL_FIELD: 'fill_field',
  WRITE_NARRATIVE: 'write_narrative',
  BUDGET: 'budget',
  LOA: 'loa',
  PORTAL_SUBMIT: 'portal_submit',
  PRINT_PACKET: 'print_packet',
  REVIEW: 'review',
})

export const VNEXT_BOUNDARY_TYPE = Object.freeze({
  PRINT: 'print',
  PORTAL: 'portal',
  PAPER: 'paper',
  NONE: 'none',
})

