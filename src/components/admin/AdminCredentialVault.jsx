/**
 * AdminCredentialVault
 *
 * The admin's view of every login the admin has PLACED (managed_by='admin') —
 * via the Chrome/CSV import or this panel. It lets the admin move a login out
 * of one profile and into another, copy a login into a profile (leaving the
 * original), or remove it.
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
import { Loader2, RefreshCw, KeyRound, ArrowRightLeft, Copy, Trash2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast } from '@/components/shared/toastHelpers'

function normalizeProfiles(resp) {
  const rows = Array.isArray(resp) ? resp : (resp?.profiles || resp?.data || [])
  return rows.map((p) => ({ id: p.id, name: p.display_name || p.name || p.id }))
}

export default function AdminCredentialVault() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(null)
  const [creds, setCreds] = useState([])
  const [profiles, setProfiles] = useState([])
  const [targetByCred, setTargetByCred] = useState({}) // credId -> target profileId

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [credResp, profResp] = await Promise.all([
        client.get('/api/hamilton/automation/admin/credentials'),
        client.get('/api/profiles'),
      ])
      setCreds(Array.isArray(credResp?.credentials) ? credResp.credentials : [])
      setProfiles(normalizeProfiles(profResp))
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

  async function doMove(cred) {
    const toProfileId = targetByCred[cred.id]
    if (!toProfileId) { showErrorToast(toast, 'Pick a destination profile first'); return }
    setBusy(cred.id)
    try {
      await client.post(`/api/hamilton/automation/admin/credentials/${cred.id}/move`, { toProfileId })
      showInfoToast(toast, 'Login moved', `${cred.portal_host} → ${profileName(toProfileId)}`)
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not move login', err?.message || 'See logs.')
    } finally { setBusy(null) }
  }

  async function doCopy(cred) {
    const toProfileId = targetByCred[cred.id]
    if (!toProfileId) { showErrorToast(toast, 'Pick a destination profile first'); return }
    setBusy(cred.id)
    try {
      await client.post(`/api/hamilton/automation/admin/credentials/${cred.id}/copy`, { toProfileId })
      showInfoToast(toast, 'Login copied', `${cred.portal_host} → ${profileName(toProfileId)} (original kept)`)
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not copy login', err?.message || 'See logs.')
    } finally { setBusy(null) }
  }

  async function doDelete(cred) {
    if (!window.confirm(`Remove ${cred.portal_host} (${cred.username_masked || ''}) from ${profileName(cred.profile_id)}?`)) return
    setBusy(cred.id)
    try {
      await client.delete(`/api/hamilton/automation/admin/credentials/${cred.id}`)
      showInfoToast(toast, 'Login removed')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not remove login', err?.message || 'See logs.')
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-indigo-600" />
          Admin credential vault
          <Badge variant="outline" className="ml-2">{creds.length} logins</Badge>
        </h2>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
          Refresh
        </Button>
      </div>

      <p className="text-xs text-slate-500 max-w-3xl">
        Only logins you placed (via import or here) are shown. Pick a destination profile, then
        <strong> Move</strong> a login into it (removing it from where it is) or <strong>Copy</strong> it
        (keeping the original, e.g. in the admin vault). Passwords are encrypted and never shown.
      </p>

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
                  <th className="text-left px-3 py-2">Destination</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-900">{c.portal_host}</td>
                    <td className="px-3 py-2 text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        {c.username_masked || '—'}
                        {c.has_totp && (
                          <Badge className="text-[10px] bg-violet-100 text-violet-800 border-violet-200 hover:bg-violet-100">2FA</Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{c.label || '—'}</td>
                    <td className="px-3 py-2">
                      <select
                        className="border border-slate-300 rounded px-2 py-1 text-xs max-w-[180px]"
                        value={targetByCred[c.id] || ''}
                        onChange={(e) => setTargetByCred((m) => ({ ...m, [c.id]: e.target.value }))}
                      >
                        <option value="">Choose profile…</option>
                        {profiles.filter((p) => p.id !== c.profile_id).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" className="mr-1" onClick={() => doMove(c)} disabled={busy === c.id || !targetByCred[c.id]}>
                        {busy === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><ArrowRightLeft className="w-3 h-3 mr-1" />Move</>}
                      </Button>
                      <Button size="sm" variant="outline" className="mr-1" onClick={() => doCopy(c)} disabled={busy === c.id || !targetByCred[c.id]}>
                        <Copy className="w-3 h-3 mr-1" />Copy
                      </Button>
                      <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50" onClick={() => doDelete(c)} disabled={busy === c.id}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
