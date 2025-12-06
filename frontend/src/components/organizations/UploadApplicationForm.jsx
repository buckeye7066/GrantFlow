import React, { useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { Upload, X, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

// Import modular components
import ProcessingSteps from '@/components/uploads/ProcessingSteps';
import UploadInstructions from '@/components/uploads/UploadInstructions';

// Hybrid OCR for scanned PDFs and images
import { runHybridOCR } from '@/components/uploads/hybridOCR';

/**
 * Processing status type
 * @typedef {'idle'|'uploading'|'processing'|'complete'|'error'} ProcessingStatus
 */

/**
 * UploadApplicationForm - Upload and AI-process a scanned application form
 * 
 * Features:
 * - Drag-and-drop file upload
 * - Real-time file validation
 * - Multi-step processing indicator
 * - Comprehensive error handling
 * - Accessibility support
 * 
 * @param {Object} props
 * @param {Function} props.onSuccess - Callback with created/updated organization
 * @param {Function} props.onCancel - Cancel button handler
 * @param {string|null} props.existingOrganizationId - ID if updating existing profile
 */
export default function UploadApplicationForm({ 
  onSuccess, 
  onCancel, 
  existingOrganizationId = null 
}) {
  const [file, setFile] = useState(null);
  const [processingStatus, setProcessingStatus] = useState('idle');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  
  // Direct file input ref - bypasses Base44 file proxy
  const fileInputRef = useRef(null);

  /**
   * Handle file selection from native input
   */
  const handleFileSelect = (selectedFile) => {
    if (!selectedFile) return;
    
    // Basic validation
    const allowedExtensions = /\.(pdf|jpg|jpeg|png|heic|heif|tif|tiff|gif|bmp|webp)$/i;
    const isValidExt = allowedExtensions.test(selectedFile.name);
    const isValidMime = selectedFile.type?.startsWith('image/') || selectedFile.type === 'application/pdf';
    
    if (!isValidExt && !isValidMime) {
      toast({
        variant: 'destructive',
        title: 'Invalid File Type',
        description: 'Please upload a PDF or image file (JPG, PNG, etc.)',
      });
      return;
    }
    
    if (selectedFile.size > 10 * 1024 * 1024) {
      toast({
        variant: 'destructive',
        title: 'File Too Large',
        description: 'File must be less than 10MB.',
      });
      return;
    }
    
    setFile(selectedFile);
  };

  /**
   * Handle file removal
   */
  const handleFileRemove = () => {
    setFile(null);
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Prevent double submission
    if (isSubmitting) return;

    // Validate file - accept common images/PDFs, even if MIME type is missing
    const allowedExtensions = /\.(pdf|jpg|jpeg|png|heic|heif|tif|tiff)$/i;
    const looksValid =
      file &&
      (allowedExtensions.test(file.name) ||
       file.type?.startsWith('image/') ||
       file.type === 'application/pdf');

    if (!file) {
      toast({
        variant: 'destructive',
        title: 'No File Selected',
        description: 'Please select a file to upload.',
      });
      return;
    }

    if (!looksValid) {
      console.warn('[UploadApplicationForm] Unknown file type. Attempting OCR anyway.');
    }

    setIsSubmitting(true);
    setProcessingStatus('uploading');

    try {
      // Step 1: Upload file
      toast({
        title: '📄 Uploading File...',
        description: 'Uploading your completed application form.',
      });

      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      
      setProcessingStatus('processing');

      // Step 2: Run Hybrid OCR (server first, fallback to Tesseract)
      toast({
        title: '🔍 Scanning Document...',
        description: 'Running OCR to extract text from your document.',
      });

      const ocrResult = await runHybridOCR(file, file_url);
      const { text: rawText, method: ocrMethod, hint } = ocrResult;

      if (!rawText || rawText.trim().length === 0) {
        // Provide specific error based on what went wrong
        const isHeic = file?.name?.toLowerCase().endsWith('.heic') || 
                       file?.name?.toLowerCase().endsWith('.heif') ||
                       file?.type === 'image/heic' || 
                       file?.type === 'image/heif';
        
        if (isHeic) {
          throw new Error('HEIC format not supported. Please convert to JPG/PNG first using your Photos app, then upload again.');
        }
        
        // Try one more time with just the file URL directly to the backend
        console.log('[UploadApplicationForm] OCR returned empty, trying direct backend processing...');
        toast({
          title: '🔄 Retrying with alternate method...',
          description: 'Attempting direct AI extraction from file.',
        });
        
        // Skip to backend processing - let it try with just the file URL
        const directResponse = await base44.functions.invoke('processScannedApplication', {
          file_url,
          organization_id: existingOrganizationId,
          ocr_text: '', // Empty - backend will try its own extraction
          skip_ocr_validation: true, // Tell backend to try anyway
        });
        
        if (directResponse.data?.success) {
          setProcessingStatus('complete');
          toast({
            title: '✅ Application Processed!',
            description: directResponse.data.message,
          });
          setTimeout(() => {
            onSuccess(directResponse.data.organization);
          }, 1000);
          return;
        }
        
        throw new Error(hint || 'Could not read the file. Please try:\n• Taking a clearer photo with better lighting\n• Converting to PDF\n• Using a scanner app');
      }

      console.log('[UploadApplicationForm] OCR complete via', ocrMethod, '- extracted', rawText.length, 'chars');

      // Step 3: Process with AI backend
      toast({
        title: '🤖 Processing Application...',
        description: 'AI is extracting information from your form. This may take 30-60 seconds.',
      });

      const response = await base44.functions.invoke('processScannedApplication', {
        file_url,
        organization_id: existingOrganizationId,
        ocr_text: rawText, // Pass OCR text to backend for enhanced extraction
      });

      console.log('[UploadApplicationForm] Function response:', response);

      // Handle response
      if (response.data.success) {
        setProcessingStatus('complete');
        
        toast({
          title: '✅ Application Processed!',
          description: response.data.message,
        });
        
        // Brief delay to show completion state
        setTimeout(() => {
          onSuccess(response.data.organization);
        }, 1000);
      } else {
        // Handle specific error types
        const errorMsg = response.data.error || 'Failed to process application';
        const errorDetails = response.data.details || '';
        
        throw new Error(errorDetails ? `${errorMsg}: ${errorDetails}` : errorMsg);
      }

    } catch (error) {
      console.error('[UploadApplicationForm] Processing error:', error);
      
      setProcessingStatus('error');
      
      // Extract detailed error message
      let errorMessage = 'Could not process the application. Please try again or enter information manually.';
      let errorDetails = '';
      
      if (error.response?.data) {
        const data = error.response.data;
        if (typeof data === 'string') {
          errorMessage = data;
        } else if (data.error) {
          errorMessage = data.error;
          errorDetails = data.details || '';
        } else if (data.message) {
          errorMessage = data.message;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      // Log full error for debugging
      console.error('[UploadApplicationForm] Full error object:', {
        message: errorMessage,
        details: errorDetails,
        response: error.response?.data,
        stack: error.stack
      });
      
      toast({
        variant: 'destructive',
        title: 'Processing Failed',
        description: errorDetails ? `${errorMessage}\n\n${errorDetails}` : errorMessage,
        duration: 10000, // Show for 10 seconds so user can read it
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isProcessing = processingStatus === 'uploading' || processingStatus === 'processing';
  const canSubmit = file && !isProcessing;

  return (
    <Card className="shadow-xl border-0">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Upload Completed Application</CardTitle>
          <CardDescription>
            {existingOrganizationId 
              ? 'Upload a completed application form to update this profile'
              : 'Upload a completed application form to create a new profile'
            }
          </CardDescription>
        </div>
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={onCancel} 
          disabled={isProcessing}
          aria-label="Close upload form"
        >
          <X className="w-5 h-5" />
        </Button>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Instructions */}
          <UploadInstructions />

          {/* Native File Input - bypasses Base44 file proxy */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,.gif,.bmp,.webp,image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const selectedFile = e.target.files?.[0];
              if (selectedFile) handleFileSelect(selectedFile);
            }}
            disabled={isProcessing}
          />

          {/* File Upload Area - Click to browse, Ctrl+V to paste, or drag/drop */}
          <div 
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            onPaste={(e) => {
              if (isProcessing) return;
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith('image/')) {
                  e.preventDefault();
                  const pastedFile = item.getAsFile();
                  if (pastedFile) handleFileSelect(pastedFile);
                  return;
                }
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (isProcessing) return;
              const droppedFile = e.dataTransfer.files?.[0];
              if (droppedFile) handleFileSelect(droppedFile);
            }}
            tabIndex={0}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center transition-all focus:ring-2 focus:ring-blue-500 focus:outline-none
              ${file ? 'border-green-300 bg-green-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'}
              ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {file ? (
              <div className="flex flex-col items-center">
                <CheckCircle2 className="w-10 h-10 text-green-600 mb-3" />
                <p className="font-semibold text-green-700">{file.name}</p>
                <p className="text-sm text-slate-500 mt-1">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
                {!isProcessing && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFileRemove();
                    }}
                    className="mt-3 text-sm text-red-600 hover:text-red-700 underline"
                  >
                    Remove file
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <Upload className="w-10 h-10 text-slate-400 mb-3" />
                <p className="text-sm text-slate-600">
                  <span className="font-semibold text-blue-600">Click to upload</span>, paste (Ctrl+V), or drag and drop
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  PDF, screenshots, or images (Max 10MB)
                </p>
              </div>
            )}
          </div>

          {/* Processing Status */}
          <ProcessingSteps 
            status={processingStatus}
            errorMessage="Could not process the application form"
          />

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setProcessingStatus('idle');
                setIsSubmitting(false);
                setFile(null);
                if (onCancel) onCancel();
              }}
              disabled={false}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Upload className="w-4 h-4 mr-2" />
              {isProcessing ? 'Processing...' : 'Process Application'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * TESTING NOTES:
 * 
 * Unit Tests:
 * - validateFile() with valid/invalid types
 * - validateFile() with oversized files
 * - formatFileSize() with various byte amounts
 * 
 * Integration Tests:
 * - Successful upload + AI processing flow
 * - File validation error display
 * - Processing status transitions
 * - Error handling for function failures
 * 
 * Accessibility Tests:
 * - Keyboard navigation (Tab, Enter, Escape)
 * - Screen reader announcements
 * - ARIA labels on all interactive elements
 * - Focus management during state changes
 */