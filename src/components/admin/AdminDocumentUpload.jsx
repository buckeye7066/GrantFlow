import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, Upload, FileText, CheckCircle2, AlertCircle, UserPlus } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { useAuthStore } from '@/stores/authStore';
import { apiFetch } from '@/api/client';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export default function AdminDocumentUpload() {
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [extractionResult, setExtractionResult] = useState(null);
  const { toast } = useToast();
  const user = useAuthStore((state) => state.user);

  // Use Boolean coercion to align with backend truthy checks - not strict equality
  const isAdmin = Boolean(user?.is_admin) || (user?.role === 'admin');

  const uploadMutation = useMutation({
    mutationFn: async (file) => {
      const formData = new FormData();
      formData.append('document', file);

      const response = await apiFetch('/api/admin/upload-profile-document', {
        method: 'POST',
        body: formData,
      });

      return response;
    },
    onSuccess: (data) => {
      setExtractionResult(data);
      toast({
        title: '✅ Profile Created Successfully',
        description: `Created profile for ${data.profile?.display_name || 'new organization'}`,
      });
      setFile(null);
      setFileError(null);
      // Reset file input
      const fileInput = document.getElementById('admin-file-upload');
      if (fileInput) fileInput.value = '';
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Upload failed';
      setFileError(message);
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: message,
      });
    },
  });

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFileError(null);
      setExtractionResult(null);

      // Validate file type
      if (selectedFile.type !== 'application/pdf') {
        setFileError('Only PDF files are allowed');
        setFile(null);
        return;
      }

      // Validate file size
      if (selectedFile.size > MAX_FILE_SIZE) {
        setFileError(`File is too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        setFile(null);
        return;
      }

      setFile(selectedFile);
    } else {
      setFile(null);
      setFileError(null);
    }
  };

  const handleUpload = () => {
    if (!file) {
      setFileError('Please select a PDF file to upload');
      return;
    }

    uploadMutation.mutate(file);
  };

  // Show access denied if not admin
  if (!isAdmin) {
    return (
      <Card className="max-w-2xl mx-auto mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-600">
            <AlertCircle className="w-5 h-5" />
            Access Denied
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              This feature is restricted to administrators only.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const isUploading = uploadMutation.isPending;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-blue-600" />
            Admin: Upload Profile Document
          </CardTitle>
          <CardDescription>
            Upload a PDF document to automatically extract organization information and create a new profile using AI
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-file-upload">PDF Document *</Label>
            <div className="flex items-center gap-4">
              <Input
                id="admin-file-upload"
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
                disabled={isUploading}
                className="cursor-pointer"
              />
              {file && (
                <Badge variant="outline" className="whitespace-nowrap">
                  <FileText className="w-3 h-3 mr-1" />
                  {(file.size / 1024).toFixed(1)} KB
                </Badge>
              )}
            </div>
            {fileError && (
              <Alert variant="destructive">
                <AlertDescription>{fileError}</AlertDescription>
              </Alert>
            )}
            {file && !fileError && (
              <p className="text-sm text-slate-600">
                Selected: <strong>{file.name}</strong>
              </p>
            )}
          </div>

          <Button
            onClick={handleUpload}
            disabled={!file || isUploading}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing Document...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload & Extract Profile
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Extraction Result */}
      {extractionResult && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="w-5 h-5" />
              Profile Created Successfully
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold text-slate-900">Profile Information</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-600">Profile ID:</span>
                  <p className="font-mono text-xs text-slate-800">{extractionResult.profile?.id}</p>
                </div>
                <div>
                  <span className="text-slate-600">Display Name:</span>
                  <p className="font-semibold text-slate-800">{extractionResult.profile?.display_name}</p>
                </div>
                <div>
                  <span className="text-slate-600">Type:</span>
                  <p className="text-slate-800">{extractionResult.profile?.primary_type || 'N/A'}</p>
                </div>
                <div>
                  <span className="text-slate-600">Status:</span>
                  <Badge variant="outline">{extractionResult.profile?.status}</Badge>
                </div>
              </div>
            </div>

            {extractionResult.extracted_fields && Object.keys(extractionResult.extracted_fields).length > 0 && (
              <div className="space-y-2">
                <h3 className="font-semibold text-slate-900">Extracted Fields</h3>
                <div className="bg-white rounded-lg p-4 border border-green-200">
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap overflow-x-auto">
                    {JSON.stringify(extractionResult.extracted_fields, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            {extractionResult.document_id && (
              <div className="pt-4 border-t border-green-200">
                <p className="text-sm text-slate-600">
                  Document saved with ID:{' '}
                  <span className="font-mono text-xs text-slate-800">{extractionResult.document_id}</span>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
