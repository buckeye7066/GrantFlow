/**
 * Group Hamilton tasks by WHAT HAPPENED, not just raw status — so an owner
 * triaging 200 tasks can act on a whole class at once (acknowledge / delete /
 * finish-with-AI) instead of reading 200 near-identical rows.
 *
 * The category is derived from the task's status + last_agent_message. Both the
 * bulk-action API (category → task set) and the triage UI (grouping) read this
 * ONE classifier so they cannot drift.
 */

// Ordered: the first matching rule wins. `test(status, msg)` where msg is the
// lower-cased last_agent_message.
const RULES = Object.freeze([
  {
    key: 'submitted',
    label: 'Submitted — awaiting decision',
    hint: 'The application went out to the funder. The award shows as pending.',
    test: (s) => s === 'submitted',
  },
  {
    key: 'verify_submission',
    label: 'Submission needs checking',
    hint: 'A submit may have gone through without captured proof — check the portal.',
    test: (s) => s === 'submission_verification_required',
  },
  {
    key: 'no_application',
    label: 'No online application found',
    hint: 'No fillable form / submission method on the page (often a funder with no online application). A manual funder-contact packet was prepared.',
    test: (s, m) => m.includes('no clear application') || m.includes('manual pathway') || m.includes('could not determine how to apply'),
  },
  {
    key: 'directory_listing',
    label: 'Directory / award listing',
    hint: 'A page that lists or points at other awards — not an application itself. The awards behind it were extracted for matching.',
    test: (s, m) => m.includes('decomposed this listing') || m.includes('listing multiple awards') || m.includes("directory or awareness resource") || m.includes('catalogued'),
  },
  {
    key: 'mail_packet',
    label: 'Mail / PDF packet (send yourself)',
    hint: 'Not browser-submittable (mail/fax/PDF, or the portal forbids automation). A completed packet is ready under Documents.',
    test: (s, m) => m.includes('printable packet') || m.includes('pdf_docx pathway') || m.includes('mail') || m.includes('forbid agent automation'),
  },
  {
    key: 'nomination_based',
    label: 'FAFSA / nomination based',
    hint: 'Awarded from FAFSA / institutional records / nomination — no application to submit. Confirm those are on file.',
    test: (s, m) => m.includes('fafsa') || m.includes('nomination') || m.includes('institutional records'),
  },
  {
    key: 'covered_by_general',
    label: 'Covered by a general application',
    hint: 'No separate application — covered by a general application already submitted.',
    test: (s, m) => m.includes('covered by the general') || m.includes('no separate application'),
  },
  {
    key: 'needs_login',
    label: 'Needs you to sign in',
    hint: 'The portal needs an authenticated session. Sign in once and save the session.',
    test: (s, m) => s === 'waiting_for_login' || s === 'blocked_login_required' || m.includes('sign in to this portal') || m.includes('authenticated session'),
  },
  {
    key: 'needs_captcha',
    label: 'CAPTCHA / security check',
    hint: 'The portal put up a CAPTCHA or a full-page security check.',
    test: (s, m) => s === 'waiting_for_captcha' || m.includes('captcha') || m.includes('blocked automated access') || m.includes('anti-bot'),
  },
  {
    key: 'ineligible',
    label: 'Not eligible / not a fit',
    hint: 'Blocked at preflight: the funding source does not meet the profile / GrantFlow rules.',
    test: (s, m) => m.includes('does not meet grantflow') || m.includes('does not meet') || m.includes('profile is missing'),
  },
  {
    key: 'drafted',
    label: 'Filled — draft saved',
    hint: 'Hamilton filled the application and saved a draft.',
    test: (s, m) => s === 'waiting_for_review' && (m.includes('saved a draft') || m.includes('finished filling')),
  },
  {
    key: 'unreachable',
    label: 'Site unreachable / error',
    hint: 'The funder site could not be reached or the run errored.',
    test: (s, m) => s === 'failed' || m.includes('could not reach') || m.includes('page crashed') || m.includes('context was destroyed'),
  },
  {
    key: 'working',
    label: 'Working now',
    hint: 'Hamilton is actively working this one.',
    test: (s) => ['queued', 'in_progress', 'filling_portal', 'ready_to_start'].includes(s),
  },
])

const FALLBACK = Object.freeze({ key: 'other', label: 'Needs your review', hint: 'Open the task for its full timeline.' })

/** Categorize one task → { key, label, hint }. */
export function categorizeHamiltonTask(task) {
  const status = String(task?.status || '').toLowerCase()
  const msg = String(task?.last_agent_message || '').toLowerCase()
  for (const rule of RULES) {
    try { if (rule.test(status, msg)) return { key: rule.key, label: rule.label, hint: rule.hint } } catch { /* skip */ }
  }
  return FALLBACK
}

/** The registry, for a UI that wants stable order + labels. */
export const HAMILTON_TASK_CATEGORIES = Object.freeze(
  [...RULES.map((r) => ({ key: r.key, label: r.label, hint: r.hint })), FALLBACK],
)

export function categoryLabel(key) {
  return HAMILTON_TASK_CATEGORIES.find((c) => c.key === key)?.label || 'Needs your review'
}
