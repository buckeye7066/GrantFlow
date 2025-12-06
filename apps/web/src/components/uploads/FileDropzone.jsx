import React, { useCallback, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Upload, CheckCircle2, X, AlertCircle } from 'lucide-react';
import { validateFile, formatFileSize } from './fileValidation';

/**
 * FileDropzone - Drag-and-drop file upload component with validation
 * @param {Object} props
 * @param {File|null} props.file - Currently selected file
 * @param {Function} props.onFileSelect - Callback when file is selected
 * @param {Function} props.onFileRemove - Callback when file is removed
 * @param {boolean} props.disabled - Whether upload is disabled
 * @param {string} props.error - External error message to display
 * @param {string} props.accept - Accepted file types
 */
export default function FileDropzone({ 
  file, 
  onFileSelect, 
  onFileRemove,
  disabled = false,
  error: externalError,
  accept = 'image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState(null);

  const handleFileChange = useCallback((selectedFile) => {
    if (!selectedFile) return;

    // Validate file
    const validation = validateFile(selectedFile);
    
    if (!validation.isValid) {
      setValidationError(validation.error);
      return;
    }

    // Clear any previous errors
    setValidationError(null);
    onFileSelect(selectedFile);
  }, [onFileSelect]);

  const handleInputChange = (e) => {
    const selectedFile = e.target.files?.[0];
    handleFileChange(selectedFile);
  };

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);

    if (disabled) return;

    const droppedFile = e.dataTransfer.files?.[0];
    handleFileChange(droppedFile);
  }, [disabled, handleFileChange]);

  const handleRemove = () => {
    setValidationError(null);
    onFileRemove();
  };

  const handlePaste = useCallback(async (e) => {
    if (disabled) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const pastedFile = item.getAsFile();
        if (pastedFile) {
          handleFileChange(pastedFile);
        }
        return;
      }
    }
  }, [disabled, handleFileChange]);

  const handleContextMenu = useCallback(async (e) => {
    if (disabled) return;
    
    // Try to read from clipboard on right-click
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (imageType) {
          e.preventDefault();
          const blob = await item.getType(imageType);
          const pastedFile = new File([blob], `screenshot-${Date.now()}.png`, { type: imageType });
          handleFileChange(pastedFile);
          return;
        }
      }
    } catch (err) {
      // Clipboard API not available or permission denied - allow default context menu
    }
  }, [disabled, handleFileChange]);

  const displayError = externalError || validationError;

  return (
    <div className="space-y-3">
      <Label htmlFor="application-file" className="text-base font-semibold">
        Upload Completed Application Form
      </Label>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
        onContextMenu={handleContextMenu}
        tabIndex={0}
        className={`
          relative border-2 border-dashed rounded-lg transition-all
          ${isDragging && !disabled ? 'border-blue-500 bg-blue-50' : 'border-slate-300'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50'}
          ${displayError ? 'border-red-300 bg-red-50' : ''}
        `}
      >
        <label 
          htmlFor="application-file" 
          className={`flex flex-col items-center justify-center w-full h-40 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <div className="flex flex-col items-center justify-center pt-5 pb-6">
            {file ? (
              <>
                <CheckCircle2 className="w-10 h-10 mb-3 text-green-600" />
                <p className="font-semibold text-green-700 text-center px-4">
                  {file.name}
                </p>
                <p className="text-sm text-slate-500 mt-1">
                  {formatFileSize(file.size)}
                </p>
                {!disabled && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleRemove();
                    }}
                    className="mt-3 text-sm text-red-600 hover:text-red-700 underline"
                    aria-label="Remove file"
                  >
                    Remove file
                  </button>
                )}
              </>
            ) : (
              <>
                <Upload className={`w-10 h-10 mb-3 ${isDragging ? 'text-blue-500' : 'text-slate-400'}`} />
                <p className="mb-2 text-sm text-slate-500">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-slate-500">
                  Right-click or Ctrl+V to paste a screenshot (Max 10MB)
                </p>
              </>
            )}
          </div>
          <Input
            id="application-file"
            type="file"
            className="hidden"
            onChange={handleInputChange}
            accept={accept}
            disabled={disabled}
            aria-describedby={displayError ? 'file-error' : undefined}
          />
        </label>
      </div>

      {displayError && (
        <Alert variant="destructive" id="file-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}