
import React, { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Loader2, UploadCloud } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/components/ui/use-toast";
import { ingestDocument } from "@/api/documents";

const DOCUMENT_TYPES = [
  "nofo", "proposal", "budget", "letter_of_support", "mou", "resume",
  "irs_determination", "financial_statement", "audit", "logic_model",
  "timeline", "other"
];

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'text/plain',
  'application/rtf',
  'text/rtf'
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export default function DocumentUploader({ profileId, organizationId, onClose }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, control, formState: { errors }, watch } = useForm();
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [skipParsing, setSkipParsing] = useState(false); // NEW: State for skip parsing checkbox
  const { toast } = useToast();

  const ingestMutation = useMutation({
    mutationFn: async ({ file, title, documentType, description, tags, skipParsing }) => {
      if (!profileId) {
        throw new Error("Select a profile before uploading a document.");
      }

      const formData = new FormData();
      formData.append("profile_id", profileId);
      if (organizationId) {
        formData.append("organization_id", organizationId);
      }
      formData.append("document", file);
      formData.append("name", title || file.name);
      formData.append("type", documentType);
      
      // NEW: Add skip_parsing parameter
      if (skipParsing) {
        formData.append("skip_parsing", "true");
      }

      const notesSegments = [description?.trim() || null, tags ? `Tags: ${tags}` : null].filter(Boolean);
      if (notesSegments.length) {
        formData.append("notes", notesSegments.join("\n"));
      }

      return ingestDocument(formData);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['documents', profileId] });
      queryClient.invalidateQueries({ queryKey: ['profile', profileId] });
      
      if (data?.parsing_skipped) {
        toast({
          title: "📄 Document saved",
          description: "Document uploaded successfully. You can parse it later using the 'Parse' button.",
        });
      } else {
        toast({
          title: "📄 Document queued for enrichment",
          description: "AI will analyze the document and update the profile shortly.",
        });
      }
      
      setFile(null);
      setFileError(null);
      setSkipParsing(false);
      if (onClose) onClose();
    },
    onError: (error) => {
      setFileError(error instanceof Error ? error.message : String(error));
    },
  });

  const onSubmit = async (data) => {
    if (!file) {
      setFileError("Please select a file to upload.");
      return;
    }
    
    // Additional check for file validation before submission if handleFileChange might be bypassed
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      setFileError(`Invalid file type. Please upload one of: PDF, DOCX, DOC, JPEG, JPG, PNG, GIF, BMP, TXT, RTF.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError(`File is too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
      return;
    }

    try {
      await ingestMutation.mutateAsync({
        file,
        title: data.title,
        documentType: data.document_type,
        description: data.description,
        tags: data.tags,
        skipParsing, // NEW: Pass skip parsing flag
      });
    } catch (error) {
      console.error("Upload failed", error);
      setFileError(error instanceof Error ? error.message : "Document upload failed. Please try again.");
    }
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFileError(null); // Clear previous errors

      if (!ALLOWED_FILE_TYPES.includes(selectedFile.type)) {
        setFileError(`Invalid file type. Please upload one of: PDF, DOCX, DOC, JPEG, JPG, PNG, GIF, BMP, TXT, RTF.`);
        setFile(null); // Clear selected file if invalid
        return;
      }
      if (selectedFile.size > MAX_FILE_SIZE) {
        setFileError(`File is too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
        setFile(null); // Clear selected file if invalid
        return;
      }
      setFile(selectedFile);
    } else {
      setFile(null);
      setFileError(null); // Clear error if no file selected (e.g., user cancels file selection)
    }
  };
  
  const isSubmitting = ingestMutation.isPending;

  return (
    <Card className="mb-8 shadow-xl border-0 bg-white">
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Upload New Document</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="file-upload">File *</Label>
            <div className="mt-2 flex items-center justify-center w-full">
              <label htmlFor="file-upload" className="flex flex-col items-center justify-center w-full h-32 border-2 border-slate-300 border-dashed rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <UploadCloud className="w-8 h-8 mb-3 text-slate-500" />
                  {file ? (
                    <p className="font-semibold text-blue-600">{file.name}</p>
                  ) : (
                    <>
                      <p className="mb-2 text-sm text-slate-500"><span className="font-semibold">Click to upload</span> or drag and drop</p>
                      <p className="text-xs text-slate-500">PDF, DOCX, DOC, JPEG, JPG, PNG, GIF, BMP, TXT, RTF (Max 10MB)</p>
                    </>
                  )}
                </div>
                <Input id="file-upload" type="file" className="hidden" onChange={handleFileChange} accept={ALLOWED_FILE_TYPES.join(',')} />
              </label>
            </div>
            {fileError && <Alert variant="destructive" className="mt-2"><AlertDescription>{fileError}</AlertDescription></Alert>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Document Title *</Label>
            <Input id="title" {...register("title", { required: "Title is required" })} />
            {errors.title && <Alert variant="destructive"><AlertDescription>{errors.title.message}</AlertDescription></Alert>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="document_type">Document Type *</Label>
            <Controller
              name="document_type"
              control={control}
              rules={{ required: "Document type is required" }}
              render={({ field }) => (
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select document type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_TYPES.map(type => (
                      <SelectItem key={type} value={type} className="capitalize">{type.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.document_type && <Alert variant="destructive"><AlertDescription>{errors.document_type.message}</AlertDescription></Alert>}
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input id="tags" {...register("tags")} placeholder="e.g., financial, 2024, required" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register("description")} />
          </div>
          
          <div className="flex items-center space-x-2 py-2">
            <Checkbox 
              id="skip-parsing" 
              checked={skipParsing}
              onCheckedChange={setSkipParsing}
            />
            <Label 
              htmlFor="skip-parsing" 
              className="text-sm font-normal cursor-pointer"
            >
              Save without parsing (parse later manually)
            </Label>
          </div>
        </CardContent>
        <CardFooter className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2" />}
            {isSubmitting ? "Uploading..." : skipParsing ? "Upload & Save" : "Upload & Parse"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
