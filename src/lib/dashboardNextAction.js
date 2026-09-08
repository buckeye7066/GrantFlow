import { canonicalStage } from '../../shared/pipelineStages.js'
import { bucketForTaskStatus, normaliseTaskStatus } from '../../shared/hamiltonTaskLifecycle.js'

export const HIDDEN_END_USER_ROUTES = Object.freeze(['Automation', 'MyProfiles'])
const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
const rows = (value) => Array.isArray(value) ? value.filter((row) => row?.id !== null && row?.id !== undefined) : []

/** Presentation only. Never starts work or substitutes for server authorization.
 * User attention > deadline > ongoing work > profile gaps > saved > discovery.
 * Loading/error are NOT zero. The admin policy remains backward compatible.
 */
export function pickDashboardNextAction({
  completionPct = 0, savedCount = 0, activeCount = 0, urgentCount = 0,
  isSimplified = false, profileId, nextSectionKey = null, nextSectionTitle = null,
  missingLocation = false, grants = [], urgentGrants = [], tasks = [],
  dataState = 'ready', savedState = 'ready', taskState = 'ready',
} = {}) {
  if (!isSimplified) {
    if (completionPct < 40) return { key: 'complete_profile', label: 'Complete your profile for better matches', route: 'MyProfiles' }
    if (!count(savedCount) && !count(activeCount)) return { key: 'discover', label: 'Discover grants matched to your profile', route: 'DiscoverGrants' }
    if (count(urgentCount)) return deadlineAction(urgentCount)
    if (count(savedCount) && !count(activeCount)) return savedAction()
    return null
  }
  if (profileId === null) return {
    key: 'profile_unavailable', label: 'Open profile help', route: 'Help',
    description: 'No active profile is available. Check your account or use Help to recover access. No profile work has been started.',
  }
  if (dataState !== 'ready') return {
    key: dataState === 'error' ? 'load_error' : 'loading', route: 'Dashboard',
    label: dataState === 'error' ? 'Try loading your work again' : 'Checking your next step',
    description: dataState === 'error' ? 'Your saved work could not be checked. It has not been treated as empty.' : 'Checking your profile and applications before recommending an action.',
  }
  const scoped = (items) => rows(items).filter((row) => !profileId || String(row.profile_id) === String(profileId))
  const work = scoped(tasks)
  const taskLink = (task, key, label, description) => ({
    key, label, description, route: 'Pipeline',
    params: task.grant_id ? { grant_id: String(task.grant_id) } : {},
    href: '/HamiltonTask/' + encodeURIComponent(String(task.id)), taskId: String(task.id),
  })
  const needsYou = work.find((task) => bucketForTaskStatus(task.status) === 'needs_you')
  if (needsYou) return taskLink(needsYou, 'needs_you', 'Review what this application needs',
    'This task needs a person to continue. Open it to see the exact question, verification, or handoff. Other authorized tools remain available.')
  if (count(urgentCount)) return deadlineAction(urgentCount, scoped(urgentGrants)[0])
  const running = work.find((task) => bucketForTaskStatus(task.status) !== 'finished')
  if (running) return taskLink(running, 'current_task', 'View your current application task',
    ['queued', 'ready', 'ready_to_start'].includes(normaliseTaskStatus(running.status))
      ? 'This task is queued, not confirmed to be running. Open its status before starting another.'
      : 'Check the recorded task status and any next action. Starting another task may be restricted until this one finishes.')
  const inProgress = scoped(grants).find((grant) => ['gathering_documents', 'drafting', 'ready_to_submit'].includes(canonicalStage(grant.status)))
  if (inProgress) return {
    key: 'continue_application', label: 'Continue your application', route: 'Pipeline',
    params: { grant_id: String(inProgress.id) },
    description: 'Continue ' + (inProgress.title || 'your saved application') + '. Your existing work stays in its application workspace.',
  }
  if (missingLocation || completionPct < 40) return {
    key: 'finish_profile', label: missingLocation ? 'Add your location for local programs' : 'Finish filling in your profile',
    route: 'ProfileDetail', usesActiveProfile: true,
    params: { ...(profileId ? { id: String(profileId) } : {}), tab: 'profile',
      ...(missingLocation ? { section: 'basic_information', field: 'zip' } : nextSectionKey ? { section: nextSectionKey } : {}) },
    description: missingLocation ? 'Your location helps identify local and state programs. You can still explore funding now.'
      : 'Continue with ' + (nextSectionTitle || 'your unanswered profile questions') + '. Optional information is not a barrier to exploring funding.',
  }
  if (savedState !== 'ready') return {
    key: 'check_saved', label: 'Check saved opportunities', route: 'SavedGrants',
    description: savedState === 'error' ? 'Saved opportunities could not be synchronized. Open them to retry; they have not been counted as missing.'
      : 'Your saved opportunities are still being checked. You can open them directly.',
  }
  if (count(savedCount)) return savedAction()
  const next = scoped(grants).find((grant) => ['discovered', 'saved', 'interested'].includes(canonicalStage(grant.status)))
  if (next) return {
    key: 'review_source', label: 'Review this funding source', route: 'Pipeline', params: { grant_id: String(next.id) },
    description: 'Review ' + (next.title || 'this source') + ' and its requirements before applying. A match is not an award or an eligibility guarantee.',
  }
  if (count(activeCount)) return {
    key: 'track_results', label: 'Track your application results', route: 'Pipeline',
    description: 'Check submitted applications, follow-up requests, and recorded outcomes. No new submission is started by opening this page.',
  }
  return {
    key: 'discover', label: 'Discover grants matched to your profile', route: 'DiscoverGrants',
    description: taskState === 'error' ? 'Task status is unavailable, but you can still explore funding. Check the task queue before starting another application.'
      : 'Search for funding using your saved profile. Review results, save useful sources, then choose an application to prepare.',
  }
}

function deadlineAction(total, grant) {
  return {
    key: 'deadlines', label: count(total) + ' deadline' + (count(total) === 1 ? '' : 's') + ' approaching: review now',
    route: 'Pipeline', ...(grant?.id !== null && grant?.id !== undefined ? { params: { grant_id: String(grant.id) } } : {}),
    description: grant?.title ? 'Review ' + grant.title + ' before its deadline.' : 'Time-sensitive work takes priority over optional profile questions.',
  }
}
function savedAction() {
  return { key: 'move_saved', label: 'Review your saved grants', route: 'SavedGrants',
    description: 'Saving is a bookmark, not an application. Review the source and requirements, then add an appropriate opportunity to your pipeline.' }
}
