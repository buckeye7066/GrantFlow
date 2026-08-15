import React, { useEffect, useMemo, useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, FileText, Link as LinkIcon, Trash2, Search, Download } from 'lucide-react'
import { downloadAuthenticatedUrl } from '@/utils/authenticatedDownload'

function formatBytes(bytes) {
  const n = Number(bytes || 0)
  if (!Number.isFinite(n) || n <= 0) return null
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export default function AdminKnowledgeBase() {
  const { toast } = useToast()

  const [activeTab, setActiveTab] = useState('upload') // 'upload' | 'url' | 'browse'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Upload state
  const [file, setFile] = useState(null)
  const [uploadName, setUploadName] = useState('')
  const [uploadNotes, setUploadNotes] = useState('')

  // URL ingest state
  const [url, setUrl] = useState('')
  const [urlName, setUrlName] = useState('')
  const [urlNotes, setUrlNotes] = useState('')

  // Browse state
  const [q, setQ] = useState('')
  const [items, setItems] = useState([])
  const [listLoading, setListLoading] = useState(false)

  // View dialog
  const [viewOpen, setViewOpen] = useState(false)
  const [viewId, setViewId] = useState(null)
  const [viewDoc, setViewDoc] = useState(null)
  const [viewLoading, setViewLoading] = useState(false)

  const canUpload = useMemo(() => Boolean(file), [file])
  const canIngestUrl = useMemo(() => Boolean(String(url || '').trim()), [url])

  const loadList = async (opts = {}) => {
    const query = typeof opts.q === 'string' ? opts.q : q
    setListLoading(true)
    try {
      const data = await apiFetch(`/api/admin/knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (e) {
      setItems([])
      toast({ variant: 'destructive', title: 'Failed to load Knowledge Base', description: e?.message || 'Request failed' })
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'browse') {
      loadList({ q })
    }
  }, [activeTab])

  const openDoc = async (id) => {
    setViewOpen(true)
    setViewId(id)
    setViewDoc(null)
    setViewLoading(true)
    try {
      const data = await apiFetch(`/api/admin/knowledge/${encodeURIComponent(id)}`)
      setViewDoc(data?.document || null)
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load document', description: e?.message || 'Request failed' })
      setViewOpen(false)
    } finally {
      setViewLoading(false)
    }
  }

  const downloadDoc = async (doc) => {
    if (!doc?.id) return
    try {
      await downloadAuthenticatedUrl(`/api/documents/${encodeURIComponent(doc.id)}/download`, {
        fallbackFileName: String(doc.name || 'knowledge-document').trim() || 'knowledge-document',
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Unable to open file',
        description: e?.message || 'The file could not be downloaded.',
      })
    }
  }

  const uploadFile = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!file) throw new Error('Select a file first')
      const form = new FormData()
      form.append('document', file)
      if (uploadName.trim()) form.append('name', uploadName.trim())
      if (uploadNotes.trim()) form.append('notes', uploadNotes.trim())
      const data = await apiFetch('/api/admin/knowledge/upload', { method: 'POST', body: form })
      toast({ title: 'Uploaded to Knowledge Base', description: data?.document?.name || 'Uploaded' })
      setFile(null)
      setUploadName('')
      setUploadNotes('')
      const input = document.getElementById('kb-upload-file')
      if (input) input.value = ''
      if (activeTab === 'browse') await loadList({ q: '' })
    } catch (e) {
      setError(e?.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const ingestFromUrl = async () => {
    setBusy(true)
    setError(null)
    try {
      const safeUrl = String(url || '').trim()
      if (!safeUrl) throw new Error('Enter a URL')
      const data = await apiFetch('/api/admin/knowledge/ingest-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: safeUrl,
          name: urlName.trim() || undefined,
          notes: urlNotes.trim() || undefined,
        }),
      })
      toast({ title: 'Ingested URL into Knowledge Base', description: data?.document?.name || 'Ingested' })
      setUrl('')
      setUrlName('')
      setUrlNotes('')
      if (activeTab === 'browse') await loadList({ q: '' })
    } catch (e) {
      setError(e?.message || 'Ingest failed')
    } finally {
      setBusy(false)
    }
  }

  const deleteDoc = async (id) => {
    if (!id) return
    setBusy(true)
    try {
      await apiFetch(`/api/admin/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast({ title: 'Deleted', description: 'Removed from Knowledge Base' })
      setViewOpen(false)
      setViewId(null)
      setViewDoc(null)
      await loadList({ q })
    } catch (e) {
      toast({ variant: 'destructive', title: 'Delete failed', description: e?.message || 'Request failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Knowledge Base</h2>
          <p className="text-sm text-slate-600 mt-1">
            Upload reference documents (global) so admins can reuse them across GrantFlow workflows.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={activeTab === 'upload' ? 'default' : 'outline'} onClick={() => setActiveTab('upload')}>
            Upload
          </Button>
          <Button variant={activeTab === 'url' ? 'default' : 'outline'} onClick={() => setActiveTab('url')}>
            URL
          </Button>
          <Button variant={activeTab === 'browse' ? 'default' : 'outline'} onClick={() => setActiveTab('browse')}>
            Browse
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {activeTab === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              Upload a document
            </CardTitle>
            <CardDescription>PDF, DOC/DOCX, TXT/RTF, HTML, or images up to 50MB.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kb-upload-file">File *</Label>
              <Input
                id="kb-upload-file"
                type="file"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              {file && <p className="text-sm text-slate-600">Selected: <strong>{file.name}</strong> {formatBytes(file.size) ? `(${formatBytes(file.size)})` : ''}</p>}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Name (optional)</Label>
                <Input value={uploadName} onChange={(e) => setUploadName(e.target.value)} disabled={busy} placeholder="e.g. GrantFlow Policy Deck" />
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input value={uploadNotes} onChange={(e) => setUploadNotes(e.target.value)} disabled={busy} placeholder="What should this be used for?" />
              </div>
            </div>

            <Button onClick={uploadFile} disabled={!canUpload || busy} className="w-full bg-blue-600 hover:bg-blue-700">
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading…</> : 'Upload to Knowledge Base'}
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === 'url' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-blue-600" />
              Ingest from URL
            </CardTitle>
            <CardDescription>Fetches the page or file server-side (SSRF-protected) and stores it as a Knowledge Base doc. Works for web pages (HTML) and direct PDF/Word/text/image links.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>URL *</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} placeholder="https://example.org/grants (web page or direct file link)" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Name (optional)</Label>
                <Input value={urlName} onChange={(e) => setUrlName(e.target.value)} disabled={busy} placeholder="Display name" />
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input value={urlNotes} onChange={(e) => setUrlNotes(e.target.value)} disabled={busy} placeholder="What is this?" />
              </div>
            </div>
            <Button onClick={ingestFromUrl} disabled={!canIngestUrl || busy} className="w-full bg-blue-600 hover:bg-blue-700">
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Ingesting…</> : 'Ingest URL'}
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === 'browse' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5 text-blue-600" />
              Browse Knowledge Base
            </CardTitle>
            <CardDescription>Search by name/notes/text.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
              <Button variant="outline" onClick={() => loadList({ q })} disabled={listLoading}>
                {listLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
              </Button>
              <Button variant="outline" onClick={() => { setQ(''); loadList({ q: '' }) }} disabled={listLoading}>
                Clear
              </Button>
            </div>

            {listLoading ? (
              <div className="text-sm text-slate-600 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
            ) : items.length === 0 ? (
              <div className="text-sm text-slate-600">No documents found.</div>
            ) : (
              <div className="divide-y rounded-md border">
                {items.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="w-full text-left p-3 hover:bg-slate-50"
                    onClick={() => openDoc(d.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-slate-900">{d.name || d.id}</div>
                        <div className="text-xs text-slate-600">
                          {d.mime_type ? d.mime_type : 'unknown'}{d.file_size ? ` • ${formatBytes(d.file_size)}` : ''}{d.processing_status ? ` • ${d.processing_status}` : ''}
                        </div>
                        {d.notes ? <div className="text-xs text-slate-600 mt-1 line-clamp-2">{d.notes}</div> : null}
                      </div>
                      <div className="text-xs text-slate-500 whitespace-nowrap">
                        {d.created_at ? new Date(d.created_at).toLocaleString() : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Knowledge Document</DialogTitle>
          </DialogHeader>

          {viewLoading ? (
            <div className="text-sm text-slate-600 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          ) : !viewDoc ? (
            <div className="text-sm text-slate-600">No document loaded.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">{viewDoc.name || viewDoc.id}</div>
                  <div className="text-xs text-slate-600">
                    {viewDoc.mime_type ? viewDoc.mime_type : 'unknown'}{viewDoc.file_size ? ` • ${formatBytes(viewDoc.file_size)}` : ''}{viewDoc.processing_status ? ` • ${viewDoc.processing_status}` : ''}
                  </div>
                </div>
                <Button variant="destructive" onClick={() => deleteDoc(viewId)} disabled={busy}>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </Button>
              </div>

              {viewDoc.file_url || viewDoc.file_path ? (
                <Button variant="outline" size="sm" onClick={() => downloadDoc(viewDoc)}>
                  <Download className="w-4 h-4 mr-2" />
                  Open file
                </Button>
              ) : null}

              {viewDoc.notes ? (
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{viewDoc.notes}</div>
              ) : null}

              <div className="space-y-2">
                <Label>Extracted text</Label>
                <Textarea value={String(viewDoc.extracted_text || '')} readOnly className="min-h-[260px]" />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
