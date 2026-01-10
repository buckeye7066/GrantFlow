import React, { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Loader2, UploadCloud } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { listDocuments, ingestDocument, deleteDocument } from "@/api/documents"
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

export default function ProfileFilesPanel({ profileId, profileName }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const fileInputRef = useRef(null)

  const [uploadFile, setUploadFile] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [parseWithAI, setParseWithAI] = useState(false)

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
    // Keep current grid rendering; hook for future grouping by type.
    return documents
  }, [documents])

  const isUploading = uploadMutation.isPending

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

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg">Files for {profileName ?? "this profile"}</CardTitle>
          <p className="text-sm text-slate-600">
            Upload PDFs, images, spreadsheets, screenshots, and more. Files are private and scoped to this profile.
          </p>
        </div>
        <Badge variant="outline">{documents.length} total</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
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
              <p className="text-xs text-slate-600">
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
            </div>
          </div>
          {uploadFile ? (
            <p className="text-xs text-slate-600">
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
          <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center text-sm text-slate-600">
            No files uploaded yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {grouped.map((doc) => (
              <DocumentItem
                key={doc.id}
                document={doc}
                onDelete={() => deleteMutation.mutate(doc.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

