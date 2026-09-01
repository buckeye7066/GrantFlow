import { getMaintenanceStatus } from './maintenance/maintenanceMode.js'

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
