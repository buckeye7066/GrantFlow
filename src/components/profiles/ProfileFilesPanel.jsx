import React, { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { AlertTriangle, CheckCircle2, Clock3, FileSearch, Loader2, UploadCloud } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { listDocuments, ingestDocument, deleteDocument, parseAllProfileDocuments } from "@/api/documents"
import DocumentItem from "@/components/documents/DocumentItem"

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB (backend enforced)

function isLikelyParseable(file) {
  const extension = file?.name?.split(".").pop()?.toLowerCase() ?? ""
  const parseableMimes = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "application/rtf",
    "text/rtf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/heic",
    "image/heif",
  ])
  const parseableExt = new Set([
    "pdf",
    "doc",
    "docx",
    "txt",
    "rtf",
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif",
    "bmp",
    "tif",
    "tiff",
    "heic",
    "heif",
  ])
  return parseableMimes.has(file?.type) || parseableExt.has(extension)
}

function documentEvidenceStatus(doc) {
  const status = String(doc?.processing_status ?? doc?.status ?? "pending").toLowerCase()
  const hasEvidence = Boolean(
    String(doc?.extracted_text ?? "").trim() ||
    String(doc?.ai_summary ?? "").trim() ||
    (doc?.extracted_structured && Object.keys(doc.extracted_structured).length > 0),
  )
  if (hasEvidence || ["completed", "parsed", "ready"].includes(status)) return "parsed"
  if (["failed", "error", "parse_failed"].includes(status)) return "failed"
  return "queued"
}

export default function ProfileFilesPanel({
  profileId,
  profileName,
  canDocumentAI = true,
  canDeleteDocuments = false,
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const fileInputRef = useRef(null)
  const allowDelete = Boolean(canDeleteDocuments)

  const [uploadFile, setUploadFile] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [parseWithAI, setParseWithAI] = useState(true)
  const [handwritingOcr, setHandwritingOcr] = useState(true)
  const [urlToIngest, setUrlToIngest] = useState("")
  const [urlError, setUrlError] = useState(null)

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["documents", profileId],
    queryFn: () => listDocuments({ profile_id: profileId }),
    enabled: Boolean(profileId),
  })

  const uploadMutation = useMutation({
    mutationFn: async ({ file }) => {
      const formData = new FormData()
      formData.append("profile_id", profileId)
      formData.append("document", file)
      formData.append("name", file.name)
      formData.append("type", parseWithAI ? "source_material" : "profile_file")

      const canParse = isLikelyParseable(file)
      const skipParsing = !parseWithAI || !canParse
      formData.append("skip_parsing", skipParsing ? "true" : "false")
      formData.append("enable_ai", skipParsing ? "false" : "true")

      // OCR options (server will only apply OCR to image-like files).
      formData.append("ocr", "true")
      formData.append("handwriting", handwritingOcr ? "true" : "false")
      formData.append("ocr_language", "eng")
      formData.append("source", "upload")

      return ingestDocument(formData)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      setUploadFile(null)
      setUploadError(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
      toast({
        title: "File uploaded",
        description: parseWithAI ? "We’ll parse what we can and sync updates shortly." : "Saved to this profile’s file vault.",
      })
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Upload failed"
      setUploadError(message)
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: message,
      })
    },
  })

  const urlIngestMutation = useMutation({
    mutationFn: async ({ url }) => {
      const body = {
        profile_id: profileId,
        file_url: url,
        name: undefined,
        type: parseWithAI ? "source_material" : "profile_file",
        skip_parsing: parseWithAI ? false : true,
        ocr: true,
        handwriting: Boolean(handwritingOcr),
        ocr_language: "eng",
        source: "url_import",
      }

      // Best-effort derived name from URL path.
      try {
        const parsed = new URL(url)
        const base = parsed.pathname.split("/").filter(Boolean).pop()
        body.name = base || `URL import (${parsed.hostname})`
      } catch {
        body.name = "URL import"
      }

      return ingestDocument(body)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      setUrlToIngest("")
      setUrlError(null)
      toast({
        title: "URL imported",
        description: parseWithAI ? "We’ll download and parse what we can." : "Downloaded and saved to this profile.",
      })
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "URL ingest failed"
      setUrlError(message)
      toast({
        variant: "destructive",
        title: "URL ingest failed",
        description: message,
      })
    },
  })

  const pasteTextMutation = useMutation({
    mutationFn: async ({ text }) => {
      const now = new Date()
      const name = `Pasted text ${now.toISOString().replace(/[:.]/g, "-")}.txt`
      return ingestDocument({
        profile_id: profileId,
        name,
        type: parseWithAI ? "source_material" : "profile_file",
        extracted_text: text,
        skip_parsing: parseWithAI ? false : true,
        source: "paste",
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "Pasted content saved",
        description: parseWithAI ? "Queued for parsing and section updates." : "Saved to this profile.",
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Paste failed",
        description: error instanceof Error ? error.message : "Unable to ingest clipboard content.",
      })
    },
  })

  const parseAllMutation = useMutation({
    mutationFn: () =>
      parseAllProfileDocuments(profileId, {
        handwriting: Boolean(handwritingOcr),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "Parsing queued",
        description: `Queued ${result?.queued_count ?? "some"} document(s) for parsing.`,
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Parse-all failed",
        description: error instanceof Error ? error.message : "Unable to queue parsing for these documents.",
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (docId) => deleteDocument(docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({ title: "Deleted", description: "The file was removed from this profile." })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Unable to delete this file.",
      })
    },
  })

  const grouped = useMemo(() => {
    // Hamilton saves the SAME funding source as several artifacts (application
    // packet PDF + DOCX, full proposal PDF + DOCX). Rendering each as its own
    // card read as "a lot of duplicates" (owner report, 2026-07-03). Group by
    // the source's base name — one card per source, with the other artifacts
    // reachable from that card — while unrelated uploads stay one card each.
    const FORMAT_SUFFIX = /\s+—\s+(PDF|DOCX|HTML)$/i
    const VARIANT_SUFFIX = /\s+—\s+Full Proposal$/i
    const baseNameOf = (doc) =>
      String(doc?.name || "").replace(FORMAT_SUFFIX, "").replace(VARIANT_SUFFIX, "").trim()
    const variantLabelOf = (doc) => {
      const name = String(doc?.name || "")
      const fmt = name.match(FORMAT_SUFFIX)?.[1]?.toUpperCase() || null
      const isProposal = VARIANT_SUFFIX.test(name.replace(FORMAT_SUFFIX, ""))
      const parts = [isProposal ? "Full proposal" : "Packet"]
      if (fmt) parts.push(fmt)
      return parts.join(" · ")
    }

    const byKey = new Map()
    for (const doc of documents) {
      // Only generated multi-format artifacts group; everything else keeps
      // its own card (base === full name → unique key per doc id).
      const isGroupable = FORMAT_SUFFIX.test(String(doc?.name || ""))
      const key = isGroupable ? baseNameOf(doc).toLowerCase() : `solo:${doc.id}`
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(doc)
    }

    const groups = []
    for (const docs of byKey.values()) {
      if (docs.length === 1) {
        groups.push({ doc: docs[0], siblings: [], groupDocs: docs })
        continue
      }
      // Primary = the packet PDF when present (what a person most wants to
      // open), else the newest artifact.
      const sorted = [...docs].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      const primary =
        sorted.find((d) => /—\s+PDF$/i.test(d.name || "") && !VARIANT_SUFFIX.test(String(d.name || "").replace(FORMAT_SUFFIX, ""))) ||
        sorted[0]
      const siblings = sorted
        .filter((d) => d.id !== primary.id)
        .map((d) => ({ doc: d, label: variantLabelOf(d) }))
      groups.push({
        doc: { ...primary, name: baseNameOf(primary) },
        primaryLabel: variantLabelOf(primary),
        siblings,
        groupDocs: docs,
      })
    }
    return groups
  }, [documents])
  const documentStats = useMemo(() => {
    const counts = { total: documents.length, parsed: 0, queued: 0, failed: 0 }
    for (const doc of documents) counts[documentEvidenceStatus(doc)] += 1
    return counts
  }, [documents])

  const isUploading = uploadMutation.isPending
  const isIngestingUrl = urlIngestMutation.isPending
  const isPastingText = pasteTextMutation.isPending

  const handleFileChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      setUploadFile(null)
      setUploadError(null)
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      setUploadFile(null)
      setUploadError("File must be 50MB or smaller.")
      return
    }

    setUploadError(null)
    setUploadFile(file)
  }

  const handleUpload = () => {
    setUploadError(null)
    if (!profileId) {
      toast({
        variant: "destructive",
        title: "No profile selected",
        description: "Open a profile before uploading files.",
      })
      return
    }
    if (!uploadFile) {
      setUploadError("Select a file to upload.")
      return
    }

    if (parseWithAI && !isLikelyParseable(uploadFile)) {
      toast({
        title: "Stored without parsing",
        description: "This file type isn’t parseable yet, but it will still be stored securely for this profile.",
      })
    }

    uploadMutation.mutate({ file: uploadFile })
  }

  const handlePaste = (event) => {
    if (!profileId) {
      toast({
        variant: "destructive",
        title: "No profile selected",
        description: "Open a profile before pasting documents.",
      })
      return
    }

    const items = Array.from(event.clipboardData?.items ?? [])
    if (items.length === 0) return

    // Prefer file-like clipboard payloads (screenshots) over text.
    const fileItem = items.find((item) => item.kind === "file")
    if (fileItem) {
      const file = fileItem.getAsFile()
      if (file) {
        event.preventDefault()
        uploadMutation.mutate({ file })
        return
      }
    }

    const textItem = items.find((item) => item.kind === "string" && item.type === "text/plain")
    if (textItem) {
      event.preventDefault()
      textItem.getAsString((text) => {
        const cleaned = String(text ?? "").trim()
        if (!cleaned) return
        pasteTextMutation.mutate({ text: cleaned })
      })
    }
  }

  const handleIngestUrl = () => {
    setUrlError(null)
    if (!profileId) {
      toast({
        variant: "destructive",
        title: "No profile selected",
        description: "Open a profile before importing URLs.",
      })
      return
    }
    const raw = String(urlToIngest || "").trim()
    if (!raw) {
      setUrlError("Paste a URL to import.")
      return
    }
    let url
    try {
      // Auto-prepend https:// if no protocol specified
      url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setUrlError("Only http(s) URLs are supported.")
        return
      }
    } catch {
      setUrlError("That doesn’t look like a valid URL.")
      return
    }
    urlIngestMutation.mutate({ url })
  }

  return (
    <Card className="border-border">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg text-foreground">Files for {profileName ?? "this profile"}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Upload PDFs, images, spreadsheets, screenshots, and more. Files are private and scoped to this profile.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-medium text-slate-700">
              <FileSearch className="h-3.5 w-3.5" />
              {documentStats.total} files
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {documentStats.parsed} parsed evidence
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-700">
              <Clock3 className="h-3.5 w-3.5" />
              {documentStats.queued} queued
            </span>
            {documentStats.failed ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 font-medium text-red-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                {documentStats.failed} needs attention
              </span>
            ) : null}
          </div>
        </div>
        <Badge variant="outline">{documents.length} total</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="parse-with-ai"
                  checked={parseWithAI}
                  onCheckedChange={(checked) => setParseWithAI(Boolean(checked))}
                  disabled={isUploading}
                />
                <Label htmlFor="parse-with-ai" className="text-sm font-medium">
                  Try to parse (PDF/DOC/DOCX/TXT/RTF + images/handwriting)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`handwriting-ocr-${profileId}`}
                  checked={handwritingOcr}
                  onCheckedChange={(checked) => setHandwritingOcr(Boolean(checked))}
                  disabled={isUploading}
                />
                <Label htmlFor={`handwriting-ocr-${profileId}`} className="text-sm font-medium">
                  Handwritten / scanned form (OCR)
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                For sensitive uploads (PHI/HIPAA/identifiers), you can leave parsing off and just store the file.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileChange}
                disabled={!profileId || isUploading}
                className="w-full sm:w-80 text-sm"
              />
              <Button onClick={handleUpload} disabled={!uploadFile || !profileId || isUploading} className="gap-2">
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <UploadCloud className="w-4 h-4" />
                    Upload
                  </>
                )}
              </Button>
              {canDocumentAI ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!profileId) return
                    if (documents.length === 0) {
                      toast({ title: "No documents", description: "Upload at least one document first." })
                      return
                    }
                    const ok = window.confirm(
                      `Queue parsing for up to 25 of the most recent documents for ${profileName ?? "this profile"}?`,
                    )
                    if (!ok) return
                    parseAllMutation.mutate()
                  }}
                  disabled={!profileId || parseAllMutation.isPending}
                >
                  {parseAllMutation.isPending ? "Queueing…" : "Parse all"}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div
              className={`rounded-lg border border-dashed p-4 text-sm bg-card ${
                profileId ? "border-border text-foreground" : "border-border text-muted-foreground opacity-70"
              }`}
              tabIndex={0}
              role="button"
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.currentTarget.focus()
                }
              }}
            >
              <p className="font-medium text-foreground">Paste (Ctrl+V)</p>
              <p className="text-xs text-muted-foreground mt-1">
                Paste screenshots/images or copied text. We’ll save it directly to this profile (and optionally parse it).
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Tip: Click here first, then paste.
                {isUploading || isPastingText ? " (working…)" : ""}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <p className="font-medium text-foreground text-sm">Import from URL</p>
              <p className="text-xs text-muted-foreground">
                Paste a link to a file (PDF/DOCX/image) or any webpage. Max 50MB; download timeout ~20s.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={urlToIngest}
                  onChange={(e) => setUrlToIngest(e.target.value)}
                  placeholder="https://example.com/application.pdf"
                  disabled={!profileId || isIngestingUrl}
                />
                <Button onClick={handleIngestUrl} disabled={!profileId || isIngestingUrl} className="sm:w-40">
                  {isIngestingUrl ? "Importing…" : "Import URL"}
                </Button>
              </div>
              {urlError ? <p className="text-xs text-red-600">{urlError}</p> : null}
            </div>
          </div>
          {uploadFile ? (
            <p className="text-xs text-muted-foreground">
              Ready: <span className="font-medium">{uploadFile.name}</span>
            </p>
          ) : null}
          {uploadError ? <p className="text-xs text-red-600">{uploadError}</p> : null}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : grouped.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No files uploaded yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {grouped.map((group) => (
              <DocumentItem
                key={group.doc.id}
                document={group.doc}
                primaryLabel={group.primaryLabel}
                siblings={group.siblings}
                onDelete={
                  allowDelete
                    ? () => {
                        const count = group.groupDocs.length
                        const ok = window.confirm(
                          count > 1
                            ? `Delete "${group.doc?.name ?? "this document"}" and all ${count} of its files (PDF/DOCX versions)? This cannot be undone.`
                            : `Delete "${group.doc?.name ?? "this document"}"? This cannot be undone.`,
                        )
                        if (!ok) return
                        for (const d of group.groupDocs) deleteMutation.mutate(d.id)
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
