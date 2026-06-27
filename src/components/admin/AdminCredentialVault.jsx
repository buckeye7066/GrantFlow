/**
 * AdminCredentialVault
 *
 * The admin's view of every login the admin has PLACED (managed_by='admin') —
 * via the Chrome/CSV import or this panel. It is a triage worklist for mass
 * clean-up: per row pick Assign (move into a profile), Keep (leave as-is), or
 * Delete (mark for removal). A sticky action bar applies all pending
 * assignments, then mass-deletes everything marked.
 *
 * Privacy boundary: this only ever shows admin-placed credentials. Logins a
 * profile user entered themselves, or that Hamilton generated, are never listed
 * here and cannot be touched from this panel — the server enforces it too.
 *
 * Passwords are never shown; the API returns a masked username and a
 * has_password flag only.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react'
import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw, KeyRound, Trash2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast, showSuccessToast } from '@/components/shared/toastHelpers'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// Per-row triage decisions.
const ACTIONS = Object.freeze({ KEEP: 'keep', ASSIGN: 'assign', DELETE: 'delete' })

function normalizeProfiles(resp) {
  const rows = Array.isArray(resp) ? resp : (resp?.profiles || resp?.data || [])
  return rows.map((p) => ({ id: p.id, name: p.display_name || p.name || p.id }))
}

/**
 * SegmentedAction — a compact 3-way toggle (Assign / Keep / Delete) for a
 * single credential row. Mirrors HamiltonProcessing's control: aria-pressed
 * buttons rather than a radio group so the whole thing fits on one line.
 */
function SegmentedAction({ value, onChange, disabled }) {
  const base = 'px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50'
  const opts = [
    { key: ACTIONS.ASSIGN, label: 'Assign', on: 'bg-indigo-600 text-white', off: 'text-slate-600 hover:bg-indigo-50', ring: 'focus:ring-indigo-400' },
    { key: ACTIONS.KEEP, label: 'Keep', on: 'bg-slate-600 text-white', off: 'text-slate-600 hover:bg-slate-100', ring: 'focus:ring-slate-400' },
    { key: ACTIONS.DELETE, label: 'Delete', on: 'bg-red-600 text-white', off: 'text-slate-600 hover:bg-red-50', ring: 'focus:ring-red-400' },
  ]
  return (
    <div className="inline-flex rounded-md border border-slate-200 overflow-hidden divide-x divide-slate-200">
      {opts.map((o) => {
        const active = value === o.key
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.key)}
            className={`${base} ${o.ring} ${active ? o.on : `bg-white ${o.off}`}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function AdminCredentialVault() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [creds, setCreds] = useState([])
  const [profiles, setProfiles] = useState([])
  const [actions, setActions] = useState({})       // credId -> ACTIONS.*
  const [targetByCred, setTargetByCred] = useState({}) // credId -> target profileId (for Assign)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [credResp, profResp] = await Promise.all([
        client.get('/api/hamilton/automation/admin/credentials'),
        client.get('/api/profiles'),
      ])
      const list = Array.isArray(credResp?.credentials) ? credResp.credentials : []
      setCreds(list)
      setProfiles(normalizeProfiles(profResp))
      // Reset triage state to a clean "Keep everything" baseline after a load.
      setActions(Object.fromEntries(list.map((c) => [c.id, ACTIONS.KEEP])))
      setTargetByCred({})
    } catch (err) {
      showErrorToast(toast, 'Could not load the admin vault', err?.message || 'See logs.')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const profileName = useMemo(() => {
    const m = new Map(profiles.map((p) => [p.id, p.name]))
    return (id) => m.get(id) || (id ? `${String(id).slice(0, 8)}…` : '—')
  }, [profiles])

  // Group credentials by the profile they currently live in.
  const grouped = useMemo(() => {
    const g = new Map()
    for (const c of creds) {
      const k = c.profile_id
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(c)
    }
    return [...g.entries()].sort((a, b) => profileName(a[0]).localeCompare(profileName(b[0])))
  }, [creds, profileName])

  const counts = useMemo(() => {
    let assign = 0
    let del = 0
    let keep = 0
    for (const c of creds) {
      const a = actions[c.id] ?? ACTIONS.KEEP
      if (a === ACTIONS.ASSIGN) assign += 1
      else if (a === ACTIONS.DELETE) del += 1
      else keep += 1
    }
    return { assign, del, keep }
  }, [creds, actions])

  function setAction(credId, action) {
    setActions((prev) => ({ ...prev, [credId]: action }))
  }

  function markAllForDelete() {
    setActions(Object.fromEntries(creds.map((c) => [c.id, ACTIONS.DELETE])))
  }

  function resetAll() {
    setActions(Object.fromEntries(creds.map((c) => [c.id, ACTIONS.KEEP])))
    setTargetByCred({})
  }

  // Apply every pending Assign by calling the existing move endpoint (assign =
  // move the login into the chosen profile). Returns a tally so the delete pass
  // can run afterwards in the same click flow.
  async function applyAssignments() {
    const pending = creds.filter((c) => actions[c.id] === ACTIONS.ASSIGN && targetByCred[c.id])
    const missingTarget = creds.filter((c) => actions[c.id] === ACTIONS.ASSIGN && !targetByCred[c.id])
    if (missingTarget.length > 0) {
      showErrorToast(toast, 'Pick a destination profile', `${missingTarget.length} row(s) marked Assign have no profile chosen.`)
      return { assigned: 0, failed: 0, blocked: missingTarget.length }
    }
    if (pending.length === 0) return { assigned: 0, failed: 0, blocked: 0 }
    setApplying(true)
    let assigned = 0
    let failed = 0
    try {
      for (const c of pending) {
        try {
          await client.post(`/api/hamilton/automation/admin/credentials/${c.id}/move`, { toProfileId: targetByCred[c.id] })
          assigned += 1
        } catch (err) {
          failed += 1
          showErrorToast(toast, `Could not assign ${c.portal_host}`, err?.message || 'See logs.')
        }
      }
    } finally {
      setApplying(false)
    }
    return { assigned, failed, blocked: 0 }
  }

  async function handleApplyAssignments() {
    const { assigned, failed, blocked } = await applyAssignments()
    if (blocked > 0) return
    if (assigned > 0) {
      showSuccessToast(toast, 'Assignments applied', `${assigned} login${assigned === 1 ? '' : 's'} moved${failed ? `, ${failed} failed` : ''}.`)
      await load()
    } else if (failed === 0) {
      showInfoToast(toast, 'Nothing to assign', 'No rows are marked Assign with a destination.')
    }
  }

  // Mass-delete every row marked Delete via the bulk-delete endpoint. Per the
  // recommended flow we assign first (so any Assign rows are honored), then
  // delete the marked rows.
  async function handleDeleteMarked() {
    const ids = creds.filter((c) => actions[c.id] === ACTIONS.DELETE).map((c) => c.id)
    if (ids.length === 0) { setConfirmDeleteOpen(false); return }
    setApplying(true)
    try {
      // Assign-first: honor any pending assignments before we remove the rest.
      const { failed: assignFailed, blocked } = await applyAssignments()
      if (blocked > 0) { setConfirmDeleteOpen(false); return }

      const res = await client.post('/api/hamilton/automation/admin/credentials/bulk-delete', { ids })
      const deleted = res?.deleted ?? 0
      const total = res?.total ?? ids.length
      if (deleted === total && !assignFailed) {
        showSuccessToast(toast, 'Logins removed', `${deleted} login${deleted === 1 ? '' : 's'} deleted.`)
      } else {
        showInfoToast(toast, 'Clean-up finished', `${deleted} of ${total} deleted${assignFailed ? `, ${assignFailed} assignment(s) failed` : ''}.`)
      }
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not delete marked logins', err?.message || 'See logs.')
    } finally {
      setApplying(false)
      setConfirmDeleteOpen(false)
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-indigo-600" />
          Admin credential vault
          <Badge variant="outline" className="ml-2">{creds.length} logins</Badge>
        </h2>
        <div className="flex items-center gap-2">
          {creds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={markAllForDelete}
              disabled={loading || applying}
              className="text-rose-700 border-rose-200 hover:bg-rose-50"
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Mark all for delete
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={resetAll} disabled={loading || applying || creds.length === 0}>
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading || applying}>
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-xs text-slate-500 max-w-3xl">
        Only logins you placed (via import or here) are shown. Triage each row: <strong>Assign</strong> it
        to a profile (pick a destination), <strong>Keep</strong> it where it is, or <strong>Delete</strong> it.
        Then apply assignments and mass-delete the marked rows from the bar below. Passwords are encrypted
        and never shown.
      </p>

      {creds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge className="bg-red-100 text-red-800 border-red-200 hover:bg-red-100">{counts.del} to delete</Badge>
          <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200 hover:bg-indigo-100">{counts.assign} to assign</Badge>
          <Badge variant="secondary">{counts.keep} keep</Badge>
        </div>
      )}

      {!loading && creds.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded p-3 text-sm text-slate-600">
          No admin-managed logins yet. Import a password CSV to populate the vault.
        </div>
      )}

      {grouped.map(([profileId, rows]) => (
        <div key={profileId} className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            {profileName(profileId)}
            <span className="font-mono text-[10px] text-slate-400">{String(profileId).slice(0, 8)}</span>
            <Badge variant="secondary">{rows.length}</Badge>
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Site</th>
                  <th className="text-left px-3 py-2">Username</th>
                  <th className="text-left px-3 py-2">Label</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Assign to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const action = actions[c.id] ?? ACTIONS.KEEP
                  return (
                    <tr key={c.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium text-slate-900">{c.portal_host}</td>
                      <td className="px-3 py-2 text-slate-600">
                        <span className="inline-flex items-center gap-1.5">
                          {c.username_masked || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{c.label || '—'}</td>
                      <td className="px-3 py-2">
                        <SegmentedAction value={action} onChange={(a) => setAction(c.id, a)} disabled={applying} />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="border border-slate-300 rounded px-2 py-1 text-xs max-w-[180px] disabled:opacity-50 disabled:bg-slate-50"
                          value={targetByCred[c.id] || ''}
                          disabled={action !== ACTIONS.ASSIGN || applying}
                          onChange={(e) => setTargetByCred((m) => ({ ...m, [c.id]: e.target.value }))}
                        >
                          <option value="">Choose profile…</option>
                          {profiles.filter((p) => p.id !== c.profile_id).map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Sticky action bar: assign pending, then mass-delete the marked. */}
      {creds.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 pr-24 shadow-[0_-1px_3px_rgba(0,0,0,0.06)]">
          <span className="mr-auto text-xs text-slate-500">
            {counts.del} to delete · {counts.assign} to assign · {counts.keep} keep
          </span>
          <Button
            variant="outline"
            onClick={handleApplyAssignments}
            disabled={applying || counts.assign === 0}
            className="disabled:opacity-50"
          >
            {applying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Assign {counts.assign}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={applying || counts.del === 0}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete {counts.del} marked
          </Button>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={(o) => { if (!applying) setConfirmDeleteOpen(o) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {counts.del} login{counts.del === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>
              {counts.assign > 0
                ? `The ${counts.assign} row(s) marked Assign will be moved into their chosen profile first, then `
                : 'This '}
              permanently removes the {counts.del} marked login{counts.del === 1 ? '' : 's'} from the vault.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteMarked() }}
              className="bg-red-600 hover:bg-red-700"
              disabled={applying}
            >
              {applying ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Working…</>
              ) : (
                `Delete ${counts.del}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
