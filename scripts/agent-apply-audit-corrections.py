from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one replacement target, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")
    print(f"wrote {path}")


# 1. Hamilton's task list must honor a requested profile for non-admin users.
replace_once(
    "backend/routes/hamiltonAutomation.js",
    """} from '../services/hamilton/applicationTaskStore.js'\nimport {\n  automateSelected,""",
    """} from '../services/hamilton/applicationTaskStore.js'\nimport { listScopedHamiltonTasks } from '../services/hamilton/hamiltonTaskListing.js'\nimport {\n  automateSelected,""",
)

replace_once(
    "backend/routes/hamiltonAutomation.js",
    """  try {\n    let tasks\n    if (req.ctx?.isAdmin === true && profileIdParam) {\n      tasks = await listApplicationTasks(req.db, { profileId: String(profileIdParam), status, limit: 200 })\n    } else if (req.ctx?.isAdmin === true) {\n      tasks = await listApplicationTasks(req.db, { status, limit: 200 })\n    } else {\n      const accessible = await getAccessibleProfileIds(req.db, user)\n      if (!accessible || accessible.size === 0) return res.json({ ok: true, tasks: [] })\n      const all = []\n      for (const pid of accessible) {\n        const some = await listApplicationTasks(req.db, { profileId: pid, status, limit: 200 })\n        all.push(...some)\n      }\n      tasks = all\n    }\n    if (automationType) {""",
    """  try {\n    const accessibleProfileIds = req.ctx?.isAdmin === true\n      ? null\n      : await getAccessibleProfileIds(req.db, user)\n\n    const scoped = await listScopedHamiltonTasks({\n      isAdmin: req.ctx?.isAdmin === true,\n      requestedProfileId: profileIdParam,\n      accessibleProfileIds,\n      status,\n      limit: 200,\n      listTasks: (opts) => listApplicationTasks(req.db, opts),\n    })\n\n    if (scoped.forbidden) {\n      return res.status(403).json({ error: 'forbidden' })\n    }\n\n    let tasks = scoped.tasks\n    if (automationType) {""",
)

write(
    "backend/services/hamilton/hamiltonTaskListing.js",
    """/**\n * Canonical scope resolver for Hamilton's task-list endpoint.\n *\n * A requested profile is a filter, not a hint: a non-admin may see that one\n * profile when accessible, gets 403 when inaccessible, and only receives the\n * aggregate of all accessible profiles when no profile was requested.\n */\nexport async function listScopedHamiltonTasks({\n  isAdmin = false,\n  requestedProfileId = null,\n  accessibleProfileIds = new Set(),\n  status = null,\n  limit = 200,\n  listTasks,\n} = {}) {\n  if (typeof listTasks !== 'function') {\n    throw new TypeError('listTasks is required')\n  }\n\n  const requested = requestedProfileId ? String(requestedProfileId) : null\n\n  // `null` is the DB-backed global-access sentinel returned for admins.\n  if (isAdmin || accessibleProfileIds === null) {\n    const tasks = await listTasks({\n      ...(requested ? { profileId: requested } : {}),\n      status,\n      limit,\n    })\n    return { forbidden: false, tasks: Array.isArray(tasks) ? tasks : [] }\n  }\n\n  const accessible = accessibleProfileIds instanceof Set\n    ? new Set([...accessibleProfileIds].map(String))\n    : new Set((Array.isArray(accessibleProfileIds) ? accessibleProfileIds : []).map(String))\n\n  if (accessible.size === 0) return { forbidden: false, tasks: [] }\n\n  if (requested) {\n    if (!accessible.has(requested)) return { forbidden: true, tasks: [] }\n    const tasks = await listTasks({ profileId: requested, status, limit })\n    return { forbidden: false, tasks: Array.isArray(tasks) ? tasks : [] }\n  }\n\n  const tasks = []\n  for (const profileId of accessible) {\n    const rows = await listTasks({ profileId, status, limit })\n    if (Array.isArray(rows)) tasks.push(...rows)\n  }\n  return { forbidden: false, tasks }\n}\n\nexport default { listScopedHamiltonTasks }\n""",
)


# 2. A completed draft is not a verified submission.
replace_once(
    "backend/routes/grantApplications.js",
    """} from '../utils/accessControl.js'\n\nimport { createLogger } from '../utils/logger.js'""",
    """} from '../utils/accessControl.js'\nimport { mapHamiltonStatus } from '../services/hamilton/applicationStatusPresentation.js'\n\nimport { createLogger } from '../utils/logger.js'""",
)

replace_once(
    "backend/routes/grantApplications.js",
    """// Map a Hamilton application_tasks.status to the tracker's status vocabulary.\nfunction mapHamiltonStatus(taskStatus) {\n  const s = String(taskStatus || '')\n  if (s === 'submitted') return 'submitted'\n  if (s === 'completed' || s === 'completed_draft' || s === 'draft_completed') return 'submitted'\n  if (s === 'cancelled') return 'withdrawn'\n  // Everything else still in flight (queued/analyzing/filling_portal/generating/\n  // waiting_for_review/ready_to_print_mail/ready_to_fax/blocked_*/failed/…) is\n  // an in-progress application from the tracker's point of view.\n  return 'in_progress'\n}\n\n""",
    """// Hamilton task status mapping lives in applicationStatusPresentation.js so\n// every tracker uses the same evidence-backed definition of "submitted".\n\n""",
)

replace_once(
    "backend/routes/grantApplications.js",
    "status: mapHamiltonStatus(r.task_status),",
    "status: mapHamiltonStatus(r),",
)

write(
    "backend/services/hamilton/applicationStatusPresentation.js",
    """/**\n * Map a Hamilton task to the grant-application tracker's vocabulary.\n *\n * `completed`, `completed_draft`, and `draft_completed` mean Hamilton produced\n * an artifact. They do not prove delivery. A submission requires both the\n * explicit submitted state and a persisted submitted_at timestamp.\n */\nexport function mapHamiltonStatus(task = {}) {\n  const rawStatus = typeof task === 'string'\n    ? task\n    : task?.task_status ?? task?.status ?? ''\n  const status = String(rawStatus)\n  const submittedAt = typeof task === 'string'\n    ? null\n    : task?.submitted_at ?? task?.submittedAt ?? null\n\n  if (status === 'submitted' && submittedAt) return 'submitted'\n  if (status === 'cancelled') return 'withdrawn'\n  return 'in_progress'\n}\n\nexport default { mapHamiltonStatus }\n""",
)


# 3. Amy must use one definition of a false positive and sweep the live scale.
replace_once(
    "backend/services/amy/crawlerMetrics.js",
    "import { ACCEPT_SCORE } from '../../config/matchThresholds.js'",
    """import {\n  ACCEPT_SCORE,\n  DISCOVERY_MIN_SCORE_FLOOR,\n  STRONG_MATCH_SCORE,\n} from '../../config/matchThresholds.js'""",
)

replace_once(
    "backend/services/amy/crawlerMetrics.js",
    """function num(v) {\n  const n = Number(v)\n  return Number.isFinite(n) ? n : 0\n}\n\n""",
    """function num(v) {\n  const n = Number(v)\n  return Number.isFinite(n) ? n : 0\n}\n\n/**\n * The same false-positive rule used by Amy's per-profile finding generator:\n * generic-only, non-locator, and still certified ACCEPT. A generic directory\n * is a resource pointer, not a false-positive award; it also does not count as\n * direct funding coverage below.\n */\nexport function candidateIsFalsePositive(candidate) {\n  const genericOnly = candidate?.genericOnly === true ||\n    (candidate?.genericOnly == null && candidate?.generic === true)\n  return genericOnly && candidate?.locator !== true &&\n    String(candidate?.decision || '').toUpperCase() === 'ACCEPT'\n}\n\n""",
)

replace_once(
    "backend/services/amy/crawlerMetrics.js",
    """  // A \"real\" qualified match = qualified AND not a generic/directory false-positive.\n  const real = qualified.filter((c) => !c.generic)\n  const falsePositives = qualified.filter((c) => c.generic)\n  return {\n    qualified: qualified.length,\n    accepted: real.length,\n    falsePositives: falsePositives.length,\n    covered: real.length > 0,\n  }""",
    """  // Direct funding coverage excludes locator resources. Locators remain useful\n  // and are not false positives, but a pointer alone must not make a profile\n  // count as funded/covered.\n  const falsePositives = qualified.filter(candidateIsFalsePositive)\n  const real = qualified.filter((c) => c?.locator !== true && !candidateIsFalsePositive(c))\n  const resources = qualified.filter((c) => c?.locator === true)\n  return {\n    qualified: qualified.length,\n    accepted: real.length,\n    resources: resources.length,\n    falsePositives: falsePositives.length,\n    covered: real.length > 0,\n  }""",
)

replace_once(
    "backend/services/amy/crawlerMetrics.js",
    """ * @param {object} [opts] { min=50, max=90, step=5 }\n * @returns {{ sweep: object[], best: object }}\n */\nexport function sweepFloors(evaluations, { min = 50, max = 90, step = 5 } = {}) {""",
    """ * @param {object} [opts] defaults to the current data-point scale\n * @returns {{ sweep: object[], best: object }}\n */\nexport function sweepFloors(evaluations, {\n  min = DISCOVERY_MIN_SCORE_FLOOR,\n  max = STRONG_MATCH_SCORE + 10,\n  step = 1,\n} = {}) {""",
)

replace_once(
    "backend/services/amy/crawlerMetrics.js",
    "export default { profileOutcomeAtFloor, cohortMetricsAtFloor, sweepFloors, summarizeCohort, FALSE_POSITIVE_PENALTY }",
    "export default { candidateIsFalsePositive, profileOutcomeAtFloor, cohortMetricsAtFloor, sweepFloors, summarizeCohort, FALSE_POSITIVE_PENALTY }",
)


# 4. Direct funding and directory resources must be counted separately.
replace_once(
    "backend/routes/fundingSources.js",
    """import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'\nimport { SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } from '../config/matchSurfacing.js'""",
    """import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'\nimport { partitionFundingSources } from '../services/matching/fundingSourcePresentation.js'\nimport { SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } from '../config/matchSurfacing.js'""",
)

replace_once(
    "backend/routes/fundingSources.js",
    """    const qualified = sources.filter((s) => qualifiesForDisplay(s, minScore))\n    return res.json({\n      profile_id: profileId,\n      engine: 'crawler-os',\n      min_score: minScore,\n      total: qualified.length,\n      // Honest grouping for the owner: apply-now vs worth-a-look vs directories.\n      best_matches: qualified.filter((s) => String(s.match_decision).toLowerCase() === 'accept' && !s.is_directory),\n      worth_reviewing: qualified.filter((s) => String(s.match_decision).toLowerCase() === 'review' && !s.is_directory),\n      directories: qualified.filter((s) => s.is_directory),\n      sources: qualified,\n      geo_stubs_hidden: geoStubsHidden,\n    })""",
    """    const qualified = sources.filter((s) => qualifiesForDisplay(s, minScore))\n    const presented = partitionFundingSources(qualified)\n    return res.json({\n      profile_id: profileId,\n      engine: 'crawler-os',\n      min_score: minScore,\n      ...presented,\n      geo_stubs_hidden: geoStubsHidden,\n    })""",
)

write(
    "backend/services/matching/fundingSourcePresentation.js",
    """/**\n * Partition a profile's surfaced results into direct funding and resources.\n * Directories remain visible, but never inflate the owner's funding-source\n * count or the general `sources` collection.\n */\nexport function partitionFundingSources(sources = []) {\n  const list = Array.isArray(sources) ? sources : []\n  const directories = list.filter((source) => source?.is_directory === true)\n  const directSources = list.filter((source) => source?.is_directory !== true)\n\n  return {\n    total: directSources.length,\n    sources: directSources,\n    best_matches: directSources.filter(\n      (source) => String(source?.match_decision || '').toLowerCase() === 'accept',\n    ),\n    worth_reviewing: directSources.filter(\n      (source) => String(source?.match_decision || '').toLowerCase() === 'review',\n    ),\n    directories,\n    resource_count: directories.length,\n  }\n}\n\nexport default { partitionFundingSources }\n""",
)


# 5. The canonical engine itself must never certify a directory as a direct ACCEPT.
replace_once(
    "backend/services/matchEngine.js",
    """import {\n  buildProfileDataPointInventory,\n  evaluateDataPointMatches,\n} from './profileDataPoints.js'""",
    """import {\n  buildProfileDataPointInventory,\n  evaluateDataPointMatches,\n} from './profileDataPoints.js'\nimport { guardDirectFundingDecision } from './matching/resourceDecisionGuard.js'""",
)

replace_once(
    "backend/services/matchEngine.js",
    """  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used\n  let { decision, explanation, reasons: decisionReasons } = makeDecision(finalScore, rawProfile, rawOpportunity, profileNorm, signalsForScoring ?? signals, oppNorm)\n\n  // Post-decision guards\n  const hasUrl = Boolean(rawOpportunity?.application_url || rawOpportunity?.url)""",
    """  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used\n  let { decision, explanation, reasons: decisionReasons } = makeDecision(finalScore, rawProfile, rawOpportunity, profileNorm, signalsForScoring ?? signals, oppNorm)\n\n  // A directory/referral can be useful, but it is not a direct award. Enforce\n  // that distinction in the canonical engine so every caller gets the same\n  // decision, not only the crawler-os compatibility facade.\n  const opportunityKind = String(\n    effectiveOpp?.opportunity_kind ??\n    rawOpportunity?.opportunity_kind ??\n    rawOpportunity?.opportunity_type ??\n    rawOpportunity?.type ??\n    '',\n  ).toUpperCase()\n  const guardedDecision = guardDirectFundingDecision({\n    decision,\n    explanation,\n    reasons: decisionReasons,\n    isDirectoryResource: Boolean(oppNorm?.isDirectory) ||\n      ['DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL'].includes(opportunityKind),\n  })\n  decision = guardedDecision.decision\n  explanation = guardedDecision.explanation\n  decisionReasons = guardedDecision.reasons\n\n  // Post-decision guards\n  const hasUrl = Boolean(rawOpportunity?.application_url || rawOpportunity?.url)""",
)

write(
    "backend/services/matching/resourceDecisionGuard.js",
    """/**\n * A locator/resource may be shown at REVIEW, but may never claim the direct\n * funding certification represented by ACCEPT. Kept pure so the invariant is\n * independently testable and reusable by any future scoring facade.\n */\nexport function guardDirectFundingDecision({\n  decision,\n  explanation,\n  reasons = [],\n  isDirectoryResource = false,\n} = {}) {\n  if (String(decision || '').toUpperCase() !== 'ACCEPT' || !isDirectoryResource) {\n    return { decision, explanation, reasons: Array.isArray(reasons) ? reasons : [] }\n  }\n\n  return {\n    decision: 'REVIEW',\n    explanation: 'This is a directory or referral resource, not a direct funding opportunity.',\n    reasons: [\n      ...(Array.isArray(reasons) ? reasons : []),\n      'Directory locator cannot be certified as a direct funding match',\n    ],\n  }\n}\n\nexport default { guardDirectFundingDecision }\n""",
)


# Regression suite for all five audited defects.
write(
    "backend/tests/remainingAuditCorrections.test.js",
    """import { describe, expect, it, vi } from 'vitest'\nimport { listScopedHamiltonTasks } from '../services/hamilton/hamiltonTaskListing.js'\nimport { mapHamiltonStatus } from '../services/hamilton/applicationStatusPresentation.js'\nimport {\n  candidateIsFalsePositive,\n  profileOutcomeAtFloor,\n  sweepFloors,\n} from '../services/amy/crawlerMetrics.js'\nimport { partitionFundingSources } from '../services/matching/fundingSourcePresentation.js'\nimport { guardDirectFundingDecision } from '../services/matching/resourceDecisionGuard.js'\nimport {\n  DISCOVERY_MIN_SCORE_FLOOR,\n  STRONG_MATCH_SCORE,\n} from '../config/matchThresholds.js'\n\ndescribe('remaining 2026-07-28 production-audit corrections', () => {\n  describe('Hamilton task scoping', () => {\n    it('honors an accessible requested profile instead of aggregating every profile', async () => {\n      const listTasks = vi.fn(async ({ profileId }) => [{ id: `task-${profileId}`, profile_id: profileId }])\n      const result = await listScopedHamiltonTasks({\n        requestedProfileId: 'p1',\n        accessibleProfileIds: new Set(['p1', 'p2']),\n        listTasks,\n      })\n\n      expect(result.forbidden).toBe(false)\n      expect(result.tasks).toEqual([{ id: 'task-p1', profile_id: 'p1' }])\n      expect(listTasks).toHaveBeenCalledTimes(1)\n      expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1' }))\n    })\n\n    it('refuses a requested profile outside the caller access set', async () => {\n      const listTasks = vi.fn()\n      const result = await listScopedHamiltonTasks({\n        requestedProfileId: 'p3',\n        accessibleProfileIds: new Set(['p1', 'p2']),\n        listTasks,\n      })\n\n      expect(result).toEqual({ forbidden: true, tasks: [] })\n      expect(listTasks).not.toHaveBeenCalled()\n    })\n\n    it('aggregates accessible profiles only when no profile filter was requested', async () => {\n      const listTasks = vi.fn(async ({ profileId }) => [{ id: `task-${profileId}`, profile_id: profileId }])\n      const result = await listScopedHamiltonTasks({\n        accessibleProfileIds: new Set(['p1', 'p2']),\n        listTasks,\n      })\n\n      expect(result.tasks.map((task) => task.profile_id)).toEqual(['p1', 'p2'])\n      expect(listTasks).toHaveBeenCalledTimes(2)\n    })\n  })\n\n  describe('submission evidence', () => {\n    it('does not call a completed draft submitted', () => {\n      expect(mapHamiltonStatus({ task_status: 'completed_draft' })).toBe('in_progress')\n      expect(mapHamiltonStatus({ task_status: 'draft_completed' })).toBe('in_progress')\n      expect(mapHamiltonStatus({ task_status: 'completed' })).toBe('in_progress')\n    })\n\n    it('requires submitted_at before reporting submitted', () => {\n      expect(mapHamiltonStatus({ task_status: 'submitted', submitted_at: null })).toBe('in_progress')\n      expect(mapHamiltonStatus({ task_status: 'submitted', submitted_at: '2026-07-28T20:00:00Z' })).toBe('submitted')\n    })\n  })\n\n  describe('Amy metric integrity', () => {\n    it('uses the same narrow false-positive rule as the finding generator', () => {\n      const falsePositive = { score: 12, decision: 'ACCEPT', genericOnly: true, locator: false }\n      const locator = { score: 12, decision: 'REVIEW', genericOnly: true, locator: true }\n      const direct = { score: 12, decision: 'ACCEPT', genericOnly: false, locator: false }\n\n      expect(candidateIsFalsePositive(falsePositive)).toBe(true)\n      expect(candidateIsFalsePositive(locator)).toBe(false)\n\n      const outcome = profileOutcomeAtFloor({ candidates: [falsePositive, locator, direct] }, 8)\n      expect(outcome).toEqual({\n        qualified: 3,\n        accepted: 1,\n        resources: 1,\n        falsePositives: 1,\n        covered: true,\n      })\n    })\n\n    it('sweeps the active data-point scale, not the retired 50-90 scale', () => {\n      const result = sweepFloors([{ candidates: [{ score: 10, decision: 'ACCEPT' }] }])\n      expect(result.sweep[0].floor).toBe(DISCOVERY_MIN_SCORE_FLOOR)\n      expect(result.sweep.at(-1).floor).toBe(STRONG_MATCH_SCORE + 10)\n    })\n  })\n\n  describe('funding versus resources', () => {\n    it('keeps directories visible without inflating the funding-source total', () => {\n      const direct = { id: 'direct', match_decision: 'accept', is_directory: false }\n      const directory = { id: 'directory', match_decision: 'review', is_directory: true }\n      const result = partitionFundingSources([direct, directory])\n\n      expect(result.total).toBe(1)\n      expect(result.sources).toEqual([direct])\n      expect(result.best_matches).toEqual([direct])\n      expect(result.directories).toEqual([directory])\n      expect(result.resource_count).toBe(1)\n    })\n\n    it('demotes a directory ACCEPT at the canonical decision boundary', () => {\n      const result = guardDirectFundingDecision({\n        decision: 'ACCEPT',\n        explanation: 'Strong match',\n        reasons: ['score above threshold'],\n        isDirectoryResource: true,\n      })\n\n      expect(result.decision).toBe('REVIEW')\n      expect(result.explanation).toMatch(/directory or referral/i)\n      expect(result.reasons).toContain('Directory locator cannot be certified as a direct funding match')\n    })\n  })\n})\n""",
)

print("all audit corrections staged")
