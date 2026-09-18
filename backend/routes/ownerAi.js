import express from 'express'
import { authenticateWorker, ownerAiBroker } from '../services/ownerAi/ownerAiBroker.js'
import { isCanonicalOwner } from '../services/ownerAi/ownerAiScope.js'
export const ownerAiWorkerRouter = express.Router()
ownerAiWorkerRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  if (!authenticateWorker(req.get('authorization'))) return res.status(401).json({ error: 'unauthorized' })
  next()
})
ownerAiWorkerRouter.use(express.json({ limit: '384kb', strict: true }))
ownerAiWorkerRouter.post('/poll', (req, res) => res.json(ownerAiBroker.poll(req.body)))
ownerAiWorkerRouter.post('/result', (req, res) => res.status(ownerAiBroker.result(req.body) ? 200 : 409).json({ received: true }))
ownerAiWorkerRouter.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  res.status(400).json({ error: 'invalid_request' })
})
ownerAiWorkerRouter.use((req, res) => res.status(404).json({ error: 'not_found' }))
export const ownerAiStatusRouter = express.Router()
ownerAiStatusRouter.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!isCanonicalOwner(req)) return res.status(403).json({ error: 'forbidden' })
  res.json(ownerAiBroker.status())
})
