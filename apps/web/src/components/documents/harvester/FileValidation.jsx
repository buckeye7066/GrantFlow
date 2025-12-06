/**
 * File validation utilities for document harvesting
 */

export const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/jpg'
];

export const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.png', '.jpg', '.jpeg'];

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Return normalized lowercase extension (including dot), or '' if absent
 */
function getExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1) return '';
  return fileName.slice(lastDot).toLowerCase(); // includes dot
}

/**
 * Check whether mime is allowed (case-insensitive)
 */
export function isAllowedMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  const norm = mime.toLowerCase();
  return ALLOWED_FILE_TYPES.includes(norm);
}

/**
 * Check whether extension is allowed (case-insensitive)
 */
export function isAllowedExtension(extOrName) {
  if (!extOrName) return false;
  const ext = extOrName.startsWith('.') ? extOrName.toLowerCase() : getExtension(extOrName);
  if (!ext) return false;
  return ALLOWED_EXTENSIONS.includes(ext);
}

/**
 * Validate a file for document harvesting
 * @param {File} file - The file to validate
 * @returns {Object} - { valid: boolean, error: string | null }
 */
export function validateDocumentFile(file) {
  if (!file) {
    return { valid: false, error: 'Please select a file' };
  }

  // Check file size
  const size = typeof file.size === 'number' ? file.size : 0;
  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File is too large (${formatFileSize(size)}). Maximum size is ${formatFileSize(MAX_FILE_SIZE)}.`
    };
  }

  // Check by MIME or extension (browsers may omit or spoof MIME)
  const mimeOk = isAllowedMime(file.type);
  const extOk = isAllowedExtension(file.name);

  if (!mimeOk && !extOk) {
    return {
      valid: false,
      error: 'Invalid file type. Allowed: PDF, DOC, DOCX, XLS, XLSX, TXT, PNG, JPG, JPEG'
    };
  }

  return { valid: true, error: null };
}

/**
 * Format file size to human-readable string
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Bytes';
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);

  // Round to 2 decimals, trim trailing zeros
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString()} ${units[i]}`;
}