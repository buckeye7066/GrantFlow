import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Upload, Loader2, Check, X, Edit2, AlertTriangle, CheckCircle, Clipboard } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import EditableExtractedField from './EditableExtractedField';
import { validatePHIFile, PHI_ACCEPTED_TYPES } from './phiFileValidation';
import { extractPHIData } from './phiExtractionPipeline';
import { runHybridOCR, requiresOCR } from './hybridOCR';

/**
 * PHIDocumentUploader - HIPAA-grade PHI document intake system
 * Supports images, PDFs, Office documents with confidence scoring and inline editing
 * Features: drag-drop, Ctrl+V paste, right-click context menu paste
 */
export default function PHIDocumentUploader({ 
  organization, 
  onUpdate, 
  disabled = false 
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [extractedData, setExtractedData] = useState(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);
  const { toast } = useToast();

  // Close context menu on outside click
  useEffect(() => {
    const handleClickOutside = () => setShowContextMenu(false);
    if (showContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showContextMenu]);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    
    // SECURITY: Verify organization context before processing
    if (!organization?.id) {
      console.error('[PHIDocumentUploader] ❌ CRITICAL: No organization ID - cannot process document');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No profile selected. Cannot upload document.',
      });
      return;
    }
    
    console.log('[PHIDocumentUploader] Processing file for organization:', { 
      orgId: organization.id, 
      orgName: organization.name,
      fileName: file.name 
    });

    const validation = validatePHIFile(file);
    if (!validation.isValid) {
      toast({
        variant: 'destructive',
        title: 'Invalid File',
        description: validation.error,
      });
      return;
    }

    setIsUploading(true);
    setUploadProgress('Uploading document...');

    try {
      const uploadResponse = await base44.integrations.Core.UploadFile({ file });
      const fileUrl = uploadResponse?.file_url;

      if (!fileUrl) {
        throw new Error('File upload failed - no URL returned');
      }

      // Run hybrid OCR for image files
      let ocrText = null;
      let ocrMethod = null;
      
      if (requiresOCR(file.type)) {
        setUploadProgress('Running OCR... (server)');
        const ocrResult = await runHybridOCR(file, fileUrl);
        ocrText = ocrResult.text;
        ocrMethod = ocrResult.method;
        
        if (ocrMethod === 'tesseract') {
          setUploadProgress('Running OCR... (local fallback)');
        }
        
        if (!ocrText || ocrText.trim().length === 0) {
          toast({
            variant: 'destructive',
            title: 'OCR Failed',
            description: 'Unable to extract text from document. Try a clearer image.',
          });
          return;
        }
      }

      setUploadProgress('Analyzing document...');

      // Use multi-stage extraction pipeline with OCR text if available
      const extractionResult = await extractPHIData(fileUrl, file.type, ocrText);

      if (extractionResult.success || extractionResult.missing?.length > 0) {
        const uploadTimestamp = new Date().toISOString();

        // Add missing required fields as empty entries for user to fill
        const fieldsWithMissing = { ...extractionResult.fields };
        if (extractionResult.missing && extractionResult.missing.length > 0) {
          extractionResult.missing.forEach(fieldName => {
            if (!fieldsWithMissing[fieldName]) {
              fieldsWithMissing[fieldName] = {
                value: '',
                confidence: 0,
                userCorrected: false,
                isMissing: true
              };
            }
          });
        }

        setExtractedData({ 
          fields: fieldsWithMissing, 
          fileUrl, 
          fileName: file.name,
          fileType: file.type,
          uploadTimestamp,
          extractionMethod: extractionResult.method,
          userCorrectedFields: [],
          missingFields: extractionResult.missing || []
        });
        setShowReviewDialog(true);
      } else {
        toast({
          variant: 'destructive',
          title: 'No Data Found',
          description: 'Could not extract information from this document. Try a clearer image or different format.',
        });
      }
    } catch (error) {
      // Log without PHI
      console.error('[PHIDocumentUploader] Processing error occurred');
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: 'Failed to process document. Please try again.',
      });
    } finally {
      setIsUploading(false);
      setUploadProgress('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [toast]);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handlePaste = useCallback(async (e) => {
    if (disabled || isUploading) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const pastedFile = item.getAsFile();
        if (pastedFile) {
          processFile(pastedFile);
        }
        return;
      }
    }
  }, [disabled, isUploading, processFile]);

  const handleButtonClick = () => {
    // Only open file picker on click - never auto-read clipboard
    fileInputRef.current?.click();
  };

  const handleContextMenu = (e) => {
    if (disabled || isUploading) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const handlePasteFromContextMenu = async () => {
    setShowContextMenu(false);
    
    try {
      const clipboardItems = await navigator.clipboard.read();
      
      for (const item of clipboardItems) {
        // Check for PNG first, then other image types
        if (item.types.includes('image/png')) {
          const blob = await item.getType('image/png');
          const pastedFile = new File([blob], `phi-screenshot-${Date.now()}.png`, { type: 'image/png' });
          processFile(pastedFile);
          return;
        }
        
        // Check for other image types
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split('/')[1] || 'png';
          const pastedFile = new File([blob], `phi-screenshot-${Date.now()}.${ext}`, { type: imageType });
          processFile(pastedFile);
          return;
        }
      }
      
      // No image found in clipboard
      toast({
        title: 'No Image Found',
        description: 'Clipboard does not contain an image.',
      });
    } catch (err) {
      // Clipboard API not available or permission denied
      toast({
        variant: 'destructive',
        title: 'Clipboard Access Denied',
        description: 'Browser does not permit clipboard access. Try using Ctrl+V instead.',
      });
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!disabled && !isUploading) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (disabled || isUploading) return;
    
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const updateField = (fieldKey, newValue) => {
    if (!extractedData) return;
    
    setExtractedData(prev => ({
      ...prev,
      fields: {
        ...prev.fields,
        [fieldKey]: {
          ...prev.fields[fieldKey],
          value: newValue,
          confidence: 1.0, // User-corrected = 100% confidence
          userCorrected: true
        }
      },
      userCorrectedFields: [...new Set([...prev.userCorrectedFields, fieldKey])]
    }));
  };

  const removeField = (fieldKey) => {
    if (!extractedData) return;
    
    const newFields = { ...extractedData.fields };
    delete newFields[fieldKey];
    setExtractedData(prev => ({
      ...prev,
      fields: newFields
    }));
  };

  const confirmAndSave = async () => {
    if (!extractedData) return;

    // Check if any missing fields still have no value
    const stillMissing = extractedData.missingFields?.filter(fieldName => {
      const field = extractedData.fields[fieldName];
      return !field || !field.value || field.value.trim() === '';
    }) || [];

    if (stillMissing.length > 0) {
      toast({
        variant: 'destructive',
        title: 'Required Fields Missing',
        description: `Please fill in: ${stillMissing.map(f => f.replace(/_/g, ' ')).join(', ')}`,
      });
      return;
    }

    // Convert to flat object for update (PHI-safe field mapping)
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
      const mappedKey = fieldMapping[key.toLowerCase()];
      if (mappedKey && data.value && data.value.trim() !== '') {
        if (mappedKey === 'age') {
          const parsed = parseInt(data.value);
          if (!isNaN(parsed)) updateData[mappedKey] = parsed;
        } else {
          updateData[mappedKey] = data.value;
        }
      }
    });

    // SECURITY: Final verification before updating profile
    if (!organization?.id) {
      console.error('[PHIDocumentUploader] ❌ CRITICAL: Organization lost during processing');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Profile context lost. Please refresh and try again.',
      });
      return;
    }
    
    console.log('[PHIDocumentUploader] Saving data to organization:', { 
      orgId: organization.id, 
      orgName: organization.name,
      fields: Object.keys(updateData)
    });

    onUpdate({
      id: organization.id,
      data: updateData
    });

    // Save document record with metadata (no PHI in logs)
    try {
      const confidenceSummary = calculateConfidenceSummary(extractedData.fields);
      
      // Determine document type from extraction or default to 'other'
      const detectedDocType = extractedData.fields?.document_type?.value || 'other';
      
      console.log('[PHIDocumentUploader] Creating document record for org:', organization.id);
      await base44.entities.Document.create({
        organization_id: organization.id,
        organization_created_by: organization.created_by,
        title: extractedData.fileName || 'PHI Document',
        document_type: detectedDocType,
        file_uri: extractedData.fileUrl,
        file_type: extractedData.fileType,
        status: 'processed',
        description: 'PHI document - profile data extraction',
        harvested_data: JSON.stringify({
          extractionMethod: extractedData.extractionMethod,
          fieldCount: Object.keys(extractedData.fields).length,
          averageConfidence: confidenceSummary.average,
          userCorrectedCount: extractedData.userCorrectedFields.length,
          uploadTimestamp: extractedData.uploadTimestamp
        })
      });
      console.log('[PHIDocumentUploader] Document record created successfully');
    } catch (docError) {
      console.warn('[PHIDocumentUploader] Document record save issue');
    }

    const fieldCount = Object.keys(updateData).length;
    toast({
      title: 'Profile Updated',
      description: `${fieldCount} field${fieldCount !== 1 ? 's' : ''} saved to profile`,
    });

    setShowReviewDialog(false);
    setExtractedData(null);
  };

  const calculateConfidenceSummary = (fields) => {
    const values = Object.values(fields).map(f => f.confidence || 0);
    if (values.length === 0) return { average: 0, min: 0, max: 0 };
    return {
      average: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values)
    };
  };

  return (
    <>
      <div 
        ref={containerRef}
        onPaste={handlePaste}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        tabIndex={0}
        role="button"
        aria-label="Upload PHI Document - Click to browse, Ctrl+V to paste, or right-click for options"
        className={`inline-block focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded ${isDragging ? 'ring-2 ring-blue-500' : ''}`}
      >
        <Button 
          type="button"
          variant="outline" 
          size="sm" 
          disabled={isUploading || disabled}
          onClick={handleButtonClick}
          aria-busy={isUploading}
          aria-describedby="phi-upload-instructions"
        >
          {isUploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
              {uploadProgress || 'Processing...'}
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
              Upload PHI Document
            </>
          )}
        </Button>
        <span id="phi-upload-instructions" className="sr-only">
          Click to open file picker, press Ctrl+V to paste from clipboard, or right-click for paste option
        </span>
        <Input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          accept={PHI_ACCEPTED_TYPES}
          disabled={isUploading || disabled}
          aria-hidden="true"
        />
      </div>

      {/* Custom Context Menu */}
      {showContextMenu && (
        <div 
          className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-48"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          role="menu"
          aria-label="Upload options"
        >
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 flex items-center gap-2"
            onClick={handlePasteFromContextMenu}
            role="menuitem"
          >
            <Clipboard className="w-4 h-4" aria-hidden="true" />
            Paste Screenshot from Clipboard
          </button>
        </div>
      )}

      {/* Review Dialog */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review Extracted Data</DialogTitle>
          </DialogHeader>
          
          <p className="text-sm text-slate-600 mb-4">
            Review the extracted information. Click the edit icon to correct any errors before saving.
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
            {extractedData && Object.entries(extractedData.fields).map(([key, data]) => (
              <EditableExtractedField
                key={key}
                fieldKey={key}
                fieldName={key}
                value={data.value}
                confidence={data.confidence}
                userCorrected={data.userCorrected}
                isMissing={data.isMissing || false}
                onChange={(newValue) => updateField(key, newValue)}
                onRemove={() => removeField(key)}
              />
            ))}
          </div>

          {extractedData && extractedData.missingFields && extractedData.missingFields.length > 0 && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                <strong>Missing Required Fields:</strong> Please fill in the fields marked with red asterisks before saving.
              </p>
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowReviewDialog(false)}>
              Cancel
            </Button>
            <Button onClick={confirmAndSave}>
              <Check className="w-4 h-4 mr-2" aria-hidden="true" />
              Save to Profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}