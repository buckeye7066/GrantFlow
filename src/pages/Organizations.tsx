import { useEffect, useMemo, useState } from 'react'
import { Download, FilePlus, Printer, Save, Upload, RefreshCw, FileText, Wand2 } from 'lucide-react'
import { useExperience } from '../contexts/ExperienceContext'
import { useAdmin } from '../contexts/AdminContext'

type Profile = {
  id: string
  display_name: string
  notes: string
  profile_type: string
  full_name?: string | null
  dob?: string | null
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  updated_at: string
}

type DocumentRecord = {
  id: string
  profile_id: string
  original_filename: string
  mime_type: string
  size_bytes: number
  status: string
  doc_type: string
  created_at: string
  updated_at: string
  suggested_patches_json?: Record<string, unknown> | null
}

async function fetchJson<T>(token: string, input: RequestInfo, init: RequestInit = {}): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || response.statusText)
  }
  return response.json() as Promise<T>
}

export default function Organizations() {
  const { token } = useAdmin()
  const { markSaved, lastSavedLabel } = useExperience()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetchJson<{ data: Profile[] }>(token, '/api/profiles', {
          signal: controller.signal,
        })
        setProfiles(response.data)
        if (!selectedProfileId && response.data.length) {
          setSelectedProfileId(response.data[0].id)
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [token, selectedProfileId])

  useEffect(() => {
    if (!token || !selectedProfileId) return
    const controller = new AbortController()
    ;(async () => {
      try {
        const [profileResponse, documentsResponse] = await Promise.all([
          fetchJson<{ data: Profile }>(token, `/api/profiles/${selectedProfileId}`, {
            signal: controller.signal,
          }),
          fetchJson<{ data: DocumentRecord[] }>(
            token,
            `/api/profiles/${selectedProfileId}/documents`,
            { signal: controller.signal },
          ),
        ])
        setNotes(profileResponse.data.notes ?? '')
        setDocuments(documentsResponse.data)
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => controller.abort()
  }, [token, selectedProfileId])

  const handleSave = async () => {
    if (!token || !selectedProfileId) return
    try {
      await fetchJson<{ data: Profile }>(token, `/api/profiles/${selectedProfileId}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes }),
      })
      markSaved()
      setProfiles((current) =>
        current.map((profile) =>
          profile.id === selectedProfileId ? { ...profile, notes } : profile,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCreateProfile = async () => {
    if (!token) return
    const name = window.prompt('Display name for new profile?')
    if (!name) return
    try {
      const response = await fetchJson<{ data: Profile }>(token, '/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ display_name: name }),
      })
      setProfiles((current) => [response.data, ...current])
      setSelectedProfileId(response.data.id)
      setNotes(response.data.notes ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!token || !selectedProfileId) return
    const file = event.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      await fetch(`/api/profiles/${selectedProfileId}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }).then((res) => {
        if (!res.ok) {
          throw new Error('Upload failed')
        }
        return res.json()
      })
      const documentsResponse = await fetchJson<{ data: DocumentRecord[] }>(
        token,
        `/api/profiles/${selectedProfileId}/documents`,
      )
      setDocuments(documentsResponse.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      event.target.value = ''
    }
  }

  const handleParseDocument = async (documentId: string) => {
    if (!token) return
    try {
      await fetchJson<{ data: DocumentRecord }>(
        token,
        `/api/documents/${documentId}/parse`,
        { method: 'POST' },
      )
      const documentsResponse = await fetchJson<{ data: DocumentRecord[] }>(
        token,
        `/api/profiles/${selectedProfileId}/documents`,
      )
      setDocuments(documentsResponse.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleApplyDocument = async (documentId: string) => {
    if (!token) return
    try {
      await fetchJson<{ data: DocumentRecord }>(
        token,
        `/api/documents/${documentId}/apply`,
        { method: 'POST' },
      )
      const [profileResponse, documentsResponse] = await Promise.all([
        fetchJson<{ data: Profile }>(token, `/api/profiles/${selectedProfileId}`),
        fetchJson<{ data: DocumentRecord[] }>(
          token,
          `/api/profiles/${selectedProfileId}/documents`,
        ),
      ])
      setDocuments(documentsResponse.data)
      setProfiles((current) =>
        current.map((profile) =>
          profile.id === profileResponse.data.id ? profileResponse.data : profile,
        ),
      )
      setNotes(profileResponse.data.notes ?? '')
      markSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePrint = () => {
    window.print()
  }

  const handleExport = () => {
    window.print()
  }

  const documentPatches = (documentId: string) =>
    documents.find((doc) => doc.id === documentId)?.suggested_patches_json ?? null

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Profiles</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Maintain organization and individual profiles, ingest documents, and apply structured data automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">Last saved: {lastSavedLabel}</span>
          <button
            type="button"
            onClick={handleCreateProfile}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow hover:bg-blue-700"
          >
            <FilePlus className="h-4 w-4" aria-hidden />
            New Profile
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-900/30 dark:text-red-100">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px,1fr]">
        <aside className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Profiles</span>
            <button
              type="button"
              onClick={() => setSelectedProfileId(null)}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              Refresh
            </button>
          </div>
          <div className="space-y-2">
            {loading && <p className="text-xs text-slate-500 dark:text-slate-400">Loading profiles…</p>}
            {!loading && profiles.length === 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400">Create your first profile to get started.</p>
            )}
            <ul className="space-y-1">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedProfileId(profile.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                      profile.id === selectedProfileId
                        ? 'bg-blue-600 text-white shadow'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    <span className="block font-semibold">{profile.display_name}</span>
                    <span className="text-xs opacity-60">{new Date(profile.updated_at).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="space-y-6">
          {selectedProfile ? (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                    {selectedProfile.display_name}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSave}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white shadow hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
                    >
                      <Save className="h-4 w-4" aria-hidden />
                      Save Notes
                    </button>
                    <button
                      type="button"
                      onClick={handlePrint}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Printer className="h-4 w-4" aria-hidden />
                      Print
                    </button>
                    <button
                      type="button"
                      onClick={handleExport}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      Export PDF
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Notes
                    </label>
                    <textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Add notes about this profile..."
                      className="mt-2 h-40 w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/40"
                    />
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
                      <span>{notes.length} characters</span>
                      <span>Last saved {new Date(selectedProfile.updated_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Identity details
                    </label>
                    <dl className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                      <div className="grid grid-cols-[120px,1fr] gap-2 px-4 py-2 text-sm">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">Full name</dt>
                        <dd>{selectedProfile.full_name ?? '—'}</dd>
                      </div>
                      <div className="grid grid-cols-[120px,1fr] gap-2 px-4 py-2 text-sm">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">Date of birth</dt>
                        <dd>{selectedProfile.dob ?? '—'}</dd>
                      </div>
                      <div className="grid grid-cols-[120px,1fr] gap-2 px-4 py-2 text-sm">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">Address</dt>
                        <dd>
                          {[selectedProfile.address_line1, selectedProfile.address_line2]
                            .filter(Boolean)
                            .join(', ') || '—'}
                          <br />
                          {[selectedProfile.city, selectedProfile.state, selectedProfile.zip]
                            .filter(Boolean)
                            .join(', ') || ' '}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    <FileText className="h-5 w-5" aria-hidden />
                    Documents
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                    <Upload className="h-4 w-4" aria-hidden />
                    Upload
                    <input type="file" className="hidden" onChange={handleUpload} />
                  </label>
                </div>
                <div className="space-y-3">
                  {documents.length === 0 && (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Upload supporting documents to extract structured data automatically.
                    </p>
                  )}
                  {documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-slate-100">
                            {doc.original_filename}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {Math.round(doc.size_bytes / 1024)} KB • {doc.mime_type} • {doc.status}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleParseDocument(doc.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <Wand2 className="h-3.5 w-3.5" aria-hidden />
                            Parse
                          </button>
                          <button
                            type="button"
                            onClick={() => handleApplyDocument(doc.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            Apply
                          </button>
                        </div>
                      </div>
                      {documentPatches(doc.id) && (
                        <pre className="mt-3 overflow-auto rounded-lg bg-slate-950/80 p-3 text-xs text-slate-200">
                          {JSON.stringify(documentPatches(doc.id), null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              Select or create a profile to begin managing notes and documents.
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
