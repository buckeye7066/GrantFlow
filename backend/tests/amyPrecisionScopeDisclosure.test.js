/**
 * A metric that cannot see a defect class must say so, not report zero.
 *
 * MEASURED (purpose audit 2026-08-21, local corpus C:\mnt\data\grantflow.db).
 * The College/University profile's top surfaced result was "Commercial Fishing
 * Occupational Safety Training Project Grants (T03)" at ACCEPT 59, with
 * "Brookwood-Sago Mine Safety Grants" at ACCEPT 43. Amy scored that same run
 * `false_positives: 0, quality_score: 1.0`. Her metric and an eyeball disagree,
 * and the metric is the one that is wrong.
 *
 * WHY IT CANNOT SEE THEM. `candidateIsFalsePositive` fires only on
 * `genericOnly` candidates — rows whose TITLE matches the twenty directory
 * phrases in `config/genericTitleVocabulary.js` ('directory', 'grant search',
 * 'resource guide', …). It is a self-consistency check on the generic-title cap.
 * A specifically-titled but topically-irrelevant ACCEPT contains none of those
 * phrases, so it can never be counted — and worse, it lands in `real`, which
 * makes it COUNT AS COVERAGE and drives `quality_score` to 1.0.
 *
 * The registry says this out loud already — `findingActorRegistry.js`:
 *
 *     [FINDING_TYPES.BAD_MATCH]: {
 *       lever: 'relevance_precision',
 *       emitted: false,
 *       note: 'No detector emits this. The false_positive detector subsumed it
 *              when the generic-only cap shipped.',
 *     }
 *
 * …but that admission lived only in a source comment. It never reached the run
 * artifact, the cohort metrics, or the console tile that shows the owner
 * "quality 1.0". So the number reads as "precision is perfect" when what it
 * actually means is "the generic-title cap did not leak".
 *
 * WHAT IS FIXED HERE. The disclosure is DERIVED FROM THE REGISTRY, not
 * hand-written: any finding type declared with `emitted: false` is published
 * alongside the metric as unmeasured. Build the `bad_match` detector and flip
 * `emitted: true`, and the disclosure disappears on its own — it can never go
 * stale, and a second undetected class can never be added silently.
 *
 * This changes no score and weakens no gate. It makes the metric stop implying
 * a measurement it never took.
 */
import { describe, it, expect } from 'vitest'
import {
  unmeasuredFindingTypes,
  PRECISION_SCOPE,
} from '../services/amy/findingActorRegistry.js'
import { cohortMetricsAtFloor, summarizeCohort } from '../services/amy/crawlerMetrics.js'

describe('Amy precision metric discloses its own scope', () => {
  it('names every finding type declared with no detector', () => {
    const unmeasured = unmeasuredFindingTypes()
    expect(Array.isArray(unmeasured)).toBe(true)
    // bad_match is THE class the audit found: a specifically-titled ACCEPT that
    // is topically irrelevant. It is declared and undetected.
    expect(unmeasured).toContain('bad_match')
  })

  it('states what false_positives actually measures — not "precision"', () => {
    expect(PRECISION_SCOPE.false_positive_detects).toBe('generic_title_cap_leak')
    expect(PRECISION_SCOPE.relevance_measured).toBe(false)
  })

  it('cohort metrics carry the scope so quality_score cannot be read as precision', () => {
    // One clean, specifically-titled ACCEPT: the shape of the mine-safety row.
    const evaluations = [{
      scenario_id: 'college_university-v1',
      candidates: [{
        title: 'Brookwood-Sago Mine Safety Grants',
        decision: 'ACCEPT',
        score: 43,
        genericOnly: false,
        locator: false,
      }],
    }]
    const metrics = summarizeCohort(evaluations)
    // The number itself is unchanged — this is a disclosure, not a rescore.
    expect(metrics.quality_score).toBe(1)
    // …but it can no longer be mistaken for a relevance measurement.
    expect(metrics.relevance_measured).toBe(false)
    expect(metrics.false_positive_scope).toBe('generic_title_cap_leak')
    expect(metrics.unmeasured_finding_types).toContain('bad_match')
  })

  it('cohortMetricsAtFloor carries the same disclosure', () => {
    const m = cohortMetricsAtFloor([], 11)
    expect(m.relevance_measured).toBe(false)
    expect(m.unmeasured_finding_types).toContain('bad_match')
  })
})
