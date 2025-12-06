import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UploadCloud, FileUp } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { useThemeSettings } from '@/components/theme/ThemeSettingsProvider';

// Subcomponents
import AIExplanationBanner from './harvester/AIExplanationBanner';
import ProcessingQueueItem from './harvester/ProcessingQueueItem';
import {
  validateDocumentFile,
  formatFileSize,
  ALLOWED_EXTENSIONS
} from './harvester/FileValidation';

const MAX_FILES = 25;

export default function DocumentHarvester({ organizationId, organizationName }) {
  const [files, setFiles] = useState([]);
  const [documentType, setDocumentType] = useState('other');
  const [processingDocs, setProcessingDocs] = useState([]);
  const [validationError, setValidationError] = useState(null);
  const [extractFacts, setExtractFacts] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { accentColor, themeClasses } = useThemeSettings();

  // SECURITY: Log organization context for document uploads
  console.log('[DocumentHarvester] Initialized for organization:', { organizationId, organizationName });

  const mutation = useMutation({
    mutationFn: async ({ file, title, documentType: docType }) => {
      // SECURITY CHECK: Verify organizationId is set
      if (!organizationId || typeof organizationId !== 'string') {
        throw new Error('SECURITY: No valid organization ID - cannot upload document');
      }

      // Helpers for telemetry (prefer cloud functions with body; fallback to LLM logger)
      const logEvent = async (event, payload = {}) => {
        try {
          const invoke = base44?.functions?.invoke;
          if (typeof invoke === 'function') {
            await invoke('logTelemetry', { body: { event, ...payload } });
            return;
          }
        } catch {
          // swallow and fallback
        }
        try {
          const llm = base44?.integrations?.Core?.InvokeLLM;
          if (typeof llm === 'function') {
            await llm({
              prompt: `Log event: ${event} ${JSON.stringify(payload)}`,
              response_json_schema: { type: 'object', properties: {} }
            });
          }
        } catch (e) {
          console.warn('[DocumentHarvester] Telemetry logging failed:', e);
        }
      };

      const makeId = () => {
        try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
      };

      console.log('[DocumentHarvester] Uploading document for org:', organizationId);
      const docId = makeId();
      const startTime = Date.now();

      // Normalize title
      const safeTitle = typeof title === 'string' ? title.trim() : (file?.name || 'Untitled');

      await logEvent('document_upload_started', { file: file?.name, org: organizationId });

      // Add to processing queue
      setProcessingDocs(prev => [...prev, {
        id: docId,
        name: safeTitle,
        status: 'uploading',
        file,
        title: safeTitle,
        documentType: docType
      }]);

      try {
        // Upload file (guard service availability)
        const uploader = base44?.integrations?.Core?.UploadPrivateFile;
        if (typeof uploader !== 'function') throw new Error('Upload service unavailable.');
        const uploadResp = await uploader({ file });
        const file_uri = uploadResp?.file_uri;
        if (!file_uri) throw new Error('Upload failed (no file_uri)');

        // Update status to extracting
        setProcessingDocs(prev => prev.map(doc =>
          doc.id === docId ? { ...doc, status: 'extracting' } : doc
        ));

        // Extract data using AI (guard service availability)
        const extractor = base44?.integrations?.Core?.ExtractDataFromUploadedFile;
        if (typeof extractor !== 'function') throw new Error('Extraction service unavailable.');

        const extractionResult = await extractor({
          file_url: file_uri,
          json_schema: {
            type: 'object',
            properties: {
              full_text: {
                type: 'string',
                description: 'The full, plain text content of the entire document.'
              }
            }
          }
        });

        // Envelope/legacy support
        const isError = extractionResult?.status === 'error' || extractionResult?.error;
        if (isError) {
          throw new Error(extractionResult?.details || extractionResult?.error || 'Failed to extract data from document.');
        }

        const extractedOutput = extractionResult?.output ?? extractionResult?.data ?? {};
        const extractedText = extractedOutput?.full_text || '';

        // Safe JSON for harvested_data
        let harvestedJson = '{}';
        try {
          harvestedJson = JSON.stringify(extractedOutput);
        } catch {
          harvestedJson = JSON.stringify({ full_text: extractedText });
        }

        // Create document record - SECURITY: Always use the organizationId from props
        console.log('[DocumentHarvester] Creating document record for org:', organizationId);
        const createdDoc = await base44.entities.Document.create({
          organization_id: organizationId,
          title: safeTitle,
          document_type: docType,
          file_uri,
          file_type: file?.type || 'application/octet-stream',
          harvested_data: harvestedJson,
          status: 'processed'
        });
        console.log('[DocumentHarvester] Document created:', { docId: createdDoc?.id, orgId: organizationId });

        // Update organization with extracted text - SECURITY: Verify org ID matches
        const org = await base44.entities.Organization.get(organizationId);
        if (!org || org.id !== organizationId) {
          throw new Error('SECURITY: Organization ID mismatch - aborting');
        }

        const updatedOrgData = {
          additional_data: (org?.additional_data || '') +
            `\n\n--- Document: ${safeTitle} ---\n\n` + extractedText,
        };
        await base44.entities.Organization.update(organizationId, updatedOrgData);

        // NEW: Extract structured facts if enabled
        if (extractFacts) {
          try {
            setProcessingDocs(prev => prev.map(doc =>
              doc.id === docId ? { ...doc, status: 'extracting_facts' } : doc
            ));

            const invoke = base44?.functions?.invoke;
            if (typeof invoke !== 'function') throw new Error('Facts function unavailable.');
            const result = await invoke('processDocumentForFacts', {
              body: { file_uri, organization_id: organizationId, source_type: 'document' }
            });
            const factError = result?.error;
            if (factError) throw factError;

            console.log('[DocumentHarvester] Fact extraction completed for', file?.name, result?.data);
          } catch (factError) {
            console.warn('[DocumentHarvester] Fact extraction failed:', factError);
            // Don't fail the whole upload if fact extraction fails
          }
        }

        const duration = Math.floor((Date.now() - startTime) / 1000);
        await logEvent('document_extraction_succeeded', { file: file?.name, org: organizationId, duration });

        return { docId, success: true };
      } catch (error) {
        await logEvent('document_extraction_failed', { file: file?.name, org: organizationId, error: error?.message });

        setProcessingDocs(prev => prev.map(doc =>
          doc.id === docId ? { ...doc, status: 'failed', error: error?.message } : doc
        ));
        throw error;
      }
    },
    onSuccess: ({ docId }) => {
      setProcessingDocs(prev => prev.map(doc =>
        doc.id === docId ? { ...doc, status: 'success' } : doc
      ));

      // Precise invalidations
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      if (organizationId) queryClient.invalidateQueries({ queryKey: ['documents', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });

      // Remove from list after 5 seconds
      setTimeout(() => {
        setProcessingDocs(prev => prev.filter(doc => doc.id !== docId));
      }, 5000);
    },
    onError: (err, variables) => {
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: `Failed to process ${variables?.title || variables?.file?.name}: ${err?.message || 'Unknown error'}`,
      });
    }
  });

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    setValidationError(null);

    if (selectedFiles.length === 0) {
      setFiles([]);
      return;
    }

    // Cap total files
    if (selectedFiles.length > MAX_FILES) {
      setValidationError(`You can upload up to ${MAX_FILES} files at a time.`);
      setFiles([]);
      return;
    }

    // Validate all files
    const validFiles = [];
    const errors = [];

    for (const file of selectedFiles) {
      const validation = validateDocumentFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        errors.push(`${file.name}: ${validation.error}`);
      }
    }

    if (errors.length > 0) {
      setValidationError(errors.join('\n'));
      setFiles([]);
      return;
    }

    setFiles(validFiles);
  };

  const handleHarvest = () => {
    if (!organizationId) {
      toast({
        variant: 'destructive',
        title: 'No Profile Selected',
        description: 'Please select a profile first.',
      });
      return;
    }

    if (files.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Files Selected',
        description: 'Please select at least one file to upload.',
      });
      return;
    }

    // Validate all files one more time before submission
    const invalidFiles = files.filter(file => !validateDocumentFile(file).valid);
    if (invalidFiles.length > 0) {
      setValidationError(`Invalid files: ${invalidFiles.map(f => f.name).join(', ')}`);
      return;
    }

    // Start processing all files (cap to MAX_FILES)
    const batch = files.slice(0, MAX_FILES);
    batch.forEach(file => {
      const title = (file.name || 'Untitled').replace(/\.[^/.]+$/, '');
      mutation.mutate({ file, title, documentType });
    });

    // Show success toast
    toast({
      title: '✅ Processing Documents',
      description: `Starting to process ${batch.length} document${batch.length > 1 ? 's' : ''}...`,
    });

    // Reset the form immediately
    setFiles([]);
    setDocumentType('other');
    setValidationError(null);

    // Reset file input
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.value = '';
  };

  const handleRetry = (doc) => {
    if (doc?.file && doc?.title) {
      mutation.mutate({
        file: doc.file,
        title: doc.title,
        documentType: doc.documentType
      });

      // Remove failed doc from queue
      setProcessingDocs(prev => prev.filter(d => d.id !== doc.id));
    }
  };

  const handleRemove = (docId) => {
    setProcessingDocs(prev => prev.filter(doc => doc.id !== docId));
  };

  const handleRemoveFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <Card className={`${themeClasses.surface} border border-transparent`}>
      <CardHeader className="border-b border-white/10 backdrop-blur-sm bg-white/5">
        <CardTitle className="flex items-center gap-2 text-base" style={{ color: accentColor }}>
          <FileUp className="w-5 h-5" />
          Upload Documents for AI Extraction
        </CardTitle>
        <CardDescription className="text-xs">
          Upload one or multiple documents to enrich your profile. AI will extract all text and add it to your background data.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* AI Explanation */}
        <AIExplanationBanner />

        {/* File Upload */}
        <div className="space-y-2">
          <Label htmlFor="file-upload">Document Files *</Label>
          <Input
            id="file-upload"
            type="file"
            onChange={handleFileChange}
            className="pt-2 cursor-pointer"
            accept={ALLOWED_EXTENSIONS.join(',')}
            multiple
            aria-invalid={validationError ? 'true' : 'false'}
            aria-describedby={validationError ? 'file-error' : undefined}
          />

        {files.length > 0 && !validationError && (
            <div className="space-y-2 mt-3">
              <p className="text-sm font-medium text-slate-700">
                Selected Files ({files.length}):
              </p>
              <div className="space-y-1">
                {files.map((file, index) => (
                  <div key={`file-${index}-${file.name}`} className="flex items-center justify-between p-2 bg-white rounded border">
                    <div className="flex items-center gap-2 flex-1">
                      <FileUp className="w-4 h-4 text-blue-600" />
                      <span className="text-sm font-medium">{file.name}</span>
                      <span className="text-xs text-slate-500">({formatFileSize(file.size)})</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveFile(index)}
                      className="h-6 w-6 p-0"
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {validationError && (
            <Alert variant="destructive" id="file-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="whitespace-pre-line">{validationError}</AlertDescription>
            </Alert>
          )}

          <p className="text-xs text-slate-500">
            Allowed: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG • Max size per file: 10MB • Multiple files supported
          </p>
        </div>

        {/* Document Type */}
        <div className="space-y-2">
          <Label htmlFor="doc-type">Document Type (applies to all selected files)</Label>
          <Select value={documentType} onValueChange={setDocumentType}>
            <SelectTrigger id="doc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="resume">Resume/CV</SelectItem>
              <SelectItem value="irs_determination">IRS Determination Letter</SelectItem>
              <SelectItem value="financial_statement">Financial Statement</SelectItem>
              <SelectItem value="audit">Audit Report</SelectItem>
              <SelectItem value="letter_of_support">Letter of Support</SelectItem>
              <SelectItem value="mou">MOU/Agreement</SelectItem>
              <SelectItem value="logic_model">Logic Model</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* NEW: Fact Extraction Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg" style={{ backgroundColor: `${accentColor}15`, borderColor: `${accentColor}30`, borderWidth: '1px' }}>
          <div className="flex-1">
            <Label htmlFor="extract-facts" className="text-sm font-semibold cursor-pointer">
              Extract Structured Facts
            </Label>
            <p className="text-xs opacity-70 mt-1">
              AI highlights your EIN, nonprofit status, and other identifiers automatically.
            </p>
            <p className="text-xs opacity-70 mt-1">
              Turn this off if you only need raw text extraction.
            </p>
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="extract-facts"
              checked={extractFacts}
              onChange={(e) => setExtractFacts(e.target.checked)}
              className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
            />
          </div>
        </div>

        {/* Upload Button */}
        <Button
          onClick={handleHarvest}
          disabled={files.length === 0 || !!validationError || mutation.isPending}
          className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
          aria-label="Upload and process documents"
        >
          <UploadCloud className="w-4 h-4 mr-2" />
          Upload & Process {files.length > 0 ? `${files.length} Document${files.length > 1 ? 's' : ''}` : 'Documents'}
        </Button>

        {/* Processing Queue */}
        {processingDocs.length > 0 && (
          <div className="mt-4 pt-4 border-t border-blue-200 space-y-3">
            <p className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <span>Processing Queue</span>
              <span className="text-xs font-normal text-slate-500">
                ({processingDocs.length} {processingDocs.length === 1 ? 'document' : 'documents'})
              </span>
            </p>

            <div className="space-y-2">
              {processingDocs.map(doc => (
                <ProcessingQueueItem
                  key={`proc-${String(doc.id)}`}
                  doc={doc}
                  onRetry={handleRetry}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}