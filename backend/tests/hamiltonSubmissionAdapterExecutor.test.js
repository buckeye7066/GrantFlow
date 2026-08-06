import { describe, expect, it, vi } from 'vitest'

import {
  adapterAllowsUrl,
  adapterControlTextHash,
  clickReviewedSubmitControl,
  extractAdapterReceiptFromText,
  extractIdentityBoundAdapterReceipt,
  fillReviewedFieldContract,
  inspectReviewedSubmitControl,
  verifyReviewedFieldExecution,
} from '../services/hamilton/hamiltonSubmissionAdapterExecutor.js'

function adapter() {
  return {
    id: 'fixture-adapter',
    version: '1.0.0',
    portal_host: 'fixture.invalid',
    allowed_origins: ['https://fixture.invalid'],
    allowed_path_prefixes: ['/apply'],
    submit_control: {
      selector: '[data-submit]',
      exact_text_sha256: adapterControlTextHash('Submit application'),
    },
  }
}

function fakeReceiptPage(rows, { url = 'https://fixture.invalid/apply/ABC' } = {}) {
  const tracker = { nthCalls: 0 }
  return {
    receiptTracker: tracker,
    url: () => url,
    locator(selector) {
      expect(selector).toBe('[data-receipt-row]')
      return {
        count: async () => rows.length,
        evaluateAll: async (fn, contract) => fn(rows.map((row) => ({
          innerText: row.text || '',
          textContent: row.text || '',
          querySelectorAll(identitySelector) {
            expect(identitySelector).toBe('[data-application-id]')
            const count = row.identity === null || row.identity === undefined
              ? 0
              : Number(row.identityCount ?? 1)
            return Array.from({ length: count }, () => ({
              getAttribute(attribute) {
                expect(attribute).toBe('data-application-id')
                return row.identity
              },
            }))
          },
        })), contract),
        nth(index) {
          tracker.nthCalls += 1
          const row = rows[index]
          return {
            locator(identitySelector) {
              expect(identitySelector).toBe('[data-application-id]')
              return {
                count: async () => row.identity === null || row.identity === undefined ? 0 : 1,
                first: () => ({
                  getAttribute: async (attribute) => {
                    expect(attribute).toBe('data-application-id')
                    return row.identity
                  },
                }),
              }
            },
            innerText: async () => row.text || '',
          }
        },
      }
    },
  }
}

function receiptAdapter() {
  return {
    ...adapter(),
    receipt: {
      exact_labels: ['Confirmation', 'Tracking'],
      container_selector: '[data-receipt-row]',
      identity_selector: '[data-application-id]',
      identity_attribute: 'data-application-id',
    },
  }
}

function fakeSubmitPage(states, { url = 'https://fixture.invalid/apply/ABC' } = {}) {
  let inspection = 0
  let activeState = states[0]
  const clicks = []
  const elementHandle = {
    evaluate: async () => {
      activeState = states[Math.min(inspection, states.length - 1)]
      inspection += 1
      return activeState.sameNode !== false
    },
    isVisible: async () => activeState.visible !== false,
    isDisabled: async () => activeState.disabled === true,
    innerText: async () => activeState.innerText ?? '',
    getAttribute: async (name) => name === 'value'
      ? (activeState.value ?? '')
      : name === 'aria-label' ? (activeState.ariaLabel ?? '') : null,
    textContent: async () => activeState.textContent ?? '',
    click: async () => {
      if (activeState.clickThrows) throw new Error('synthetic browser disconnected')
      clicks.push(activeState.value || activeState.innerText || activeState.textContent)
    },
  }
  return {
    clicks,
    url: () => url,
    locator(selector) {
      expect(selector).toBe('[data-submit]')
      return {
        count: async () => states[0].count ?? 1,
        first: () => ({ elementHandle: async () => elementHandle }),
      }
    },
  }
}

function fieldAdapter() {
  return {
    ...adapter(),
    field_contract: {
      version: 'exact-fields-v1',
      fields: [
        { path_prefix: '/apply', selector: '[name="first_name"]', answer_key: 'first_name', control_type: 'text', transform: 'trim', required: true },
        { path_prefix: '/apply', selector: '[name="state"]', answer_key: 'state', control_type: 'select', transform: 'trim', required: true },
      ],
    },
  }
}

function fakeFieldPage() {
  const current = new Map()
  function makeHandle(selector, controlType, initial = '') {
    const handle = {
      selector, controlType, value: initial, label: initial,
      evaluate: async (fn, arg) => {
        const source = String(fn)
        if (arg === selector) return current.get(selector) === handle
        if (source.includes('selectedOptions')) return { value: handle.value, label: handle.label }
        if (source.includes('tagName')) return controlType === 'select' ? 'select' : controlType
        return undefined
      },
      isVisible: async () => true,
      isDisabled: async () => false,
      inputValue: async () => handle.value,
      fill: async (value) => { handle.value = String(value) },
      selectOption: async (option) => {
        const value = typeof option === 'object' ? option.label : option
        handle.value = String(value)
        handle.label = String(value)
      },
    }
    current.set(selector, handle)
    return handle
  }
  makeHandle('[name="first_name"]', 'text')
  makeHandle('[name="state"]', 'select')
  return {
    url: () => 'https://fixture.invalid/apply/ABC',
    locator(selector) {
      return {
        count: async () => current.has(selector) ? 1 : 0,
        first: () => ({ elementHandle: async () => current.get(selector) }),
      }
    },
    current,
    replace(selector, controlType, value) { return makeHandle(selector, controlType, value) },
  }
}

describe('reviewed Hamilton adapter executor', () => {
  it('enforces segment-boundary path prefixes', () => {
    const definition = adapter()
    expect(adapterAllowsUrl(definition, 'https://fixture.invalid/apply')).toBe(true)
    expect(adapterAllowsUrl(definition, 'https://fixture.invalid/apply/ABC')).toBe(true)
    expect(adapterAllowsUrl(definition, 'https://fixture.invalid/apply-evil')).toBe(false)
    expect(adapterAllowsUrl(definition, 'https://attacker.invalid/apply')).toBe(false)
  })

  it('counts the raw selector and rejects multiple matching submit controls', async () => {
    const page = fakeSubmitPage([{ count: 2, innerText: 'Submit application' }])
    await expect(inspectReviewedSubmitControl(page, adapter())).resolves.toMatchObject({
      matched: false,
      reason: 'submit_control_ambiguous',
    })
  })

  it('extracts a typed receipt only from the unique exact-application container', async () => {
    const page = fakeReceiptPage([
      { identity: 'APP-TARGET', text: 'Application received. Confirmation Number: CONF-123456' },
      { identity: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-999999' },
    ])
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toMatchObject({
      reference: 'CONF-123456',
      received_acknowledgement: true,
    })
  })

  it.each([
    ['only an unrelated receipt', [
      { identity: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-999999' },
    ]],
    ['multiple records for the target application', [
      { identity: 'APP-TARGET', text: 'Application received. Confirmation Number: CONF-123456' },
      { identity: 'APP-TARGET', text: 'Application received. Confirmation Number: CONF-654321' },
    ]],
    ['a dashboard receipt without an identity-bound record', [
      { identity: null, text: 'Application received. Confirmation Number: CONF-123456' },
    ]],
    ['identity and receipt split across different application rows', [
      { identity: 'APP-TARGET', text: 'Review application' },
      { identity: 'APP-OTHER', text: 'Application received. Confirmation Number: CONF-999999' },
    ]],
  ])('rejects %s', async (_label, rows) => {
    const page = fakeReceiptPage(rows)
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toBeNull()
  })

  it('takes one atomic receipt-container snapshot so a dynamic row replacement cannot splice identity and proof', async () => {
    let nthCalls = 0
    const atomicSnapshot = {
      container_count: 2,
      matching_containers: [{
        identity_match_count: 1,
        text_too_large: false,
        text: 'Review application',
      }],
    }
    const splicedReceipt = {
      locator: () => ({
        count: async () => 1,
        first() { return this },
        getAttribute: async () => 'APP-TARGET',
      }),
      innerText: async () => 'Application received. Confirmation Number: CONF-ATTACKER',
    }
    const page = {
      url: () => 'https://fixture.invalid/apply/ABC',
      locator: () => ({
        count: async () => 2,
        evaluateAll: async () => atomicSnapshot,
        nth: () => { nthCalls += 1; return splicedReceipt },
      }),
    }
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toBeNull()
    expect(nthCalls).toBe(0)
  })

  it.each([
    ['is unavailable', () => ({ count: async () => 1 })],
    ['fails in the browser task', () => ({
      count: async () => 1,
      evaluateAll: async () => { throw new Error('synthetic DOM snapshot failure') },
    })],
  ])('fails closed when atomic receipt extraction %s', async (_label, locatorForReceipt) => {
    const page = {
      url: () => 'https://fixture.invalid/apply/ABC',
      locator: () => locatorForReceipt(),
    }
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toBeNull()
  })

  it.each([
    ['an oversized identity-bound container', `Application received. Confirmation Number: CONF-123456 ${'x'.repeat(32_769)}`],
    ['an overlong confirmation reference', `Application received. Confirmation Number: C${'1'.repeat(128)}`],
    ['unsafe control characters anywhere in receipt evidence', 'Application received. Confirmation Number: CONF-123456\u0000'],
  ])('rejects %s', async (_label, text) => {
    expect(extractAdapterReceiptFromText(text, receiptAdapter())).toBeNull()
    const page = fakeReceiptPage([{ identity: 'APP-TARGET', text }])
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toBeNull()
    expect(page.receiptTracker.nthCalls).toBe(0)
  })

  it('rejects excessive receipt containers inside the atomic browser task', async () => {
    const page = fakeReceiptPage(Array.from({ length: 51 }, (_, index) => ({
      identity: index === 0 ? 'APP-TARGET' : `APP-${index}`,
      text: index === 0 ? 'Application received. Confirmation Number: CONF-123456' : 'Other application',
    })))
    await expect(extractIdentityBoundAdapterReceipt(page, receiptAdapter(), 'APP-TARGET')).resolves.toBeNull()
    expect(page.receiptTracker.nthCalls).toBe(0)
  })

  it('reads input[type=submit] value and performs one exact fenced click', async () => {
    const page = fakeSubmitPage([
      { innerText: '', value: 'Submit application' },
      { innerText: '', value: 'Submit application' },
      { innerText: '', value: 'Submit application' },
    ])
    const beforeClick = vi.fn(async () => ({ submit_dispatched_at: '2026-08-05T19:00:00.000Z' }))
    const result = await clickReviewedSubmitControl(page, adapter(), { beforeClick })
    expect(result).toMatchObject({ matched: true, committed: true, clicked: true })
    expect(beforeClick).toHaveBeenCalledTimes(1)
    expect(page.clicks).toEqual(['Submit application'])
  })

  it('does not consume the dispatch fence when the control changes before commit', async () => {
    const page = fakeSubmitPage([
      { innerText: 'Submit application' },
      { innerText: 'Accept new terms and submit' },
    ])
    const beforeClick = vi.fn(async () => ({}))
    const result = await clickReviewedSubmitControl(page, adapter(), { beforeClick })
    expect(result).toMatchObject({ matched: false, committed: false, clicked: false, reason: 'submit_control_text_changed' })
    expect(beforeClick).not.toHaveBeenCalled()
    expect(page.clicks).toHaveLength(0)
  })

  it('never clicks a control swapped after commit and reports an ambiguous committed outcome', async () => {
    const page = fakeSubmitPage([
      { innerText: 'Submit application' },
      { innerText: 'Submit application' },
      { innerText: 'Authorize recurring payment', sameNode: false },
    ])
    const beforeClick = vi.fn(async () => ({ fence_generation: 4 }))
    const result = await clickReviewedSubmitControl(page, adapter(), { beforeClick })
    expect(result).toMatchObject({
      matched: false,
      committed: true,
      clicked: false,
      reason: 'post_commit_submit_control_replaced',
    })
    expect(beforeClick).toHaveBeenCalledTimes(1)
    expect(page.clicks).toHaveLength(0)
  })

  it('keeps browser loss after durable dispatch committed and reconciliation-only', async () => {
    const page = fakeSubmitPage([
      { innerText: 'Submit application' },
      { innerText: 'Submit application' },
      { innerText: 'Submit application', clickThrows: true },
    ])
    const beforeClick = vi.fn(async () => ({ submit_dispatched_at: '2026-08-05T19:00:00.000Z' }))
    const result = await clickReviewedSubmitControl(page, adapter(), { beforeClick })
    expect(result).toMatchObject({
      matched: true,
      clicked: false,
      committed: true,
      reason: 'submit_control_click_failed',
    })
    expect(beforeClick).toHaveBeenCalledTimes(1)
    expect(page.clicks).toHaveLength(0)
  })

  it.each([
    ['cleared text value', (page) => { page.current.get('[name="first_name"]').value = '' }, 'reviewed_field_value_drift:first_name'],
    ['altered text value', (page) => { page.current.get('[name="first_name"]').value = 'Mallory' }, 'reviewed_field_value_drift:first_name'],
    ['replaced same-selector node', (page) => { page.replace('[name="first_name"]', 'text', 'Ada') }, 'reviewed_field_replaced:first_name'],
    ['changed select option', (page) => {
      const state = page.current.get('[name="state"]'); state.value = 'KY'; state.label = 'Kentucky'
    }, 'reviewed_field_value_drift:state'],
  ])('blocks final dispatch when a reviewed field has %s', async (_label, mutate, expectedReason) => {
    const fields = fakeFieldPage()
    const definition = fieldAdapter()
    const values = { first_name: 'Ada', state: 'Tennessee' }
    const execution = await fillReviewedFieldContract(fields, definition, values, { beforeFill: async () => {} })
    expect(execution.valid).toBe(true)
    mutate(fields)

    const submit = fakeSubmitPage([
      { innerText: 'Submit application' },
      { innerText: 'Submit application' },
      { innerText: 'Submit application' },
    ])
    const beforeClick = vi.fn(async () => ({}))
    const result = await clickReviewedSubmitControl(submit, definition, {
      validateBeforeCommit: () => verifyReviewedFieldExecution(fields, definition, values, execution),
      beforeClick,
    })
    expect(result).toMatchObject({ clicked: false, committed: false, reason: expectedReason })
    expect(beforeClick).not.toHaveBeenCalled()
    expect(submit.clicks).toHaveLength(0)
  })
})
