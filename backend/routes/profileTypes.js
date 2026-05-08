/**
 * profileTypes.js
 *
 * GET /api/profile-types — returns the canonical profile type registry
 * for the frontend. Backed by:
 *
 *   - shared/profileTypeOptions.js (curated, user-facing list)
 *   - backend/services/profileTypeRegistry.js (full canonical registry)
 *
 * The frontend uses this endpoint to render selectors with the same
 * labels Anya uses, so picker copy never drifts from explanation copy.
 *
 * Mission goal #4: support every profile type explicitly.
 * Mission goal #9: explainable — pickers and explanations come from
 * the same registry.
 */
import express from 'express'

import {
  PROFILE_TYPE_OPTIONS,
  PROFILE_TYPE_UI_ALIASES,
  getGroupedProfileTypeOptions,
} from '../../shared/profileTypeOptions.js'
import {
  PROFILE_TYPES,
  resolveProfileType,
  getParentChain,
  recommendStrategyFor,
  recommendedSourcesFor,
  defaultNeedsFor,
} from '../services/profileTypeRegistry.js'

const router = express.Router()

function buildEntry(option) {
  const canonical = PROFILE_TYPES[option.id] ?? null
  const id = option.id
  return {
    id,
    label: option.label,
    description: option.description,
    group: option.group,
    anya_label: canonical?.anyaLabel ?? option.label,
    summary: canonical?.summary ?? option.description,
    parent_types: getParentChain(id),
    default_needs: defaultNeedsFor(id),
    recommended_strategy: recommendStrategyFor(id),
    recommended_source_count: recommendedSourcesFor(id).length,
    canonical: !!canonical,
  }
}

router.get('/', async (_req, res) => {
  const items = PROFILE_TYPE_OPTIONS.map(buildEntry)
  const grouped = getGroupedProfileTypeOptions().map(({ group, options }) => ({
    group,
    options: options.map(buildEntry),
  }))
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
  res.json({
    items,
    grouped,
    aliases: PROFILE_TYPE_UI_ALIASES,
    total_canonical: Object.keys(PROFILE_TYPES).length,
    total_curated: items.length,
  })
})

router.get('/resolve/:raw', (req, res) => {
  const raw = String(req.params.raw || '')
  const id = resolveProfileType(raw)
  res.set('Cache-Control', 'public, max-age=300')
  if (!id) return res.json({ raw, resolved: null, canonical: false })
  const canonical = PROFILE_TYPES[id]
  res.json({
    raw,
    resolved: id,
    canonical: !!canonical,
    label: canonical?.anyaLabel ?? id,
    parent_types: getParentChain(id),
    default_needs: defaultNeedsFor(id),
    recommended_strategy: recommendStrategyFor(id),
  })
})

export default router
