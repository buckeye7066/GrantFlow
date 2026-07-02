import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ensureApplicationTask, getApplicationTask, _resetSchemaCache } from '../services/hamilton/applicationTaskStore.js'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { actionableSubmitButtons } = _internal

describe('submit-hunt truthfulness gate (actionableSubmitButtons)', () => {
  const chrome = { bid: 'b0', text: 'Submit', inForm: false, formFieldCount: 0 }
  const navLink = { bid: 'b1', text: 'Apply Now', inForm: true, formFieldCount: 0 }
  const formButton = { bid: 'b2', text: 'Submit Application', inForm: true, formFieldCount: 6 }

  it('ignores submit-looking chrome/nav controls when nothing was filled', () => {
    expect(actionableSubmitButtons([chrome, navLink], { anyFieldFilled: false })).toEqual([])
  })

  it('keeps a control inside a real form with fillable fields', () => {
    expect(actionableSubmitButtons([chrome, formButton], { anyFieldFilled: false })).toEqual([formButton])
  })

  it('keeps everything when Hamilton actually filled fields this run', () => {
    expect(actionableSubmitButtons([chrome, navLink], { anyFieldFilled: true })).toEqual([chrome, navLink])
  })

  it('tolerates malformed input', () => {
    expect(actionableSubmitButtons(null, {})).toEqual([])
    expect(actionableSubmitButtons([null, {}], { anyFieldFilled: false })).toEqual([])
  })
})

describe('allow_auto_submit persistence reflects the batch option', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = new Database(':memory:')
  })

  it('persists true on insert when the batch allows auto-submit', async () => {
    const task = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g1', allowAutoSubmit: true })
    const row = await getApplicationTask(db, task.id)
    expect(Boolean(row.allow_auto_submit)).toBe(true)
  })

  it('defaults to false when the batch did not specify', async () => {
    const task = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g2' })
    const row = await getApplicationTask(db, task.id)
    expect(Boolean(row.allow_auto_submit)).toBe(false)
  })

  it('an idempotent re-ensure refreshes the stored flag to the new batch option', async () => {
    const first = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g3', allowAutoSubmit: false })
    const again = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g3', allowAutoSubmit: true })
    expect(again.id).toBe(first.id)
    const row = await getApplicationTask(db, first.id)
    expect(Boolean(row.allow_auto_submit)).toBe(true)
  })

  it('re-ensure WITHOUT the option leaves the stored value untouched', async () => {
    const first = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g4', allowAutoSubmit: true })
    await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g4' })
    const row = await getApplicationTask(db, first.id)
    expect(Boolean(row.allow_auto_submit)).toBe(true)
  })
})
