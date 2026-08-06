/** Production executor for a frozen, reviewed portal submission adapter. */
import crypto from 'node:crypto'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}

const REVIEWED_FIELD_CONTROL_TYPES = new Set([
  'text', 'email', 'tel', 'number', 'date', 'textarea', 'select',
])
const RECEIPT_CONTAINER_LIMIT = 50
const RECEIPT_CONTAINER_TEXT_LIMIT = 32_768
const RECEIPT_REFERENCE_LIMIT = 128

function hasUnsafeReceiptControl(value) {
  for (const character of String(value ?? '')) {
    const code = character.charCodeAt(0)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

function normalizedPathPrefix(value) {
  const prefix = String(value || '/').replace(/\/+$/, '') || '/'
  return prefix.startsWith('/') ? prefix : null
}

function pathMatchesPrefix(path, rawPrefix) {
  const prefix = normalizedPathPrefix(rawPrefix)
  return Boolean(prefix && (prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)))
}

export function normalizeAdapterControlText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function adapterControlTextHash(value) {
  return sha256(normalizeAdapterControlText(value))
}

export function adapterAllowsUrl(adapter, portalUrl) {
  if (!adapter || !portalUrl) return false
  let parsed
  try { parsed = new URL(String(portalUrl)) } catch { return false }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || (parsed.port && parsed.port !== '443')
      || parsed.hostname.toLowerCase() !== String(adapter.portal_host || '').toLowerCase()) return false
  const origin = `https://${parsed.hostname.toLowerCase()}`
  if (!Array.isArray(adapter.allowed_origins) || !adapter.allowed_origins.map(String).includes(origin)) return false
  const path = parsed.pathname
  return Array.isArray(adapter.allowed_path_prefixes)
    && adapter.allowed_path_prefixes.some((rawPrefix) => {
      return pathMatchesPrefix(path, rawPrefix)
    })
}

function transformAdapterValue(value, transform = 'identity') {
  if (transform === 'identity') return String(value)
  if (transform === 'trim') return String(value).trim()
  if (transform === 'iso_date') {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error('reviewed_field_date_invalid')
    return new Date(parsed).toISOString().slice(0, 10)
  }
  throw new Error('reviewed_field_transform_unsupported')
}

async function readControlType(locator) {
  return locator.evaluate((element) => {
    const tag = String(element.tagName || '').toLowerCase()
    if (tag === 'textarea' || tag === 'select') return tag
    return String(element.getAttribute('type') || 'text').toLowerCase()
  }).catch(() => null)
}

async function boundElementIsCurrent(elementHandle, selector) {
  return elementHandle?.evaluate((element, expectedSelector) => {
    if (!element?.isConnected || !element.matches(expectedSelector)) return false
    const current = document.querySelectorAll(expectedSelector)
    return current.length === 1 && current[0] === element
  }, selector).catch(() => false)
}

async function readBoundFieldValue(elementHandle, controlType) {
  if (controlType === 'select') {
    return elementHandle.evaluate((element) => {
      const option = element.selectedOptions?.[0] || null
      return { value: String(element.value ?? ''), label: String(option?.textContent ?? '').trim() }
    }).catch(() => null)
  }
  return elementHandle.inputValue().catch(() => null)
}

function liveFieldValueMatches(live, expected, controlType) {
  if (controlType === 'select') {
    return Boolean(live && (String(live.value) === expected || String(live.label) === expected))
  }
  return String(live ?? '') === expected
}

export async function inspectReviewedFieldContract(page, adapter, valuesByKey = {}) {
  if (!page || !adapterAllowsUrl(adapter, page.url())) {
    return { valid: false, reason: 'adapter_path_not_allowed', fields: [], issues: ['adapter_path_not_allowed'] }
  }
  let path
  try { path = new URL(page.url()).pathname } catch { path = '/' }
  const contractFields = (adapter?.field_contract?.fields || []).filter((field) => (
    pathMatchesPrefix(path, field.path_prefix || '/')
  ))
  const issues = []
  const fields = []
  for (const field of contractFields) {
    const matches = page.locator(field.selector)
    const count = await matches.count().catch(() => 0)
    if (count !== 1) {
      issues.push(count === 0
        ? `reviewed_field_missing:${field.answer_key}`
        : `reviewed_field_ambiguous:${field.answer_key}`)
      continue
    }
    const elementHandle = await matches.first().elementHandle().catch(() => null)
    if (!elementHandle || !(await boundElementIsCurrent(elementHandle, field.selector))) {
      issues.push(`reviewed_field_replaced:${field.answer_key}`)
      continue
    }
    const visible = await elementHandle.isVisible().catch(() => false)
    const disabled = await elementHandle.isDisabled().catch(() => true)
    const controlType = await readControlType(elementHandle)
    if (!visible || disabled) issues.push(`reviewed_field_unavailable:${field.answer_key}`)
    if (!REVIEWED_FIELD_CONTROL_TYPES.has(controlType)
        || controlType !== field.control_type) issues.push(`reviewed_field_type_changed:${field.answer_key}`)
    const rawValue = valuesByKey[field.answer_key]
    const missing = rawValue === undefined || rawValue === null || String(rawValue).trim() === ''
    if (field.required === true && missing) issues.push(`reviewed_answer_missing:${field.answer_key}`)
    await elementHandle.evaluate((element, answerKey) => {
      element.setAttribute('data-hamilton-reviewed-answer-key', answerKey)
    }, String(field.answer_key)).catch(() => {
      issues.push(`reviewed_field_marker_failed:${field.answer_key}`)
    })
    fields.push({ ...field, element_handle: elementHandle, missing, control_type: controlType })
  }
  return { valid: issues.length === 0, reason: issues[0] || null, fields, issues }
}

export async function fillReviewedFieldContract(page, adapter, valuesByKey = {}, {
  beforeFill = null,
} = {}) {
  const inspected = await inspectReviewedFieldContract(page, adapter, valuesByKey)
  if (!inspected.valid) return { ...inspected, filled: [] }
  const planned = inspected.fields.filter((field) => !field.missing)
  if (planned.length > 0) {
    if (typeof beforeFill !== 'function') {
      return { valid: false, reason: 'reviewed_field_fill_guard_required', fields: inspected.fields, issues: ['reviewed_field_fill_guard_required'], filled: [] }
    }
    await beforeFill(planned.map((field) => field.answer_key))
  }
  const filled = []
  const boundFields = []
  for (const field of planned) {
    const value = transformAdapterValue(valuesByKey[field.answer_key], field.transform)
    try {
      if (!(await boundElementIsCurrent(field.element_handle, field.selector))) {
        throw new Error('reviewed_field_replaced_before_fill')
      }
      if (field.control_type === 'select') {
        try { await field.element_handle.selectOption({ label: value }) } catch { await field.element_handle.selectOption(value) }
      } else {
        await field.element_handle.fill('')
        await field.element_handle.fill(value)
      }
      const live = await readBoundFieldValue(field.element_handle, field.control_type)
      if (!liveFieldValueMatches(live, value, field.control_type)) throw new Error('reviewed_field_fill_value_mismatch')
      filled.push({ key: field.answer_key, selector_sha256: sha256(field.selector), outcome: 'filled_from_frozen_snapshot' })
      boundFields.push({
        answer_key: field.answer_key,
        selector: field.selector,
        control_type: field.control_type,
        transform: field.transform,
        required: field.required === true,
        element_handle: field.element_handle,
      })
    } catch {
      return {
        valid: false,
        reason: `reviewed_field_fill_failed:${field.answer_key}`,
        fields: inspected.fields,
        issues: [`reviewed_field_fill_failed:${field.answer_key}`],
        filled, bound_fields: boundFields,
      }
    }
  }
  return { ...inspected, filled, bound_fields: boundFields }
}

export async function verifyReviewedFieldExecution(page, adapter, valuesByKey = {}, execution = null) {
  if (!page || !adapterAllowsUrl(adapter, page.url())) {
    return { valid: false, reason: 'adapter_path_not_allowed', issues: ['adapter_path_not_allowed'] }
  }
  const boundFields = execution?.bound_fields
  if (!Array.isArray(boundFields) || boundFields.length === 0) {
    return { valid: false, reason: 'reviewed_field_execution_missing', issues: ['reviewed_field_execution_missing'] }
  }
  const issues = []
  for (const field of boundFields) {
    if (!(await boundElementIsCurrent(field.element_handle, field.selector))) {
      issues.push(`reviewed_field_replaced:${field.answer_key}`)
      continue
    }
    const visible = await field.element_handle.isVisible().catch(() => false)
    const disabled = await field.element_handle.isDisabled().catch(() => true)
    const controlType = await readControlType(field.element_handle)
    if (!visible || disabled || controlType !== field.control_type) {
      issues.push(`reviewed_field_unavailable_or_changed:${field.answer_key}`)
      continue
    }
    const rawValue = valuesByKey[field.answer_key]
    if (field.required && (rawValue === undefined || rawValue === null || String(rawValue).trim() === '')) {
      issues.push(`reviewed_answer_missing:${field.answer_key}`)
      continue
    }
    let expected
    try { expected = transformAdapterValue(rawValue, field.transform) } catch {
      issues.push(`reviewed_answer_transform_failed:${field.answer_key}`)
      continue
    }
    const live = await readBoundFieldValue(field.element_handle, field.control_type)
    if (!liveFieldValueMatches(live, expected, field.control_type)) {
      issues.push(`reviewed_field_value_drift:${field.answer_key}`)
    }
  }
  return { valid: issues.length === 0, reason: issues[0] || null, issues }
}

async function inspectBoundSubmitControl(page, adapter, elementHandle) {
  if (!elementHandle) return { matched: false, reason: 'submit_control_not_found' }
  if (!adapterAllowsUrl(adapter, page.url())) return { matched: false, reason: 'adapter_path_not_allowed' }
  const selector = adapter.submit_control.selector
  // A Playwright Locator re-resolves its selector at action time. For an
  // irreversible control that is unsafe: a portal could replace the inspected
  // button with a different node under the same selector. Prove that this
  // exact ElementHandle is still connected, still matches, and remains the
  // sole selected node before inspecting or clicking it.
  const sameUniqueNode = await elementHandle.evaluate((element, expectedSelector) => {
    if (!element?.isConnected || !element.matches(expectedSelector)) return false
    const current = document.querySelectorAll(expectedSelector)
    return current.length === 1 && current[0] === element
  }, selector).catch(() => false)
  if (!sameUniqueNode) return { matched: false, reason: 'submit_control_replaced' }
  const visible = await elementHandle.isVisible().catch(() => false)
  if (!visible) return { matched: false, reason: 'submit_control_not_visible' }
  const disabled = await elementHandle.isDisabled().catch(() => true)
  if (disabled) return { matched: false, reason: 'submit_control_disabled' }
  const innerText = await elementHandle.innerText().catch(() => '')
  const value = await elementHandle.getAttribute('value').catch(() => '')
  const ariaLabel = await elementHandle.getAttribute('aria-label').catch(() => '')
  const textContent = await elementHandle.textContent().catch(() => '')
  const text = [innerText, value, ariaLabel, textContent].map(normalizeAdapterControlText).find(Boolean) || ''
  const actualHash = adapterControlTextHash(text)
  if (actualHash !== String(adapter.submit_control.exact_text_sha256).toLowerCase()) {
    return { matched: false, reason: 'submit_control_text_changed', actual_text_sha256: actualHash }
  }
  return { matched: true, reason: null, selector, text_sha256: actualHash, element_handle: elementHandle }
}

export async function inspectReviewedSubmitControl(page, adapter) {
  if (!page || !adapter?.submit_control?.selector) return { matched: false, reason: 'adapter_submit_control_missing' }
  if (!adapterAllowsUrl(adapter, page.url())) return { matched: false, reason: 'adapter_path_not_allowed' }
  const matches = page.locator(adapter.submit_control.selector)
  const count = await matches.count().catch(() => 0)
  if (count !== 1) return { matched: false, reason: count === 0 ? 'submit_control_not_found' : 'submit_control_ambiguous' }
  const elementHandle = await matches.first().elementHandle().catch(() => null)
  return inspectBoundSubmitControl(page, adapter, elementHandle)
}

export async function clickReviewedSubmitControl(page, adapter, {
  beforeClick = null,
  validateBeforeCommit = null,
  validateAfterCommit = null,
} = {}) {
  const inspected = await inspectReviewedSubmitControl(page, adapter)
  if (!inspected.matched) return inspected
  if (typeof beforeClick !== 'function') return { matched: true, clicked: false, reason: 'pre_click_fence_required' }
  // Revalidate the SAME node at the pre-commit boundary. A portal DOM swap
  // between readiness inspection and this point remains pre-dispatch and may
  // not consume the one irreversible-action fence.
  const preCommit = await inspectBoundSubmitControl(page, adapter, inspected.element_handle)
  if (!preCommit.matched) return { ...preCommit, clicked: false, committed: false }
  if (typeof validateBeforeCommit === 'function') {
    const validation = await validateBeforeCommit().catch(() => ({ valid: false, reason: 'pre_commit_validation_failed' }))
    if (validation?.valid !== true) {
      return { matched: true, clicked: false, committed: false, reason: validation?.reason || 'pre_commit_validation_failed' }
    }
  }
  let commitResult
  try { commitResult = await beforeClick() }
  catch { return { matched: true, clicked: false, committed: false, reason: 'pre_click_fence_rejected' } }
  // Browser DOM and database fences cannot be committed atomically. Reinspect
  // the bound node once more after the durable dispatch fence and refuse to
  // click if its identity, selector, path, text, visibility, or enabled state
  // changed. This outcome is
  // intentionally ambiguous/reconciliation-required, but a changed control
  // can never receive the irreversible action.
  const atClick = await inspectBoundSubmitControl(page, adapter, inspected.element_handle)
  if (!atClick.matched) {
    return {
      ...atClick,
      clicked: false,
      committed: true,
      commit_result: commitResult,
      reason: `post_commit_${atClick.reason}`,
    }
  }
  if (typeof validateAfterCommit === 'function') {
    const validation = await validateAfterCommit().catch(() => ({ valid: false, reason: 'post_commit_validation_failed' }))
    if (validation?.valid !== true) {
      return {
        matched: true, clicked: false, committed: true, commit_result: commitResult,
        reason: `post_commit_${validation?.reason || 'validation_failed'}`,
      }
    }
  }
  try {
    await inspected.element_handle.click({ timeout: 8_000 })
    return { matched: true, clicked: true, committed: true, commit_result: commitResult, text_sha256: atClick.text_sha256 }
  } catch {
    return { matched: true, clicked: false, committed: true, commit_result: commitResult, reason: 'submit_control_click_failed', text_sha256: atClick.text_sha256 }
  }
}

const RECEIPT_ACK_RX = /\b(?:application|submission)\s+(?:has been|was|is)?\s*(?:successfully\s+)?(?:received|submitted|confirmed)\b|\bthank you for (?:your )?(?:application|submission)\b/i

function normalizeReceiptEvidenceText(value) {
  const normalized = String(value ?? '').normalize('NFKC')
  if (!normalized || normalized.length > RECEIPT_CONTAINER_TEXT_LIMIT
      || hasUnsafeReceiptControl(normalized)) return null
  return normalized.replace(/\s+/g, ' ').trim()
}

export function extractAdapterReceiptFromText(text, adapter) {
  const labels = adapter?.receipt?.exact_labels
  if (!Array.isArray(labels) || labels.length === 0) return null
  const normalizedText = normalizeReceiptEvidenceText(text)
  if (!normalizedText) return null
  const escaped = labels.map((label) => String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const match = normalizedText.match(new RegExp(
    `\\b(${escaped})\\s*(?:number|no\\.?|#|id|code)\\s*[:#.-]?\\s*([A-Za-z0-9][A-Za-z0-9-]{5,})\\b`,
    'i',
  ))
  if (!match) return null
  const reference = String(match[2] || '').normalize('NFKC')
  if (!reference || reference.length > RECEIPT_REFERENCE_LIMIT
      || hasUnsafeReceiptControl(reference)
      || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(reference)) return null
  const label = String(match[1]).toLowerCase()
  const referenceKind = label.includes('tracking') ? 'tracking'
    : label.includes('receipt') ? 'receipt'
      : label.includes('submission') ? 'submission'
        : 'confirmation'
  return {
    reference,
    reference_kind: referenceKind,
    extraction_rule: `adapter_exact_label:${label}`,
    received_acknowledgement: RECEIPT_ACK_RX.test(normalizedText),
    page_fingerprint: sha256(normalizedText),
  }
}

export async function extractIdentityBoundAdapterReceipt(page, adapter, expectedApplicationReference) {
  if (!page || !adapterAllowsUrl(adapter, page.url()) || !expectedApplicationReference) return null
  const receipt = adapter.receipt
  if (!receipt?.container_selector || !receipt?.identity_selector || !receipt?.identity_attribute) return null
  const containers = page.locator(receipt.container_selector)
  if (typeof containers?.evaluateAll !== 'function') return null
  let snapshot
  try {
    // Identity lookup and receipt text capture happen synchronously inside one
    // browser task. Never retain an nth Locator: it would re-resolve after a DOM
    // reorder and could splice one application's identity onto another receipt.
    snapshot = await containers.evaluateAll((nodes, contract) => {
      if (nodes.length < 1 || nodes.length > contract.maxContainerCount) {
        return { container_count: nodes.length, matching_containers: [] }
      }
      const matches = []
      for (const node of nodes) {
        let identities
        try { identities = node.querySelectorAll(contract.identitySelector) } catch { continue }
        if (identities.length !== 1) continue
        const identityValue = identities[0].getAttribute(contract.identityAttribute)
        if (String(identityValue || '') !== contract.expectedIdentity) continue
        const rawText = String(node.innerText || node.textContent || '')
        matches.push({
          identity_match_count: identities.length,
          text_too_large: rawText.length > contract.maxTextLength,
          text: rawText.length <= contract.maxTextLength ? rawText : '',
        })
      }
      return { container_count: nodes.length, matching_containers: matches }
    }, {
      identitySelector: receipt.identity_selector,
      identityAttribute: receipt.identity_attribute,
      expectedIdentity: String(expectedApplicationReference),
      maxTextLength: RECEIPT_CONTAINER_TEXT_LIMIT,
      maxContainerCount: RECEIPT_CONTAINER_LIMIT,
    })
  } catch { return null }
  const containerCount = Number(snapshot?.container_count || 0)
  const matching = Array.isArray(snapshot?.matching_containers)
    ? snapshot.matching_containers
    : []
  if (containerCount < 1 || containerCount > RECEIPT_CONTAINER_LIMIT
      || matching.length !== 1
      || Number(matching[0]?.identity_match_count || 0) !== 1
      || matching[0]?.text_too_large === true) return null
  return extractAdapterReceiptFromText(matching[0]?.text, adapter)
}

export function assessAdapterPostClickObservation(preClick, postClick) {
  if (!postClick?.reference || postClick.received_acknowledgement !== true) return { received: false, reason: 'typed_receipt_and_ack_required' }
  if (preClick?.reference && preClick.reference === postClick.reference) return { received: false, reason: 'reference_existed_before_submit' }
  if (!preClick?.page_fingerprint || preClick.page_fingerprint === postClick.page_fingerprint) {
    return { received: false, reason: 'unchanged_portal_state' }
  }
  return { received: true, reason: null }
}
