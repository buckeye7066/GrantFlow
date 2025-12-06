/**
 * PHI File Validation Utilities
 * HIPAA-compliant file type and size validation
 */

export const PHI_VALID_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/tif',
  'image/gif',
  'image/webp',
  'image/bmp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv'
];

export const PHI_ACCEPTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/tiff',
  'application/pdf',
  '.pdf',
  '.doc',
  '.docx',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  '.txt',
  'text/csv',
  '.csv'
].join(',');

export const PHI_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB for PHI documents

/**
 * Validate a file for PHI document upload
 * @param {File} file - The file to validate
 * @returns {{ isValid: boolean, error: string|null }}
 */
export function validatePHIFile(file) {
  if (!file) {
    return {
      isValid: false,
      error: 'Please select a file to upload'
    };
  }

  // Check file type
  const isValidType = PHI_VALID_FILE_TYPES.some(type => {
    if (file.type === type) return true;
    // Handle empty type for some file extensions
    if (!file.type && file.name) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      return ['heic', 'heif', 'tiff', 'tif', 'pdf', 'doc', 'docx', 'txt', 'csv'].includes(ext);
    }
    return false;
  });

  if (!isValidType) {
    return {
      isValid: false,
      error: 'Invalid file type. Accepted formats: PNG, JPG, HEIC, TIFF, PDF, DOC, DOCX, TXT, CSV'
    };
  }

  // Check file size
  if (file.size > PHI_MAX_FILE_SIZE) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    return {
      isValid: false,
      error: `File is too large (${sizeMB}MB). Maximum size is 25MB.`
    };
  }

  return {
    isValid: true,
    error: null
  };
}

/**
 * Sanitize filename for PHI-safe storage (remove PII from filename)
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 */
export function sanitizePHIFilename(filename) {
  // Generate a safe filename without PII
  const ext = filename.split('.').pop()?.toLowerCase() || 'file';
  const timestamp = Date.now();
  return `phi-document-${timestamp}.${ext}`;
}

/**
 * Format file size for display
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}