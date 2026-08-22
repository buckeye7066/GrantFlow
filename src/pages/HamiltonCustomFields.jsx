/**
 * HamiltonCustomFields — answer the fields Anya created when a portal asked for
 * something the profile schema had no home for (owner doctrine 2026-08-22,
 * condition 2). These fields exist GLOBALLY for every profile; this page shows
 * them for one profile and lets the owner fill them in. Once saved, the tasks
 * that were waiting on that answer resume automatically.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast } from '@/components/shared/toastHelpers'
import { Loader2, RefreshCw, Save, CheckCircle2 } from 'lucide-react'

export default function HamiltonCustomFields() {
  const [params] = useSearchParams()
  const profileId = params.get('profile') || ''
  const focus = params.get('focus') || ''
  const { toast } = useToast()

  const [fields, setFields] = useState([])
  const [values, setValues] = useState({})
  const [drafts, setDrafts] = useState({})
  const [loading, setLoading] = useState(false)
  const [savingKey, setSavingKey] = useState(null)

  const load = useCallback(async () => {
    if (!profileId) return
    setLoading(true)
    try {
      const res = await client.get(`/api/hamilton/automation/custom-fields?profileId=${encodeURIComponent(profileId)}`)
      const data = res?.data || res || {}
      setFields(Array.isArray(data.fields) ? data.fields : [])
      setValues(data.values && typeof data.values === 'object' ? data.values : {})
      setDrafts({})
    } catch (err) {
      showErrorToast(toast, 'Could not load fields', err?.response?.data?.message || err?.message || 'See logs.')
    } finally {
      setLoading(false)
    }
  }, [profileId, toast])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (fieldKey) => {
    const value = drafts[fieldKey] ?? values[fieldKey] ?? ''
    if (!String(value).trim()) return
    setSavingKey(fieldKey)
    try {
      const res = await client.put('/api/hamilton/automation/custom-fields', { profileId, fieldKey, value })
      const n = res?.data?.tasks_resolved ?? 0
      showInfoToast(toast, 'Saved', n > 0 ? `${n} task${n === 1 ? '' : 's'} can resume now.` : 'Saved to the profile.')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not save', err?.response?.data?.message || err?.message || 'See logs.')
    } finally {
      setSavingKey(null)
    }
  }, [drafts, values, profileId, toast, load])

  const sorted = useMemo(() => {
    // A focused field (from a deep link) sorts first.
    return [...fields].sort((a, b) => (a.field_key === focus ? -1 : b.field_key === focus ? 1 : 0))
  }, [fields, focus])

  if (!profileId) {
    return <div className="p-8 text-slate-600">Open this from a profile (add <code>?profile=&lt;id&gt;</code>).</div>
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Additional details Hamilton needs</h1>
            <p className="text-sm text-slate-500">Questions a portal asked that don&rsquo;t fit anywhere else in the profile. Fill one in and the applications waiting on it resume.</p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
          </Button>
        </div>

        {!loading && sorted.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500">
            Nothing here yet — Hamilton adds a field only when a portal requires something the profile has no place for.
          </div>
        )}

        {sorted.map((f) => {
          const saved = values[f.field_key]
          const draft = drafts[f.field_key]
          const current = draft ?? (saved ?? '')
          const dirty = draft !== undefined && draft !== (saved ?? '')
          return (
            <div key={f.field_key} className={`rounded-lg border bg-white p-4 ${f.field_key === focus ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'}`}>
              <label htmlFor={`cf-${f.field_key}`} className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {f.label}
                {saved && !dirty && <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="answered" />}
              </label>
              {f.description && <p className="mt-0.5 text-xs text-slate-500">{f.description}</p>}
              <div className="mt-2 flex gap-2">
                <Input
                  id={`cf-${f.field_key}`}
                  value={current}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.field_key]: e.target.value }))}
                  placeholder="Type the answer…"
                />
                <Button onClick={() => save(f.field_key)} disabled={savingKey === f.field_key || !String(current).trim()}>
                  {savingKey === f.field_key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
