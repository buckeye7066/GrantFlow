/**
 * studentBridgeFundingCrawler.js
 *
 * Dispatcher entry point for the `student_bridge_funding` crawler job type.
 *
 * For a given profile_id:
 *   1. Build a deterministic profile context (profile + sections).
 *   2. Run expandStudentBridgeFunding() to produce per-template opportunities
 *      tied to the student's actual Fall enrollment cycle.
 *   3. For each rendered opportunity, ingest into funding_opportunities AND
 *      add to the profile's grants pipeline (idempotent on (profile_id, URL)).
 *   4. Return standard { result_count, result_meta } for the dispatcher.
 *
 * Idempotent: rerunning the job for the same profile-and-cycle adds zero
 * new rows but keeps the opportunity records fresh.
 */

import { buildProfileContext } from '../profileHelpers.js'
import { expandStudentBridgeFunding } from '../studentBridgeFunding/expander.js'
import { addBridgeOpportunityToProfilePipeline } from '../studentBridgeFunding/pipelineWriter.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('studentBridgeFunding')

export async function processStudentBridgeFundingJob({ db, job, profileContext }) {
  const profileId = job?.profile_id || profileContext?.profile?.id
  if (!profileId) {
    throw new Error('student_bridge_funding requires a profile_id')
  }

  const params =
    typeof job?.parameters === 'string' ? JSON.parse(job.parameters) : job?.parameters || {}

  // Always rebuild context fresh so we see latest profile edits.
  const ctx = profileContext || (await buildProfileContext(db, profileId))
  const profile = ctx?.profile
  if (!profile) throw new Error(`profile ${profileId} not found`)

  const expansion = expandStudentBridgeFunding({
    profile,
    sections: ctx.sections || {},
    today: params?.asOf ? new Date(params.asOf) : new Date(),
  })

  if (!expansion.isStudent) {
    log.info('Skipping non-student profile', { profile_id: profileId, reason: expansion.calendar?.reasoning })
    return {
      result_count: 0,
      result_meta: {
        is_student: false,
        reason: expansion.calendar?.reasoning?.[0] || 'no_student_signal',
      },
    }
  }

  log.info('Expanded bridge-funding catalog', {
    profile_id: profileId,
    enrollment_year: expansion.calendar.enrollmentYear,
    academic_cycle: expansion.calendar.academicCycle,
    school: expansion.school?.name || null,
    college_state: expansion.collegeState,
    college_county: expansion.collegeCounty,
    home_state: expansion.homeState,
    home_county: expansion.homeCounty,
    rendered: expansion.opportunities.length,
    skipped_templates: expansion.skippedTemplates.length,
  })

  let added = 0
  let reused = 0
  let skipped = 0
  const skipReasons = []
  const addedTitles = []

  const orgId = profile.organization_id || null

  for (const expanded of expansion.opportunities) {
    try {
      const result = await addBridgeOpportunityToProfilePipeline({
        db,
        profile,
        organizationId: orgId,
        expanded,
        defaultStatus: 'discovered',
      })
      if (result.added) {
        added += 1
        addedTitles.push(expanded.opportunity_data.title)
      } else if (result.reused) {
        reused += 1
      } else {
        skipped += 1
        skipReasons.push({ template_id: expanded.template_id, reason: result.reason })
      }
    } catch (err) {
      skipped += 1
      skipReasons.push({
        template_id: expanded.template_id,
        reason: `exception: ${err?.message || String(err)}`,
      })
      log.warn('Failed to add bridge opportunity', {
        profile_id: profileId,
        template_id: expanded.template_id,
        error: err?.message || String(err),
      })
    }
  }

  const result_meta = {
    is_student: true,
    enrollment_year: expansion.calendar.enrollmentYear,
    academic_cycle: expansion.calendar.academicCycle,
    classes_start_estimate: expansion.calendar.classesStartEstimate,
    move_in_window: expansion.calendar.moveInWindow,
    refund_window: expansion.calendar.refundWindow,
    bridge_gap_days: expansion.calendar.bridgeGapDays,
    school: expansion.school?.name || null,
    college_state: expansion.collegeState,
    college_county: expansion.collegeCounty,
    college_town: expansion.collegeTown,
    home_state: expansion.homeState,
    home_county: expansion.homeCounty,
    rendered: expansion.opportunities.length,
    added,
    reused,
    skipped,
    added_titles: addedTitles,
    skip_reasons: skipReasons,
    template_skip_reasons: expansion.skippedTemplates,
  }

  log.info('student_bridge_funding job completed', {
    profile_id: profileId,
    ...result_meta,
  })

  return {
    result_count: added + reused,
    result_meta,
  }
}
