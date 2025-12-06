import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Download, Trash2, Loader2, RefreshCw, Edit, Check, X, FileSearch, AlertTriangle, StopCircle } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import DocumentPreview from './DocumentPreview';
import { formatFileSize } from '@/components/uploads/fileValidation';
import { useToast } from '@/components/ui/use-toast';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { runHybridOCR } from '@/components/uploads/hybridOCR';
import { extractPHIData } from '@/components/uploads/phiExtractionPipeline';
import EditableExtractedField from '@/components/uploads/EditableExtractedField';

/**
 * DocumentItem - Enhanced document card with preview, metadata, rename, and reparse
 */
export default function DocumentItem({
  document,
  onDelete,
  onDownloadStart,
  onDownloadComplete,
  onProfileUpdate
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(document?.title || '');
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessStatus, setReprocessStatus] = useState('');
  const [reprocessAbortController, setReprocessAbortController] = useState(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [extractedData, setExtractedData] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Safe document access
  const docId = document?.id;
  const docTitle = document?.title || '';
  const docOrgId = document?.organization_id || '';
  const docFileUri = document?.file_uri || '';
  const docFileType = document?.file_type || '';

  // Rename mutation
  const renameMutation = useMutation({
    mutationFn: async (newTitle) => {
      return await base44.entities.Document.update(docId, { title: newTitle });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
      setIsEditing(false);
      toast({ title: 'Document renamed' });
    },
    onError: (error) => {
      toast({
        title: 'Rename failed',
        description: error?.message || 'Unexpected error',
        variant: 'destructive'
      });
    }
  });

  // Reparse mutation
  const reparseMutation = useMutation({
    mutationFn: async () => {
      await base44.entities.Document.update(docId, { status: 'processing' });

      const extractor = base44?.integrations?.Core?.ExtractDataFromUploadedFile;
      if (typeof extractor !== 'function') throw new Error('AI extraction service unavailable.');

      const result = await extractor({
        file_url: docFileUri,
        json_schema: {
          type: "object",
          properties: {
            full_text: {
              type: "string",
              description: "The full, plain text content of the entire document."
            }
          }
        }
      });

      // Support legacy/envelope formats
      const isError = result?.status === 'error' || result?.error;
      if (isError) {
        const msg = result?.details || result?.error || 'Failed to extract data from document.';
        throw new Error(msg);
      }
      const output = result?.output ?? result?.data ?? {};
      const extractedText = output?.full_text || '';

      // Update document with new data
      await base44.entities.Document.update(docId, {
        harvested_data: JSON.stringify(output),
        status: 'processed'
      });

      // Append to organization additional_data (safe concat)
      if (docOrgId) {
        try {
          const org = await base44.entities.Organization.get(docOrgId);
          const prev = org?.additional_data || '';
          const updatedOrgData = {
            additional_data: `${prev}\n\n--- Document (Re-parsed): ${docTitle} ---\n\n${extractedText}`
          };
          await base44.entities.Organization.update(docOrgId, updatedOrgData);
        } catch (e) {
          console.warn('[DocumentItem] Could not append to organization.additional_data', e);
        }
      }

      return output;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast({
        title: 'Re-parsing complete',
        description: 'AI has extracted the text again and updated the profile.'
      });
    },
    onError: (error) => {
      // Update status to failed
      base44.entities.Document.update(docId, { status: 'failed' }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });

      toast({
        title: 'Re-parsing failed',
        description: error?.message || 'Extraction failed.',
        variant: 'destructive'
      });
    }
  });

  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const getSignedUrlAndDownload = async () => {
    try {
      setIsDownloading(true);
      if (typeof onDownloadStart === 'function') onDownloadStart(document);

      const signer = base44?.integrations?.Core?.CreateFileSignedUrl;
      if (typeof signer !== 'function') throw new Error('Download service unavailable.');

      const result = await signer({ file_uri: docFileUri, expires_in: 300 });
      const signed_url = result?.signed_url;
      if (!signed_url) throw new Error('Could not generate download link');

      // URL safety: enforce http/https and open safely
      let href;
      try {
        const u = new URL(signed_url, window.location.origin);
        if (!/^https?:$/i.test(u.protocol)) throw new Error('Invalid URL protocol');
        href = u.toString();
      } catch {
        throw new Error('Invalid download URL');
      }

      window.open(href, '_blank', 'noopener,noreferrer');
      if (typeof onDownloadComplete === 'function') onDownloadComplete(document);
    } catch (error) {
      console.error('[DocumentItem] Failed to get download URL:', error);
      toast({
        title: 'Download failed',
        description: error?.message || 'Try again later.',
        variant: 'destructive'
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveRename = () => {
    const trimmed = (editedTitle || '').trim();
    if (!trimmed) {
      toast({
        title: 'Title required',
        description: 'Document title cannot be empty',
        variant: 'destructive'
      });
      return;
    }
    renameMutation.mutate(trimmed);
  };

  const handleCancelRename = () => {
    setEditedTitle(docTitle);
    setIsEditing(false);
  };

  // Stop reprocessing
  const handleStopReprocess = async () => {
    if (reprocessAbortController) {
      reprocessAbortController.abort();
    }
    setIsReprocessing(false);
    setReprocessStatus('');
    setReprocessAbortController(null);

    // Reset document status
    try {
      await base44.entities.Document.update(docId, { status: 'uploaded' });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
    } catch (err) {
      console.warn('[DocumentItem] Failed to reset status:', err);
    }

    toast({ title: 'Processing stopped' });
  };

  // Re-process document with Hybrid OCR + PHI extraction
  const handleReprocessPHI = async () => {
    const abortController = new AbortController();
    setReprocessAbortController(abortController);
    setIsReprocessing(true);
    setReprocessStatus('Fetching document...');

    try {
      if (abortController.signal.aborted) return;

      // Update document status to processing
      await base44.entities.Document.update(docId, { status: 'processing' });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });

      // 1. Get signed URL to fetch the file
      const signer = base44?.integrations?.Core?.CreateFileSignedUrl;
      if (typeof signer !== 'function') throw new Error('Download service unavailable.');
      const signerResult = await signer({ file_uri: docFileUri, expires_in: 300 });
      const signed_url = signerResult?.signed_url;
      if (abortController.signal.aborted) return;

      if (!signed_url) throw new Error('Could not access document file');

      // 2. Determine if OCR is needed
      const isImage = docFileType.startsWith('image/');

      let ocrText = null;
      let ocrMethod = null;

      // 3. Only run OCR for images
      if (isImage) {
        setReprocessStatus('Downloading file...');
        if (abortController.signal.aborted) return;

        const fileResponse = await fetch(signed_url, { signal: abortController.signal });
        if (abortController.signal.aborted) return;
        if (!fileResponse.ok) throw new Error('Failed to download document');
        const blob = await fileResponse.blob();
        if (abortController.signal.aborted) return;

        const file = new File([blob], docTitle, { type: blob.type || 'application/octet-stream' });

        setReprocessStatus('Running OCR... (server)');
        if (abortController.signal.aborted) return;

        const ocrResult = await runHybridOCR(file, signed_url);
        if (abortController.signal.aborted) return;

        ocrText = ocrResult?.text || '';
        ocrMethod = ocrResult?.method || null;

        if (!ocrText.trim()) {
          await base44.entities.Document.update(docId, { status: 'failed' });
          queryClient.invalidateQueries({ queryKey: ['documents'] });
          if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
          toast({
            variant: 'destructive',
            title: 'OCR Failed',
            description: 'Unable to extract text from this document. Try a clearer image.',
          });
          return;
        }
      }

      // 4. Run PHI extraction pipeline
      setReprocessStatus('Extracting fields...');
      if (abortController.signal.aborted) return;

      const extractionResult = await extractPHIData(signed_url, docFileType, ocrText || undefined);
      if (abortController.signal.aborted) return;

      const hasFields = extractionResult?.fields && Object.keys(extractionResult.fields).length > 0;
      const hasMissing = Array.isArray(extractionResult?.missing) && extractionResult.missing.length > 0;

      if (extractionResult?.success || hasFields || hasMissing) {
        const fieldsWithMissing = { ...(extractionResult.fields || {}) };
        (extractionResult.missing || []).forEach((fieldName) => {
          if (!fieldsWithMissing[fieldName]) {
            fieldsWithMissing[fieldName] = {
              value: '',
              confidence: 0,
              userCorrected: false,
              isMissing: true,
            };
          }
        });

        const extractedPayload = {
          fields: fieldsWithMissing,
          documentId: docId,
          organizationId: docOrgId,
          extractionMethod: ocrMethod ? `ocr-${ocrMethod}` : extractionResult.method,
          userCorrectedFields: [],
          missingFields: extractionResult.missing || [],
        };

        setExtractedData(extractedPayload);
        setShowReviewDialog(true);
      } else {
        await base44.entities.Document.update(docId, { status: 'uploaded' });
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
        toast({
          variant: 'destructive',
          title: 'No Data Found',
          description: 'Could not extract PHI from this document.',
        });
      }
    } catch (error) {
      // Reset status on error
      try {
        await base44.entities.Document.update(docId, { status: 'failed' });
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
      } catch (updateErr) {
        console.warn('[DocumentItem] Failed to update document status:', updateErr);
      }
      toast({
        variant: 'destructive',
        title: 'Reprocessing Failed',
        description: error?.message || 'Please try again.',
      });
    } finally {
      setIsReprocessing(false);
      setReprocessStatus('');
      setReprocessAbortController(null);
    }
  };

  // Update a field in extracted data
  const updateField = (fieldKey, newValue) => {
    if (!extractedData) return;

    setExtractedData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        fields: {
          ...prev.fields,
          [fieldKey]: {
            ...prev.fields[fieldKey],
            value: newValue,
            confidence: 1.0,
            userCorrected: true,
            isMissing: false
          }
        },
        userCorrectedFields: [...new Set([...(prev.userCorrectedFields || []), fieldKey])]
      };
    });
  };

  // Remove a field from extracted data
  const removeField = (fieldKey) => {
    if (!extractedData) return;

    setExtractedData(prev => {
      if (!prev) return prev;
      const newFields = { ...prev.fields };
      delete newFields[fieldKey];
      return { ...prev, fields: newFields };
    });
  };

  // Save extracted data to organization profile
  const confirmAndSave = async () => {
    if (!extractedData) return;

    // Check for still-missing required fields
    const stillMissing =
      extractedData.missingFields?.filter(fieldName => {
        const field = extractedData.fields[fieldName];
        return !field || !field.value || (typeof field.value === 'string' && field.value.trim() === '');
      }) || [];

    if (stillMissing.length > 0) {
      toast({
        variant: 'destructive',
        title: 'Required Fields Missing',
        description: `Please fill in: ${stillMissing.map(f => f.replace(/_/g, ' ')).join(', ')}`,
      });
      return;
    }

    // Build update data with field mapping
    const updateData = {};
    const fieldMapping = {
      name: 'name',
      full_name: 'name',
      date_of_birth: 'date_of_birth',
      dob: 'date_of_birth',
      ssn: 'ssn',
      social_security: 'ssn',
      green_card_number: 'green_card_number',
      address: 'address',
      street_address: 'address',
      city: 'city',
      state: 'state',
      zip: 'zip',
      zip_code: 'zip',
      postal_code: 'zip',
      email: 'email',
      phone: 'phone',
      phone_number: 'phone',
      age: 'age',
      id_number: 'drivers_license_number'
    };

    Object.entries(extractedData.fields).forEach(([key, data]) => {
      const mappedKey = fieldMapping[String(key).toLowerCase()];
      if (mappedKey && data?.value && (typeof data.value !== 'string' || data.value.trim() !== '')) {
        if (mappedKey === 'age') {
          const parsed = parseInt(data.value, 10);
          if (!isNaN(parsed)) updateData[mappedKey] = parsed;
        } else {
          updateData[mappedKey] = data.value;
        }
      }
    });

    // Call parent update handler if provided
    if (typeof onProfileUpdate === 'function') {
      onProfileUpdate({
        id: extractedData.organizationId,
        data: updateData
      });
    } else {
      try {
        await base44.entities.Organization.update(extractedData.organizationId, updateData);
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
      } catch (err) {
        console.error('[DocumentItem] Profile update failed:', err);
      }
    }

    // Update document metadata with extraction info
    try {
      await base44.entities.Document.update(docId, {
        status: 'processed',
        harvested_data: JSON.stringify({
          extractionMethod: extractedData.extractionMethod,
          fieldCount: Object.keys(extractedData.fields || {}).length,
          userCorrectedCount: (extractedData.userCorrectedFields || []).length,
          reprocessedAt: new Date().toISOString()
        })
      });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (docOrgId) queryClient.invalidateQueries({ queryKey: ['documents', docOrgId] });
    } catch {
      // non-fatal
    }

    const fieldCount = Object.keys(updateData).length;
    toast({
      title: 'Profile Updated',
      description: `${fieldCount} field${fieldCount !== 1 ? 's' : ''} extracted and saved`,
    });

    setShowReviewDialog(false);
    setExtractedData(null);
  };

  // Format document type for display
  const formatDocType = (type) => {
    if (!type) return 'Document';
    return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  // Cap very large field sets in review to avoid UI jank (keep structure identical otherwise)
  const reviewEntries = extractedData ? Object.entries(extractedData.fields).slice(0, 200) : [];

  return (
    <Card
      className="flex flex-col h-full hover:shadow-lg transition-all duration-200"
      role="article"
      aria-label={`Document: ${docTitle}`}
    >
      <CardHeader className="flex-row items-center gap-4 space-y-0 pb-3">
        <DocumentPreview fileType={document?.file_type} size="md" />

        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Input
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveRename();
                  if (e.key === 'Escape') handleCancelRename();
                }}
                className="h-8 text-sm"
                autoFocus
                disabled={renameMutation.isPending}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleSaveRename}
                disabled={renameMutation.isPending}
                className="h-8 w-8 p-0"
                aria-label="Save title"
              >
                <Check className="w-4 h-4 text-green-600" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelRename}
                disabled={renameMutation.isPending}
                className="h-8 w-8 p-0"
                aria-label="Cancel edit title"
              >
                <X className="w-4 h-4 text-red-600" />
              </Button>
            </div>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base leading-tight truncate">
                      {docTitle}
                    </CardTitle>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsEditing(true)}
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Edit title"
                    >
                      <Edit className="w-3 h-3" />
                    </Button>
                  </div>
                </TooltipTrigger>
                {docTitle.length > 40 && (
                  <TooltipContent>
                    <p className="max-w-xs">{docTitle}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}

          <p className="text-xs text-slate-500 mt-1">
            {formatDocType(document?.document_type)}
          </p>
        </div>
      </CardHeader>

      <CardContent className="flex-grow space-y-3 pb-3">
        {document?.description && (
          <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
            {document.description}
          </p>
        )}

        {Array.isArray(document?.tags) && document.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {document.tags.slice(0, 3).map((tag, idx) => (
              <Badge
                key={`tag-${idx}-${String(tag)}`}
                variant="secondary"
                className="text-xs px-2 py-0"
                title={tag}
              >
                {tag}
              </Badge>
            ))}
            {document.tags.length > 3 && (
              <Badge variant="outline" className="text-xs px-2 py-0">
                +{document.tags.length - 3}
              </Badge>
            )}
          </div>
        )}

        <div className="space-y-1 text-xs text-slate-500">
          <p>
            Uploaded: {isValidDate(document?.created_date)
              ? format(new Date(document.created_date), 'MMM dd, yyyy')
              : 'Unknown date'}
          </p>

          {document?.file_size && (
            <p>Size: {formatFileSize(document.file_size)}</p>
          )}

          {document?.status && document.status !== 'uploaded' && (
            <div className="flex items-center gap-1">
              {document.status === 'processing' && (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Processing...</span>
                </>
              )}
              {document.status === 'processed' && (
                <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                  ✓ Processed
                </Badge>
              )}
              {document.status === 'failed' && (
                <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                  ✗ Processing Failed
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex gap-2 pt-3 border-t border-slate-100">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={getSignedUrlAndDownload}
                disabled={isDownloading}
                aria-label={`Download ${docTitle}`}
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="w-3 h-3 mr-2" />
                    Download
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Download this document</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => reparseMutation.mutate()}
                disabled={reparseMutation.isPending || document?.status === 'processing'}
                title="Re-parse with AI"
                className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                aria-label="Re-parse with AI"
              >
                <RefreshCw className={`w-4 h-4 ${reparseMutation.isPending ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Re-parse with AI</p>
            </TooltipContent>
          </Tooltip>

          {isReprocessing ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleStopReprocess}
                  title="Stop Processing"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  aria-label="Stop Processing"
                >
                  <StopCircle className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Stop: {reprocessStatus}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleReprocessPHI}
                  disabled={document?.status === 'processing'}
                  title="Re-Process PHI with OCR"
                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  aria-label="Re-Process PHI (OCR)"
                >
                  <FileSearch className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Re-Process PHI (OCR)</p>
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(document)}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                aria-label={`Delete ${docTitle}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Delete this document</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </CardFooter>

      {/* PHI Review Dialog */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review Extracted PHI Data</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-slate-600 mb-4">
            Review the extracted information from "{docTitle}". Click edit to correct errors before saving.
          </p>

          {extractedData && (
            <div className="text-xs text-slate-500 mb-3 flex items-center gap-4 flex-wrap">
              <span>Method: {extractedData.extractionMethod}</span>
              <span>Fields: {Object.keys(extractedData.fields).length}</span>
              {extractedData.missingFields && extractedData.missingFields.length > 0 && (
                <span className="text-red-600 font-medium">
                  Missing: {extractedData.missingFields.length} required field(s)
                </span>
              )}
            </div>
          )}

          <div className="space-y-2">
            {reviewEntries.map(([key, data]) => (
              <EditableExtractedField
                key={`field-${key}`}
                fieldKey={key}
                fieldName={key}
                value={data?.value || ''}
                confidence={data?.confidence || 0}
                userCorrected={data?.userCorrected || false}
                isMissing={data?.isMissing || false}
                onChange={(newValue) => updateField(key, newValue)}
                onRemove={() => removeField(key)}
              />
            ))}
          </div>

          {extractedData && extractedData.missingFields && extractedData.missingFields.length > 0 && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                <strong>Missing Required Fields:</strong> Please fill in the fields marked with red asterisks.
              </p>
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowReviewDialog(false)}>
              Cancel
            </Button>
            <Button onClick={confirmAndSave}>
              <Check className="w-4 h-4 mr-2" />
              Save to Profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}