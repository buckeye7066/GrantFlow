import React, { useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiFetch } from '@/api/client'
import { labelForProfileType } from '@/services/profileTypes'

/**
 * Opens an AI/plain-language explainer for who qualifies for a profile type.
 * Uses POST /api/profile-types/:id/qualifications/explain (falls back to static copy).
 */
export default function ProfileTypeQualifyButton({
  typeId,
  label,
  className,
  size = 'icon',
  variant = 'ghost',
  stopPropagation = true,
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState(null)

  const displayLabel = label || labelForProfileType(typeId, typeId)

  const loadExplanation = async (event) => {
    if (stopPropagation && event) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!typeId) return
    setOpen(true)
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(
        `/api/profile-types/${encodeURIComponent(typeId)}/qualifications/explain`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setPayload(res)
    } catch (err) {
      setError(err?.message || 'Could not load qualification help.')
      setPayload(null)
    } finally {
      setLoading(false)
    }
  }

  const qualifications = payload?.qualifications

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        title={`What qualifies as ${displayLabel}?`}
        aria-label={`Explain who qualifies as ${displayLabel}`}
        onClick={loadExplanation}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {size !== 'icon' ? <span className="ml-1.5">Who qualifies?</span> : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-600" />
              {displayLabel}
            </DialogTitle>
            <DialogDescription>
              Who should pick this profile type — and who should pick something else.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-600 py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing qualification guidance…
            </div>
          ) : null}

          {!loading && error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : null}

          {!loading && !error && payload ? (
            <div className="space-y-4 text-sm text-slate-700">
              <p className="whitespace-pre-wrap">{payload.explanation}</p>

              {qualifications?.qualifies_if?.length ? (
                <div>
                  <p className="font-semibold text-slate-900 mb-1">Quick checklist</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {qualifications.qualifies_if.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {qualifications?.does_not_fit?.length ? (
                <div>
                  <p className="font-semibold text-slate-900 mb-1">Usually pick a different type if</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {qualifications.does_not_fit.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {payload.source === 'ai' ? (
                <p className="text-xs text-slate-500">Explained with AI using GrantFlow&apos;s profile-type rules.</p>
              ) : (
                <p className="text-xs text-slate-500">Based on GrantFlow&apos;s built-in profile-type guidance.</p>
              )}
            </div>
          ) : null}
        </DialogContent>
        ) : null}
      </Dialog>
    </>
  )
}
