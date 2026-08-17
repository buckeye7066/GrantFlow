import express from 'express'
import { ensureAdmin, ensureAuth } from '../middleware/auth.js'
import {
  getOperationalMetricsSnapshot,
  renderPrometheusMetrics,
} from '../services/operationalMetrics.js'

const router = express.Router()

router.use(ensureAuth, ensureAdmin)

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    ...getOperationalMetricsSnapshot(),
  })
})

router.get('/prometheus', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(renderPrometheusMetrics())
})

export default router
