import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'

import ActionLogStore from './storage/actionLogStore.js'
import AnyaRuntimeController from './runtime/anyaRuntime.js'
import adminAuth from './middleware/adminAuth.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : undefined,
    credentials: true,
  }),
)

const logStore = new ActionLogStore(path.resolve(__dirname, 'data', 'anya-log.json'), {
  maxEntries: Number(process.env.ANYA_LOG_LIMIT ?? 1000),
})
const runtime = new AnyaRuntimeController(logStore)

// Health check endpoint (no authentication required)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'grantflow-backend',
    version: '1.0.0',
  })
})

app.get('/api/anya/status', async (req, res) => {
  const status = runtime.getStatus()
  const logs = await logStore.getAll(1)
  const lastAction = logs[0] ?? null
  res.json({ ...status, lastAction })
})

app.get('/api/anya/logs', adminAuth, async (req, res, next) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10)
    const entries = await logStore.getAll(Number.isFinite(limit) ? limit : 50)
    res.json({ entries })
  } catch (error) {
    next(error)
  }
})

app.post('/api/anya/scan', adminAuth, async (req, res, next) => {
  try {
    const actor = req.anyaActor ?? 'admin'
    const payload = {
      target: req.body?.target ?? 'repository',
      autoFix: Boolean(req.body?.autoFix),
      approve: Boolean(req.body?.approve),
    }
    const result = await runtime.execute('scan', actor, payload)
    res.status(202).json({ message: 'Scan started', result })
  } catch (error) {
    next(error)
  }
})

app.post('/api/anya/crawl', adminAuth, async (req, res, next) => {
  try {
    const actor = req.anyaActor ?? 'admin'
    const payload = {
      scope: req.body?.scope ?? 'default-datasets',
      depth: Number.parseInt(req.body?.depth, 10) || 1,
    }
    const result = await runtime.execute('crawl', actor, payload)
    res.status(202).json({ message: 'Crawl started', result })
  } catch (error) {
    next(error)
  }
})

app.post('/api/anya/explain', adminAuth, async (req, res, next) => {
  try {
    const actor = req.anyaActor ?? 'admin'
    const payload = {
      context: req.body?.context ?? 'latest-scan',
    }
    const result = await runtime.execute('explain', actor, payload)
    res.status(202).json({ message: 'Explanation requested', result })
  } catch (error) {
    next(error)
  }
})

app.use((err, req, res, next) => {
  console.error('[AnyaRuntimeError]', err)
  const status = err.statusCode ?? err.status ?? 500
  res.status(status).json({ error: err.message ?? 'Unexpected error' })
})

const PORT = Number.parseInt(process.env.PORT, 10) || 4000
const HOST = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, HOST, () => {
    console.log(`Anya runtime controller listening on ${HOST}:${PORT}`)
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
    console.log(`CORS Origins: ${process.env.CORS_ORIGIN || 'not configured'}`)
  })
}

export default app

