import React, { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { X, Loader2, UploadCloud, Sparkles } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers";
import FileDropzone from "./FileDropzone";
import DocumentTypeSelect from "./DocumentTypeSelect";
import MultiSelectCombobox from "@/components/shared/MultiSelectCombobox";

/**
 * DocumentUploader - Enhanced multi-file document upload component
 * @param {Object} props
 * @param {string} props.organizationId - Organization ID to attach documents to
 * @param {Function} props.onClose - Close handler
 * @param {boolean} props.allowMultiple - Allow multiple file uploads at once
 * @param {boolean} props.enableAI - Enable AI suggestions for titles/types
 */

const MAX_FILES = 25;

export default function DocumentUploader({
  organizationId,
  onClose,
  allowMultiple = false,
  enableAI = false,
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { register, handleSubmit, control, formState: { errors }, watch } = useForm({
    defaultValues: {
      files: [],
      title: "",
      document_type: "",
      tags: [],
      description: "",
      runAIAnalysis: enableAI,
    },
  });

  const [files, setFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(null);
  const watchedTitle = watch("title");
  const watchedType = watch("document_type");

  // Upload mutation
  const uploadFileMutation = useMutation({
    mutationFn: async (file) => {
      const uploader = base44?.integrations?.Core?.UploadPrivateFile;
      if (typeof uploader !== "function") {
        throw new Error("Upload service unavailable.");
      }
      const result = await uploader({ file });
      return result;
    },
  });

  // Create document mutation
  const createDocMutation = useMutation({
    mutationFn: async (docData) => {
      return await base44.entities.Document.create(docData);
    },
  });

  // AI analysis mutation (optional)
  const aiAnalysisMutation = useMutation({
    mutationFn: async ({ file_uri, organization_id }) => {
      const invoke = base44?.functions?.invoke;
      if (typeof invoke !== "function") {
        throw new Error("AI function service unavailable.");
      }
      const { data, error } = await invoke("processDocumentForFacts", {
        body: {
          file_uri,
          organization_id,
          source_type: "document",
        },
      });
      if (error) throw error;
      return data;
    },
  });

  const normalizeTags = (tags) => {
    if (!Array.isArray(tags)) return [];
    const out = [];
    for (const t of tags) {
      const s = (typeof t === "string" ? t : String(t ?? "")).trim();
      if (s && out.length < 50) out.push(s);
    }
    return out;
  };

  const onSubmit = async (data) => {
    // Validate organizationId
    const orgId = typeof organizationId === "string" ? organizationId.trim() : "";
    if (!orgId) {
      showErrorToast(toast, "Missing Profile", "A valid organization/profile is required.");
      return;
    }

    // Normalize files array
    const incomingFiles = Array.isArray(files) ? files.filter((f) => f instanceof File) : [];
    if (incomingFiles.length === 0) {
      showErrorToast(toast, "No files selected", "Please select at least one file to upload.");
      return;
    }

    // Validate document type
    const docType = typeof data.document_type === "string" ? data.document_type.trim() : "";
    if (!docType) {
      showErrorToast(toast, "Type required", "Please select a document type.");
      return;
    }

    // Validate title for single file
    const titleTrim = typeof data.title === "string" ? data.title.trim() : "";
    if (!titleTrim && incomingFiles.length === 1) {
      showErrorToast(toast, "Title required", "Please enter a document title.");
      return;
    }

    // Respect allowMultiple flag and cap file count
    const toProcess = allowMultiple
      ? incomingFiles.slice(0, MAX_FILES)
      : incomingFiles.slice(0, 1);

    if (incomingFiles.length > toProcess.length) {
      showErrorToast(
        toast,
        "File limit",
        `Only the first ${toProcess.length} file${toProcess.length > 1 ? "s" : ""} will be uploaded.`
      );
    }

    try {
      setUploadProgress({ current: 0, total: toProcess.length });

      const uploadedDocs = [];

      for (let i = 0; i < toProcess.length; i++) {
        const file = toProcess[i];
        setUploadProgress({ current: i + 1, total: toProcess.length, fileName: file.name });

        // Upload file
        const uploadResult = await uploadFileMutation.mutateAsync(file);
        const fileUri = uploadResult?.file_uri;
        if (!fileUri) throw new Error("Upload did not return a file_uri");

        // Title & tags
        const docTitle = toProcess.length === 1 ? titleTrim : (titleTrim || file.name);
        const tags = normalizeTags(data.tags);

        // Create document record
        const docData = {
          organization_id: orgId,
          title: docTitle,
          document_type: docType,
          file_uri: fileUri,
          file_type: file.type || "",
          description: typeof data.description === "string" ? data.description : "",
          tags,
          status: data.runAIAnalysis && enableAI ? "processing" : "uploaded",
        };

        const createdDoc = await createDocMutation.mutateAsync(docData);
        uploadedDocs.push(createdDoc);

        // Optionally run AI analysis
        if (data.runAIAnalysis && enableAI) {
          try {
            await aiAnalysisMutation.mutateAsync({
              file_uri: fileUri,
              organization_id: orgId,
            });

            // Update document status
            await base44.entities.Document.update(createdDoc.id, {
              status: "processed",
            });
          } catch (aiError) {
            console.error("[DocumentUploader] AI analysis failed:", aiError);
            // Don't block upload on AI failure
            try {
              await base44.entities.Document.update(createdDoc.id, { status: "failed" });
            } catch {
              /* ignore status update error */
            }
          }
        }
      }

      // Precise cache invalidations
      await queryClient.invalidateQueries({ queryKey: ["documents", orgId] });
      await queryClient.invalidateQueries({ queryKey: ["documents"] });

      showSuccessToast(
        toast,
        "Upload Complete",
        `Successfully uploaded ${uploadedDocs.length} document${uploadedDocs.length !== 1 ? "s" : ""}.`
      );

      onClose();
    } catch (error) {
      console.error("[DocumentUploader] Upload failed:", error);
      showErrorToast(
        toast,
        "Upload Failed",
        error?.message || "There was an error uploading your documents. Please try again."
      );
    } finally {
      setUploadProgress(null);
    }
  };

  const isSubmitting =
    uploadFileMutation.isPending || createDocMutation.isPending || aiAnalysisMutation.isPending;

  const canSubmit =
    files.length > 0 &&
    (!!watchedTitle || files.length > 1) &&
    !!watchedType &&
    !isSubmitting;

  return (
    <Card className="mb-8 shadow-xl border-0 bg-white">
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100">
          <div>
            <CardTitle className="text-xl">Upload Document{allowMultiple ? "s" : ""}</CardTitle>
            <p className="text-sm text-slate-500 mt-1">Attach important files to this profile</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isSubmitting} type="button">
            <X className="w-5 h-5" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-5 pt-6">
          {/* File Upload */}
          <FileDropzone
            files={files}
            onFilesChange={setFiles}
            multiple={allowMultiple}
            disabled={isSubmitting}
          />

          {/* Progress Indicator */}
          {uploadProgress && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-blue-900">
                    Uploading {uploadProgress.fileName}...
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    File {uploadProgress.current} of {uploadProgress.total}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title" className="text-sm font-semibold">
              Document Title {files.length === 1 && "*"}
            </Label>
            <Input
              id="title"
              {...register("title", {
                required: files.length === 1 ? "Title is required" : false,
              })}
              placeholder={files.length > 1 ? "Optional - defaults to file names" : "Enter document title"}
              disabled={isSubmitting}
              aria-invalid={errors.title ? "true" : "false"}
            />
            {errors.title && <p className="text-sm text-red-600">{String(errors.title.message)}</p>}
          </div>

          {/* Document Type */}
          <Controller
            name="document_type"
            control={control}
            rules={{ required: "Document type is required" }}
            render={({ field }) => (
              <DocumentTypeSelect
                value={field.value}
                onChange={field.onChange}
                disabled={isSubmitting}
                error={errors.document_type?.message}
              />
            )}
          />

          {/* Tags */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Tags</Label>
            <p className="text-xs text-slate-500 mb-2">Add tags to organize and filter documents</p>
            <Controller
              name="tags"
              control={control}
              render={({ field }) => (
                <MultiSelectCombobox
                  options={[]}
                  selected={Array.isArray(field.value) ? field.value : []}
                  onSelectedChange={(vals) => field.onChange(normalizeTags(vals))}
                  placeholder="Type and press Enter to add tags..."
                  allowCustom={true}
                />
              )}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description" className="text-sm font-semibold">
              Description
            </Label>
            <Textarea
              id="description"
              {...register("description")}
              placeholder="Add any notes or context about this document"
              rows={3}
              disabled={isSubmitting}
            />
          </div>

          {/* AI Analysis Toggle */}
          {enableAI && (
            <div className="flex items-center justify-between p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles className="w-4 h-4 text-purple-600" />
                  <Label htmlFor="ai-analysis" className="text-sm font-semibold text-purple-900">
                    AI Document Analysis
                  </Label>
                </div>
                <p className="text-xs text-purple-700">Extract key facts and information from uploaded documents</p>
              </div>
              <Controller
                name="runAIAnalysis"
                control={control}
                render={({ field }) => (
                  <Switch id="ai-analysis" checked={field.value} onCheckedChange={field.onChange} disabled={isSubmitting} />
                )}
              />
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-end gap-3 border-t border-slate-100">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} className="bg-blue-600 hover:bg-blue-700">
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <UploadCloud className="w-4 h-4 mr-2" />
                Upload {files.length > 1 ? `${files.length} Files` : "Document"}
              </>
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}