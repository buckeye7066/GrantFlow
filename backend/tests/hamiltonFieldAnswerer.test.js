/**
 * The LLM field-understanding layer: answer an unrecognized portal field from
 * the profile, GROUNDED, never fabricated — and return null (→ ask the user)
 * when the profile can't answer it or no AI is available.
 */
import { describe, it, expect } from 'vitest'
import {
  answerUnknownField,
  isAnswerableUnknownField,
  isGroundedInProfile,
  buildProfileEvidence,
} from '../services/hamilton/hamiltonFieldAnswerer.js'

const PROFILE = {
  basic_information: { first_name: 'Jordan', last_name: 'Rivera' },
  education: { major: 'Forensic Science', current_institution: 'Middle Tennessee State University' },
  activities: { list: ['Debate team captain', 'Volunteer EMT with the county rescue squad'] },
}

// A fake LLM: returns whatever json the test seeds, mimicking invokeJsonWithFallback.
const fakeLLM = (json, { ok = true } = {}) => ({ invokeJson: async () => ({ ok, json }) })

describe('field answerer — grounding + honesty', () => {
  it('fills a free-text question with a grounded answer', async () => {
    const deps = fakeLLM({ answer: 'Jordan volunteers as an EMT with the county rescue squad and captains the debate team.', grounded_in: ['activities.list'] })
    const res = await answerUnknownField(
      { tag: 'textarea', label: 'Describe your community involvement', required: true },
      { profile: PROFILE, _deps: deps },
    )
    expect(res?.value).toMatch(/EMT|debate/i)
    expect(res?.free_text).toBe(true)
  })

  it('returns a short-fact value only when it is grounded in the profile', async () => {
    const good = await answerUnknownField(
      { tag: 'input', type: 'text', label: 'Intended major' },
      { profile: PROFILE, _deps: fakeLLM({ answer: 'Forensic Science', grounded_in: ['education.major'] }) },
    )
    expect(good?.value).toBe('Forensic Science')
  })

  it('REJECTS a short-fact answer NOT present in the profile (anti-hallucination)', async () => {
    const bad = await answerUnknownField(
      { tag: 'input', type: 'text', label: 'High school GPA' },
      // The LLM tries to invent a GPA the profile does not contain.
      { profile: PROFILE, _deps: fakeLLM({ answer: '3.95', grounded_in: [] }) },
    )
    expect(bad).toBeNull()
  })

  it('returns null when the LLM says the profile cannot answer (→ ask the user)', async () => {
    const res = await answerUnknownField(
      { tag: 'input', type: 'text', label: "Parent/guardian's employer" },
      { profile: PROFILE, _deps: fakeLLM({ answer: null, reason: 'no parent employer in profile' }) },
    )
    expect(res).toBeNull()
  })

  it('rejects a placeholder answer', async () => {
    const res = await answerUnknownField(
      { tag: 'textarea', label: 'Statement' },
      { profile: PROFILE, _deps: fakeLLM({ answer: '[INSERT YOUR STATEMENT HERE]' }) },
    )
    expect(res).toBeNull()
  })

  it('degrades to null when no AI provider is available (not-ok)', async () => {
    const res = await answerUnknownField(
      { tag: 'textarea', label: 'Essay' },
      { profile: PROFILE, _deps: { invokeJson: async () => ({ ok: false, error: 'credits exhausted' }) } },
    )
    expect(res).toBeNull()
  })

  it('only attempts text-like fields', () => {
    expect(isAnswerableUnknownField({ tag: 'textarea' })).toBe(true)
    expect(isAnswerableUnknownField({ tag: 'input', type: 'text' })).toBe(true)
    expect(isAnswerableUnknownField({ tag: 'input', type: 'checkbox' })).toBe(false)
    expect(isAnswerableUnknownField({ tag: 'select' })).toBe(false)
    expect(isAnswerableUnknownField({ tag: 'input', type: 'file' })).toBe(false)
  })

  it('grounding check: phrase-in-profile and all-content-words-present', () => {
    const evidence = buildProfileEvidence(PROFILE)
    expect(isGroundedInProfile('Forensic Science', evidence)).toBe(true)
    expect(isGroundedInProfile('Middle Tennessee State University', evidence)).toBe(true)
    expect(isGroundedInProfile('Harvard University', evidence)).toBe(false)
    expect(isGroundedInProfile('3.95', evidence)).toBe(false)
  })
})
