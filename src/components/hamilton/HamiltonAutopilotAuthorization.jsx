import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ShieldCheck, Sparkles, Loader2, AlertTriangle } from 'lucide-react'
import client from '@/api/client'
import { useToast } from '@/components/ui/use-toast'
import {
  HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT,
  HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
} from '../../../shared/hamiltonSubmissionContract.js'

/**
 * HamiltonAutopilotAuthorization
 *
 * Phase A — one-time authorization/preflight screen shown when the
 * user clicks "Automate with Hamilton". The exact text below is the
 * authorization text persisted in hamilton_authorizations.authorization_text.
 *
 * Flow:
 *   1. User reviews authorization options.
 *   2. POST /api/hamilton/automation/authorize  (records the standing authorization)
 *   3. POST /api/hamilton/automation/preflight  (checks profile, docs, URLs)
 *      → if blockers exist, surface them inline; user can fix and retry.
 *   4. POST /api/hamilton/automation/start-autopilot (launches unattended run)
 *
 * Default toggles match Phase A spec:
 *   - complete_forms, upload_documents, generate_narratives, save_drafts: ON
 *   - final submit/account creation: NEVER granted here. The exact task must
 *     exist first so the target, adapter/channel, and current contract are
 *     known; the owner can then approve that one task.
 *   - require_human_review: ON
 *   - use_saved_session, use_saved_credentials_reference: ON
 *   - use_standing_attestation: OFF (legal/accuracy text always needs exact review)
 */
export const AUTOPILOT_TEXT = HAMILTON_AUTOPILOT_AUTHORIZATION_TEXT
export const AUTOPILOT_VERSION = HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION

const DEFAULTS = Object.freeze({
  complete_forms: true,
  upload_documents: true,
  generate_narratives: true,
  save_drafts: true,
  submit_applications: false,
  use_saved_session: true,
  use_saved_credentials_reference: true,
  create_portal_account: false,
  use_standing_attestation: false,
  require_human_review: true,
  allow_auto_submit: false,
})

export default function HamiltonAutopilotAuthorization({
  open, onOpenChange, profileId, selectedSources = [], onLaunched,
}) {
  const { toast } = useToast()
  const [opts, setOpts] = useState(DEFAULTS)
  const [phase, setPhase] = useState('options') // options | preflight | launching | done | error
  const [preflight, setPreflight] = useState(null)
  const [adapterCoverage, setAdapterCoverage] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (open) {
      setPhase('options')
      setPreflight(null)
      setError(null)
      setOpts(DEFAULTS)
      client.get('/api/hamilton/automation/submission-adapter-coverage')
        .then((result) => setAdapterCoverage(result?.coverage || null))
        .catch(() => setAdapterCoverage(null))
    }
  }, [open])

  function set(key, value) { setOpts((s) => ({ ...s, [key]: value })) }

  const fundingSourceIds = selectedSources
    .map((s) => s.opportunity_id || s.grant_id)
    .filter(Boolean)

  async function authorizeAndLaunch() {
    if (!profileId) {
      setError('Open the pipeline from a profile so Hamilton knows whose application to complete.')
      setPhase('error')
      return
    }
    if (selectedSources.length === 0) {
      setError('Select at least one funding source first.')
      setPhase('error')
      return
    }
    setError(null)
    setPhase('preflight')

    // 1. Persist standing authorization (Phase A).
    const types = []
    if (opts.complete_forms)               types.push('complete_forms')
    if (opts.upload_documents)             types.push('upload_documents')
    if (opts.generate_narratives)          types.push('generate_narratives')
    if (opts.save_drafts)                  types.push('save_drafts')
    if (opts.use_saved_session)            types.push('use_saved_session')
    if (opts.use_saved_credentials_reference) types.push('use_saved_credentials_reference')
    if (types.length === 0) {
      setError('Authorize at least one capability so Hamilton has something to do.')
      setPhase('error')
      return
    }

    try {
      await client.post('/api/hamilton/automation/authorize', {
        profile_id: profileId,
        scope: 'funding_source',
        funding_source_ids: fundingSourceIds,
        authorization_types: types,
        authorization_text: AUTOPILOT_TEXT,
        authorization_version: AUTOPILOT_VERSION,
        options: opts,
      })

      // 2. Resolver-aware preflight (Phase B + Hard-Stop predict & resolve).
      const preflightRes = await client.post('/api/hamilton/automation/preflight-resolve', {
        profileId,
        selectedSources,
      })
      setPreflight(preflightRes)
      if (preflightRes?.ok === false) {
        setPhase('preflight')
        return
      }

      // 3. Launch (Phase C).
      setPhase('launching')
      const launch = await client.post('/api/hamilton/automation/start-autopilot', {
        profile_id: profileId,
        selected_sources: selectedSources,
        options: {
          allow_auto_submit: false,
          require_human_review: true,
          headless: true,
        },
      })
      setPhase('done')
      onLaunched?.(launch)
      toast({
        title: 'Hamilton preparation launched',
        description: 'Hamilton can prepare and save drafts. Final submission requires approval on the exact application task.',
      })
      onOpenChange?.(false)
    } catch (err) {
      // The API client builds err.message from the response body, preferring
      // `message` then falling back to `error`. Older backend responses only
      // sent {error: 'authorize_failed', detail: '<real cause>'} so the modal
      // showed the raw token. Pick the most human field we have so the user
      // always sees the actual failure instead of a code.
      const friendly =
        err?.details?.message
        || err?.details?.detail
        || (err?.message && err.message !== err?.errorCode ? err.message : null)
        || err?.errorCode
        || 'Failed to start Hamilton Autopilot.'
      setError(friendly)
      setPhase('error')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            Authorize Hamilton Autopilot
          </DialogTitle>
          <DialogDescription className="text-slate-600">
            Hamilton can prepare the selected applications and save drafts. Final submission is authorized only later on the exact task, after its portal target and submission channel are known.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm text-slate-800">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
            <p>{AUTOPILOT_TEXT}</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
            <span className="font-semibold">Live final-submit coverage: </span>
            {adapterCoverage
              ? `${adapterCoverage.reviewed_real_adapter_count} independently validated real portal adapter(s). ${adapterCoverage.coverage_truth}`
              : 'Coverage could not be verified right now, so treat every real portal as draft or human handoff only.'}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Toggle id="opt_forms"        label="Complete forms"                         checked={opts.complete_forms}         onChange={(v) => set('complete_forms', v)} />
            <Toggle id="opt_uploads"      label="Upload profile documents"               checked={opts.upload_documents}       onChange={(v) => set('upload_documents', v)} />
            <Toggle id="opt_narratives"   label="Generate missing narratives from profile" checked={opts.generate_narratives}    onChange={(v) => set('generate_narratives', v)} />
            <Toggle id="opt_drafts"       label="Save drafts"                            checked={opts.save_drafts}            onChange={(v) => set('save_drafts', v)} />
            <Toggle id="opt_session"      label="Use saved browser session if available" checked={opts.use_saved_session}      onChange={(v) => set('use_saved_session', v)} />
            <Toggle id="opt_creds"        label="Use saved portal logins to sign in"     checked={opts.use_saved_credentials_reference} onChange={(v) => set('use_saved_credentials_reference', v)} />
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
              Terms, releases, accuracy certifications, legal attestations, and signatures always pause for your review of the exact portal text.
            </div>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-sm text-indigo-900">
              Final Submit and new-account creation are not standing permissions. Approve them, if appropriate, from the exact application task.
            </div>
          </div>

          {phase === 'preflight' && preflight ? (
            <PreflightReport preflight={preflight} />
          ) : null}
          {phase === 'launching' ? (
            <div className="flex items-center gap-2 text-indigo-700">
              <Loader2 className="w-4 h-4 animate-spin" /> Launching Hamilton Autopilot…
            </div>
          ) : null}
          {error ? (
            <div className="flex items-start gap-2 text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
              <AlertTriangle className="w-4 h-4 mt-0.5" /> <span>{error}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-between">
          <div className="text-xs text-slate-500 flex items-center gap-1">
            <ShieldCheck className="w-4 h-4" />
            Hamilton never bypasses CAPTCHA, 2FA, payment, signatures, or exact-task approval.
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={phase === 'launching'}>
              Cancel
            </Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
              onClick={authorizeAndLaunch}
              disabled={phase === 'launching'}
            >
              {phase === 'launching' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
              Prepare and continue safely
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Toggle({ id, label, checked, onChange, highlight = false }) {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-2 rounded-lg border p-2 cursor-pointer ${
        highlight ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white'
      }`}
    >
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-slate-800">{label}</span>
    </label>
  )
}

function PreflightReport({ preflight }) {
  const results = preflight?.results || []
  const allBlockers = results.flatMap((r) => r.blockers || [])
  const allWarnings = results.flatMap((r) => r.warnings || [])
  const allResolutions = results.flatMap((r) => r.resolutions || [])
  return (
    <div className="space-y-2">
      {results.map((r, i) => <SourceReadiness key={`s${i}`} result={r} />)}
      {preflight?.ok ? (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
          Preflight passed for {results.length} source(s). Hamilton is ready.
        </div>
      ) : (
        <div className="text-sm bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
          <div className="font-semibold text-amber-900">Hamilton needs the following before she can run:</div>
          <ul className="list-disc pl-5">
            {allBlockers.map((b, i) => <li key={`b${i}`} className="text-amber-900">{b.label} — <span className="text-amber-700">{b.detail}</span></li>)}
          </ul>
        </div>
      )}
      {allWarnings.length > 0 ? (
        <details className="text-xs text-slate-700">
          <summary className="cursor-pointer">Warnings ({allWarnings.length})</summary>
          <ul className="list-disc pl-5 mt-1">
            {allWarnings.map((w, i) => <li key={`w${i}`}>{w.label} — {w.detail}</li>)}
          </ul>
        </details>
      ) : null}
      {allResolutions.length > 0 ? (
        <details className="text-xs text-slate-700">
          <summary className="cursor-pointer">Resolutions Hamilton already applied ({allResolutions.length})</summary>
          <ul className="list-disc pl-5 mt-1">
            {allResolutions.map((d, i) => (
              <li key={`r${i}`}>
                <span className="font-medium">{d.classification?.category || 'unknown'}</span> — {d.strategy} → {d.outcome}
                {d.detail ? ` (${d.detail})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

function SourceReadiness({ result }) {
  const r = result?.readiness || {}
  const idn = r.identity || {}
  const sch = r.school || {}
  const fin = r.financial || {}
  const ap  = r.application_path || {}
  const cs  = r.credentials_session || {}
  const py  = r.payment || {}
  const as  = r.auto_submit || {}
  const policy = ap.policy || {}
  return (
    <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded p-2 space-y-1">
      <div className="font-semibold text-slate-900">
        {result?.source?.title || result?.source?.opportunity_id || result?.source?.grant_id || 'Selected source'}
        <span className="text-slate-500 ml-2">[{ap.automation_type || 'unknown'}]</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Pill ok={idn.first_name && idn.last_name && idn.email} label={`Identity ${idn.first_name && idn.last_name ? '✓' : '!'}`} />
        <Pill ok={sch.school || !sch.is_student_funding} label={`School ${sch.school || !sch.is_student_funding ? '✓' : '!'}`} />
        <Pill ok={fin.household_income} label={`Financial ${fin.household_income ? '✓' : '~'}`} />
        <Pill ok={(r.documents?.count ?? 0) > 0} label={`Docs (${r.documents?.count ?? 0})`} />
        <Pill ok={cs.session_present || cs.authorized?.use_saved_session} label={`Session ${cs.session_present ? '✓' : (cs.authorized?.use_saved_session ? 'auth' : '!')}`} />
        <Pill ok={!py.needed || py.allowed} label={`Payment ${!py.needed ? 'n/a' : py.allowed ? '✓' : '!'}`} />
        <Pill ok={false} label="Legal text: manual review" />
        <Pill ok={as.submit_applications_authorized} label={`Auto-submit ${as.submit_applications_authorized ? '✓' : 'off'}`} />
      </div>
      {policy.automation_allowed === false ? (
        <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded p-1">
          Portal terms require manual completion → fallback: <span className="font-mono">{policy.fallback_path || 'pdf_docx'}</span>
        </div>
      ) : null}
    </div>
  )
}

function Pill({ ok, label }) {
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] inline-flex items-center justify-between ${
      ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'
    }`}>
      {label}
    </span>
  )
}
