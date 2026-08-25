import express from 'express'
import { ensureGrantAccess, requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import {
  exportGrantAccountingBundle,
  reconcileAccountingImport,
} from '../services/accounting/portableGrantLedger.js'

const router = express.Router()
const MAX_CSV_BYTES = 5 * 1024 * 1024

function requestError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

router.use(requireAuthenticatedUserMiddleware)

async function grantAccountingRows(req, res) {
  const grantId = String(req.params.grantId || '')
  const grant = await ensureGrantAccess(req, res, grantId)
  if (!grant) return null
  const [budgets, expenses] = await Promise.all([
    req.db.prepare('SELECT * FROM budgets WHERE grant_id = ? ORDER BY id').all(grantId),
    req.db.prepare('SELECT * FROM expenses WHERE grant_id = ? ORDER BY date, id').all(grantId),
  ])
  return { grant, budgets: budgets || [], expenses: expenses || [] }
}

router.get('/:grantId/export', async (req, res, next) => {
  try {
    const rows = await grantAccountingRows(req, res)
    if (!rows) return
    return res.json(exportGrantAccountingBundle({
      ...rows,
      provider: req.query.provider,
      currency: req.query.currency,
    }))
  } catch (error) {
    if (!error.status) error.status = 400
    return next(error)
  }
})

router.post('/:grantId/reconcile', async (req, res, next) => {
  try {
    const rows = await grantAccountingRows(req, res)
    if (!rows) return
    const csv = String(req.body?.csv ?? '')
    if (!csv) return next(requestError('csv is required'))
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      return next(requestError('accounting CSV exceeds 5 MB', 413))
    }
    return res.json(reconcileAccountingImport({
      provider: req.body?.provider,
      csv,
      expenses: rows.expenses,
    }))
  } catch (error) {
    if (!error.status) error.status = 400
    return next(error)
  }
})

export default router
