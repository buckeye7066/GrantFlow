import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Upload, FileText, X, AlertCircle, Clipboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatFileSize } from '@/components/uploads/fileValidation';
import { useToast } from '@/components/ui/use-toast';

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/jpg'
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 25;

/**
 * FileDropzone - Drag-and-drop file upload with validation
 * @param {Object} props
 * @param {File[]} props.files - Currently selected files
 * @param {Function} props.onFilesChange - Callback when files change
 * @param {boolean} props.multiple - Allow multiple file selection
 * @param {boolean} props.disabled - Whether upload is disabled
 * @param {string} props.error - External error message
 */
export default function FileDropzone({
  files,
  onFilesChange,
  multiple = false,
  disabled = false,
  error
}) {
  // Normalize files prop
  const safeFiles = Array.isArray(files) ? files : [];
  const safeOnFilesChange = typeof onFilesChange === 'function' ? onFilesChange : () => {};

  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
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

  const validateOne = useCallback((file) => {
    if (!file || typeof file !== 'object') return 'Invalid file object';
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return `${file.name || 'File'}: Invalid file type. Allowed: PDF, DOCX, XLSX, PNG, JPG`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `${file.name || 'File'}: File too large. Maximum size is 5MB (file is ${formatFileSize(file.size)})`;
    }
    return null;
  }, []);

  const dedupeFiles = useCallback((arr) => {
    const seen = new Set();
    const out = [];
    for (const f of arr) {
      if (!f || typeof f !== 'object') continue;
      const key = `${f.name || ''}::${f.size || 0}::${f.lastModified || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(f);
      }
    }
    return out;
  }, []);

  const mergeAndLimit = useCallback((incoming) => {
    const merged = multiple ? dedupeFiles([...safeFiles, ...incoming]) : dedupeFiles(incoming.slice(0, 1));
    if (merged.length > MAX_FILES) {
      setValidationError(`You can upload up to ${MAX_FILES} files at a time.`);
      return merged.slice(0, MAX_FILES);
    }
    return merged;
  }, [safeFiles, multiple, dedupeFiles]);

  const handleFiles = useCallback(
    (newFilesLike) => {
      setValidationError(null);

      // Normalize to array
      let fileArray;
      try {
        fileArray = Array.from(newFilesLike || []);
      } catch {
        fileArray = [];
      }
      if (fileArray.length === 0) return;

      // Validate each file
      const errors = [];
      const validFiles = [];
      for (const file of fileArray) {
        const msg = validateOne(file);
        if (msg) errors.push(msg);
        else validFiles.push(file);
      }

      if (errors.length > 0) {
        setValidationError(errors.join('; '));
        return;
      }

      const capped = mergeAndLimit(validFiles);
      safeOnFilesChange(capped);
    },
    [validateOne, mergeAndLimit, safeOnFilesChange]
  );

  const handleInputChange = (e) => {
    const selectedFiles = e.target?.files;
    if (selectedFiles && selectedFiles.length > 0) {
      handleFiles(selectedFiles);
    }
  };

  // Prevent browser from navigating on file drop (global)
  useEffect(() => {
    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', prevent);
    document.addEventListener('drop', prevent);
    return () => {
      document.removeEventListener('dragover', prevent);
      document.removeEventListener('drop', prevent);
    };
  }, []);

  const handleDragOver = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragEnter = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        handleFiles(droppedFiles);
      }
    },
    [disabled, handleFiles]
  );

  const handleRemove = (indexToRemove) => {
    const next = safeFiles.filter((_, index) => index !== indexToRemove);
    safeOnFilesChange(next);
    setValidationError(null);
  };

  const handleContextMenu = (e) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  // Context menu paste (async clipboard API)
  const handlePasteFromContextMenu = async () => {
    setShowContextMenu(false);

    try {
      const read = navigator?.clipboard?.read;
      if (typeof read !== 'function') {
        toast({
          variant: 'destructive',
          title: 'Clipboard Unavailable',
          description: 'Browser does not allow programmatic clipboard read here.',
        });
        return;
      }

      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split('/')[1] || 'png';
          const pastedFile = new File([blob], `screenshot-${Date.now()}.${ext}`, { type: imageType });
          handleFiles([pastedFile]);
          return;
        }
      }

      toast({
        title: 'No Image Found',
        description: 'Clipboard does not contain an image.',
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Clipboard Access Denied',
        description: 'Browser denied clipboard access. Try using Ctrl+V inside the dropzone.',
      });
    }
  };

  // Keyboard paste into dropzone
  const handlePaste = useCallback(
    (e) => {
      if (disabled) return;

      // Prefer clipboardData.files first (sync, reliable)
      const clipboardFiles = e.clipboardData?.files;
      if (clipboardFiles && clipboardFiles.length > 0) {
        e.preventDefault();
        handleFiles(clipboardFiles);
        return;
      }

      // Fallback to items for images
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const pastedFile = item.getAsFile();
          if (pastedFile) {
            handleFiles([pastedFile]);
          }
          return;
        }
      }
    },
    [disabled, handleFiles]
  );

  const displayError = error || validationError;

  return (
    <div className="space-y-3">
      <Label htmlFor="file-upload" className="text-sm font-semibold">
        Upload Document{multiple ? 's' : ''} *
      </Label>

      {safeFiles.length === 0 ? (
        <div
          ref={containerRef}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={handleContextMenu}
          onPaste={handlePaste}
          tabIndex={0}
          className={`
            relative border-2 border-dashed rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            ${isDragging && !disabled ? 'border-blue-500 bg-blue-50' : 'border-slate-300'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50'}
            ${displayError ? 'border-red-300 bg-red-50' : ''}
          `}
          aria-label="File upload dropzone"
          aria-describedby={displayError ? 'file-error' : undefined}
        >
          <label
            htmlFor="file-upload"
            className={`flex flex-col items-center justify-center w-full h-40 ${
              disabled ? 'cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              <Upload className={`w-10 h-10 mb-3 ${isDragging ? 'text-blue-500' : 'text-slate-400'}`} />
              <p className="mb-2 text-sm text-slate-500">
                <span className="font-semibold">Click to upload</span> or drag and drop
              </p>
              <p className="text-xs text-slate-500">
                PDF, DOCX, XLSX, PNG, JPG (Max 5MB{multiple ? ' per file' : ''})
              </p>
            </div>
            <Input
              id="file-upload"
              type="file"
              className="hidden"
              onChange={handleInputChange}
              accept={ALLOWED_FILE_TYPES.join(',')}
              disabled={disabled}
              multiple={multiple}
              aria-describedby={displayError ? 'file-error' : undefined}
            />
          </label>
        </div>
      ) : (
        <div className="space-y-2">
          {safeFiles.map((file, index) => (
            <div
              key={`file-${index}-${file?.name || 'unknown'}`}
              className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <FileText className="w-5 h-5 text-blue-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-slate-900 truncate">
                    {file?.name || 'Untitled'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatFileSize(file?.size || 0)}
                  </p>
                </div>
              </div>
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(index)}
                  className="shrink-0"
                  aria-label={`Remove ${file?.name || 'file'}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
            </div>
          ))}

          {multiple && !disabled && (
            <label
              htmlFor="file-upload-more"
              className="flex items-center justify-center p-3 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <Upload className="w-4 h-4 mr-2 text-slate-500" />
              <span className="text-sm text-slate-600">Add more files</span>
              <Input
                id="file-upload-more"
                type="file"
                className="hidden"
                onChange={handleInputChange}
                accept={ALLOWED_FILE_TYPES.join(',')}
                multiple={multiple}
              />
            </label>
          )}
        </div>
      )}

      {displayError && (
        <Alert variant="destructive" id="file-error" aria-live="polite">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}

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
    </div>
  );
}