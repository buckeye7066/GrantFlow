import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ACCEPT_SCORE,
  DEFAULT_MIN_SCORE,
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'
import { buildAnyaMatchScoutPrompt } from '../prompts/anyaMatchScout.js'

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('retired match-threshold consumer guard', () => {
  it('describes Anya recommendations with the canonical decision and data-point scale', () => {
    const prompt = buildAnyaMatchScoutPrompt()

    expect(prompt).toContain(`match_decision is ACCEPT`)
    expect(prompt).toContain(`current ACCEPT score bar begins at ${ACCEPT_SCORE}`)
    expect(prompt).toContain(`${SCORE_SCALE_ID} data-point evidence scale`)
    expect(prompt).toContain(`scout strong-match bar (${STRONG_MATCH_SCORE})`)
    expect(prompt).toContain(`"min_score": ${DEFAULT_MIN_SCORE}`)
    expect(prompt).toContain('It is not a qualification percentage, award probability, or confidence value.')
    expect(prompt).not.toMatch(/score of 85%|score is 85|"min_score": 70/)
  })

  it('keeps legacy crawler defaults and relaxation ladders out of match consumers', () => {
    const comprehensive = source('../services/comprehensiveCrawlerOptimized.js')
    const local = source('../services/localCrawler.js')
    const itemGift = source('../services/itemGiftCrawler.js')

    for (const crawler of [comprehensive, local, itemGift]) {
      expect(crawler).toContain('DEFAULT_MIN_SCORE')
      expect(crawler).toContain('RELAX_THRESHOLDS')
      expect(crawler).toMatch(/RELAX_THRESHOLDS\.filter\(\(threshold\) => threshold < requestedThreshold\)/)
    }

    expect(comprehensive).not.toMatch(/matchThreshold\s*=\s*(?:params\.match_threshold|options\.matchThreshold)\s*\|\|\s*(?:65|80)/)
    expect(comprehensive).not.toContain('[requestedThreshold, 80, 70, 60, 50, 0]')
    expect(local).not.toMatch(/match_threshold\s*\|\|\s*60/)
    expect(local).not.toContain('[requestedThreshold, 70, 60, 50, 40, 30, 0]')
    expect(itemGift).not.toMatch(/match_threshold\s*\?\?\s*55/)
    expect(itemGift).not.toContain('[requestedThreshold, 70, 60, 55, 45, 35, 0]')
    expect(itemGift).not.toMatch(/Match score:.*%/)
  })

  it('does not inject a retired floor into Robert or NOFO', () => {
    const robert = source('../crawler-os/agents/robert.js')
    const nofo = source('../routes/nofo.js')

    expect(robert).not.toMatch(/min_match_score\s*:/)
    expect(nofo).toContain("from '../config/relevanceFloor.js'")
    expect(nofo).not.toMatch(/(?:\?\?|:)\s*55\b/)
  })
})
