/**
 * Payment-gate PRECISION (2026-08-31). The old detector was presence-only:
 * any `input[autocomplete=cc-number]` / Stripe / Braintree iframe anywhere on
 * the page returned `{ kind: 'payment', detail: 'Payment widget visible' }` —
 * so a nonprofit's DONATION sidebar (or Stripe.js's hidden controller iframe,
 * present on any page that loads Stripe) parked real application runs as
 * payment stops (Silver Maple / Bright Lite / Lee Cockrell, owner dashboard
 * 2026-08-30). The classifier now reads the widget's own surrounding text.
 *
 * The POSTURE is unchanged: Hamilton pays for NOTHING — a genuine fee still
 * stops the run; only the false positives stop stopping it.
 */
import { describe, it, expect } from 'vitest'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { classifyPaymentWidget, detectGate } = _internal

describe('classifyPaymentWidget', () => {
  it('fee wording is a GATE, and the detail names the evidence', () => {
    const v = classifyPaymentWidget({
      texts: ['Submit your application. A $25 application fee is required to process your submission. Card number:'],
      inForm: true,
      count: 1,
    })
    expect(v.gate).toBe(true)
    expect(v.detail).toMatch(/fee/i)
    expect(v.detail).toMatch(/nothing was paid/i)
  })

  it('a DONATION sidebar is NOT a gate (the Silver Maple / Bright Lite / Lee Cockrell class)', () => {
    const v = classifyPaymentWidget({
      texts: ['Support our mission! Donate today to keep our scholarship fund alive. Give now — every contribution counts.'],
      inForm: false,
      count: 1,
    })
    expect(v.gate).toBe(false)
  })

  it('donation wording wins even when the widget technically sits inside a <form> (donation forms ARE forms)', () => {
    const v = classifyPaymentWidget({
      texts: ['Donation amount: $10 $25 $50 Other. Donate now.'],
      inForm: true,
      count: 1,
    })
    expect(v.gate).toBe(false)
  })

  it('ambiguous context INSIDE the application form stays a gate (fail toward never paying)', () => {
    const v = classifyPaymentWidget({
      texts: ['Card number CVC Expiry'],
      inForm: true,
      count: 1,
    })
    expect(v.gate).toBe(true)
  })

  it('ambiguous page chrome OUTSIDE any form is ignored (the hidden Stripe.js controller-iframe class)', () => {
    const v = classifyPaymentWidget({
      texts: [''],
      inForm: false,
      count: 1,
    })
    expect(v.gate).toBe(false)
  })

  it('an unreadable page stays a gate (conservative: a fee we cannot rule out is never silently charged past)', () => {
    expect(classifyPaymentWidget(null).gate).toBe(true)
    expect(classifyPaymentWidget({}).gate).toBe(true)
  })
})

describe('detectGate payment integration (fake page)', () => {
  const makePage = ({ paymentContext }) => ({
    url: () => 'https://funder.example.org/apply',
    title: async () => 'Apply',
    $eval: async (sel, fn) => {
      if (sel === 'body') return 'A real application page with plenty of visible content. '.repeat(60)
      throw new Error('unexpected $eval')
    },
    // page.$: only the payment selector matches on this fixture.
    $: async (sel) => (/cc-number|stripe|braintree/.test(sel) ? {} : null),
    evaluate: async () => paymentContext,
  })

  it('a donation-context widget yields NO gate at all', async () => {
    const gate = await detectGate(makePage({
      paymentContext: { count: 1, inForm: false, texts: ['Donate to support our programs — give now'] },
    }))
    expect(gate).toBeNull()
  })

  it('a fee-context widget yields the payment gate with the fee named', async () => {
    const gate = await detectGate(makePage({
      paymentContext: { count: 1, inForm: true, texts: ['A $40 application fee is required'] },
    }))
    expect(gate?.kind).toBe('payment')
    expect(gate.detail).toMatch(/fee/i)
  })
})
