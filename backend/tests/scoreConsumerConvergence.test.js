import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('thesis and startup smoke jobs use the centralized current-scale floor', async () => {
  const [thesis, background, server] = await Promise.all([
    read('crawler-os/profileIntelligence.js'),
    read('startup/backgroundServices.js'),
    read('server.js'),
  ])

  assert.match(thesis, /min_match_score:[\s\S]{0,160}: DEFAULT_MIN_SCORE,/)
  assert.doesNotMatch(thesis, /isOrg\s*\?\s*60\s*:\s*55/)
  for (const startupSource of [background, server]) {
    assert.match(startupSource, /match_threshold: DEFAULT_MIN_SCORE/)
    assert.match(startupSource, /score_scale_id: SCORE_SCALE_ID/)
    assert.doesNotMatch(startupSource, /match_threshold:\s*80/)
  }
})

test('need hints, Robert, and item crawler cannot reintroduce retired score trials', async () => {
  const [needs, robert, item] = await Promise.all([
    read('services/profileNeedsInterpreter.js'),
    read('services/robert/robertRecommendationService.js'),
    read('services/itemCrawler.js'),
  ])

  assert.doesNotMatch(needs, /minScore:\s*(?:70|65|60)\b/)
  assert.match(needs, /score_scale_id: SCORE_SCALE_ID/)

  assert.doesNotMatch(robert, /below_review_threshold/)
  assert.doesNotMatch(robert, /decision\s*===\s*MATCH_DECISION\.(?:ACCEPT|REVIEW)\s*&&\s*score\s*</)
  assert.match(robert, /score_scale_id: SCORE_SCALE_ID/)

  assert.doesNotMatch(item, /match_confidence:\s*decision\?\.confidence\s*\?\?\s*fallbackScore/)
  assert.doesNotMatch(item, /threshold[^\n]*%/i)
  assert.match(item, /score_scale_id: SCORE_SCALE_ID/)
  assert.match(item, /match_threshold_applied: false/)
})
