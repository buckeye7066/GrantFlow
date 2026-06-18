/**
 * Unit tests for backend/services/college/collegeFundingMerge.js
 *
 * The critical assertion: FEDERAL / FAFSA aid is ALWAYS user_confirm and never
 * appears in automatable_ids — regardless of how the classifier labels it.
 */

import { describe, it, expect } from 'vitest'
import {
  MERGE_MODE,
  planFundingItem,
  planCollegeFundingMerge,
} from '../services/college/collegeFundingMerge.js'

// Stub classifier so tests don't depend on the real classifier's heuristics.
const classifyAs = (type) => () => ({ automation_type: type })

const committedWorkspace = { committed: true, college: { id: '1', name: 'State U' } }

describe('planFundingItem', () => {
  it('maps portal → autopilot', () => {
    const r = planFundingItem({ id: 'a', title: 'Portal Grant' }, { classify: classifyAs('portal') })
    expect(r.handoff_mode).toBe(MERGE_MODE.AUTOPILOT)
    expect(r.federal).toBe(false)
  })

  it('maps pdf_docx/mail/fax/email → packet', () => {
    for (const t of ['pdf_docx', 'mail', 'fax', 'email']) {
      expect(planFundingItem({ id: t, title: t }, { classify: classifyAs(t) }).handoff_mode).toBe(MERGE_MODE.PACKET)
    }
  })

  it('maps auto_profile → user_confirm and unknown → manual', () => {
    expect(planFundingItem({ id: 'x', title: 'Institutional Aid' }, { classify: classifyAs('auto_profile') }).handoff_mode).toBe(MERGE_MODE.USER_CONFIRM)
    expect(planFundingItem({ id: 'y', title: 'Mystery' }, { classify: classifyAs('unknown') }).handoff_mode).toBe(MERGE_MODE.MANUAL)
  })

  it('FORCES federal/FAFSA to user_confirm even if classified as portal', () => {
    const r = planFundingItem({ id: 'f', title: 'FAFSA — Free Application for Federal Student Aid', url: 'https://studentaid.gov' }, { classify: classifyAs('portal') })
    expect(r.federal).toBe(true)
    expect(r.handoff_mode).toBe(MERGE_MODE.USER_CONFIRM)
    expect(r.compliance_notes.join(' ')).toMatch(/never (submits|types|bypasses)/i)
  })

  it('detects federal via direct-loan / FSA ID text too', () => {
    expect(planFundingItem({ id: '1', title: 'Direct Subsidized Loan' }, { classify: classifyAs('portal') }).federal).toBe(true)
    expect(planFundingItem({ id: '2', title: 'Sign in with your FSA ID' }, { classify: classifyAs('portal') }).federal).toBe(true)
  })
})

describe('planCollegeFundingMerge', () => {
  it('requires a committed college', () => {
    expect(planCollegeFundingMerge({ workspace: { committed: false }, selectedFunding: [] })).toEqual({ ok: false, error: 'no_committed_college' })
  })

  it('summarizes modes and excludes federal + user_confirm from automatable_ids', () => {
    const selectedFunding = [
      { id: 'p1', title: 'Portal Scholarship' },
      { id: 'k1', title: 'Mailed App' },
      { id: 'f1', title: 'FAFSA federal aid' },
      { id: 'i1', title: 'Institutional Award' },
    ]
    // classifier: p1=portal, k1=mail, f1=portal(but federal→forced), i1=auto_profile
    const classify = ({ opportunity }) => {
      const map = { p1: 'portal', k1: 'mail', f1: 'portal', i1: 'auto_profile' }
      return { automation_type: map[opportunity.id] || 'unknown' }
    }
    const plan = planCollegeFundingMerge({ workspace: committedWorkspace, selectedFunding, classify })
    expect(plan.ok).toBe(true)
    expect(plan.summary).toMatchObject({ autopilot: 1, packet: 1, user_confirm: 2 }) // f1 (federal) + i1
    expect(plan.automatable_ids).toEqual(['p1', 'k1']) // federal + institutional excluded
    expect(plan.requires_user_action).toBe(true)
    expect(plan.college).toMatchObject({ id: '1', name: 'State U' })
  })

  it('requires_user_action is false when everything is cleanly automatable', () => {
    const plan = planCollegeFundingMerge({
      workspace: committedWorkspace,
      selectedFunding: [{ id: 'p1', title: 'Portal' }],
      classify: classifyAs('portal'),
    })
    expect(plan.requires_user_action).toBe(false)
    expect(plan.automatable_ids).toEqual(['p1'])
  })
})
