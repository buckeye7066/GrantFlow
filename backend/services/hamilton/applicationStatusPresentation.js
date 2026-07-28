/**
 * Map a Hamilton task to the grant-application tracker's vocabulary.
 *
 * `completed`, `completed_draft`, and `draft_completed` mean Hamilton produced
 * an artifact. They do not prove delivery. A submission requires both the
 * explicit submitted state and a persisted submitted_at timestamp.
 */
export function mapHamiltonStatus(task = {}) {
  const rawStatus = typeof task === 'string'
    ? task
    : task?.task_status ?? task?.status ?? ''
  const status = String(rawStatus)
  const submittedAt = typeof task === 'string'
    ? null
    : task?.submitted_at ?? task?.submittedAt ?? null

  if (status === 'submitted' && submittedAt) return 'submitted'
  if (status === 'cancelled') return 'withdrawn'
  return 'in_progress'
}

export default { mapHamiltonStatus }
