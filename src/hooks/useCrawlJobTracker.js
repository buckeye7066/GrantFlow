import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useCrawlJobTracker
 *
 * A tiny, reusable background-job polling helper for "fire-and-forget" crawl triggers.
 * It avoids fixed setTimeout assumptions by polling a caller-provided `poll()` until terminal.
 *
 * Job shape:
 * - key: string (unique identifier for the job)
 * - poll: async () => ({ done: boolean, status?: 'completed'|'failed', message?: string })
 * - timeoutMs?: number (default 5 minutes)
 * - onDone?: (result) => void
 */
export function useCrawlJobTracker({ pollMs = 5000 } = {}) {
  const [jobs, setJobs] = useState([])
  const jobsRef = useRef(jobs)
  const tickingRef = useRef(false)

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  const track = useCallback((job) => {
    if (!job || !job.key || typeof job.poll !== 'function') return
    const now = Date.now()
    const normalized = {
      key: String(job.key),
      poll: job.poll,
      startedAt: Number.isFinite(job.startedAt) ? job.startedAt : now,
      timeoutMs: Number.isFinite(job.timeoutMs) ? job.timeoutMs : 5 * 60 * 1000,
      onDone: typeof job.onDone === 'function' ? job.onDone : null,
    }

    setJobs((prev) => {
      // Replace any existing job with the same key (latest wins).
      const rest = prev.filter((j) => j.key !== normalized.key)
      return [...rest, normalized]
    })
  }, [])

  const clear = useCallback((key) => {
    const k = String(key || '')
    if (!k) return
    setJobs((prev) => prev.filter((j) => j.key !== k))
  }, [])

  useEffect(() => {
    if (jobs.length === 0) return

    const timer = setInterval(async () => {
      if (tickingRef.current) return
      tickingRef.current = true
      try {
        const snapshot = jobsRef.current
        if (!Array.isArray(snapshot) || snapshot.length === 0) return

        const now = Date.now()
        const doneKeys = []

        await Promise.all(
          snapshot.map(async (job) => {
            const elapsed = now - Number(job.startedAt || 0)
            if (elapsed > Number(job.timeoutMs || 0)) {
              doneKeys.push(job.key)
              job.onDone?.({ done: true, status: 'failed', message: 'Timed out waiting for completion' })
              return
            }

            try {
              const res = await job.poll()
              if (res && res.done) {
                doneKeys.push(job.key)
                job.onDone?.(res)
              }
            } catch (e) {
              // Treat polling errors as transient; keep tracking.
            }
          }),
        )

        if (doneKeys.length > 0) {
          setJobs((prev) => prev.filter((j) => !doneKeys.includes(j.key)))
        }
      } finally {
        tickingRef.current = false
      }
    }, Math.max(1000, Number(pollMs) || 5000))

    return () => clearInterval(timer)
  }, [jobs.length, pollMs])

  return { track, clear, activeCount: jobs.length }
}

