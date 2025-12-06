/**
 * File validation utilities for upload components
 * Provides consistent validation logic across the application
 */

export const VALID_FILE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

// Alias for backwards compatibility
export const VALID_IMAGE_TYPES = VALID_FILE_TYPES;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Validation result type
 * @typedef {Object} ValidationResult
 * @property {boolean} isValid - Whether the file is valid
 * @property {string|null} error - Error message if invalid
 */

/**
 * Validate an uploaded file for type and size
 * @param {File|null} file - The file to validate
 * @returns {ValidationResult} Validation result with error message if invalid
 */
export function validateFile(file) {
  if (!file) {
    return {
      isValid: false,
      error: 'Please select a file to upload'
    };
  }

  // Check file type
  if (!VALID_FILE_TYPES.includes(file.type)) {
    return {
      isValid: false,
      error: 'Invalid file type. Please upload a screenshot or photo (JPG, PNG, GIF, HEIC), PDF, Word, or Excel file.'
    };
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    return {
      isValid: false,
      error: `File is too large (${sizeMB}MB). Maximum size is 10MB. Please compress your image or use a lower resolution.`
    };
  }

  return {
    isValid: true,
    error: null
  };
}

/**
 * Format file size to human-readable string
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get file extension from filename
 * @param {string} filename - The filename
 * @returns {string} File extension (lowercase)
 */
export function getFileExtension(filename) {
  return filename.slice((filename.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
}