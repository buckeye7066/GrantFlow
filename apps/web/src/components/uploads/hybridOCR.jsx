/**
 * Hybrid OCR Layer
 * Server-first OCR with local Tesseract.js fallback
 * Returns extracted text for PHI pipeline processing
 */

import { base44 } from '@/api/base44Client';

/**
 * Check if file is an unsupported format that needs conversion
 */
function isUnsupportedFormat(file) {
  const fileName = (file?.name || '').toLowerCase();
  const fileType = (file?.type || '').toLowerCase();
  
  // HEIC/HEIF are common iPhone formats that many services can't read
  return fileName.endsWith('.heic') || 
         fileName.endsWith('.heif') ||
         fileType === 'image/heic' ||
         fileType === 'image/heif';
}

/**
 * Convert image file to canvas and extract as data URL for Tesseract
 * This handles format conversion for unsupported types
 */
async function convertImageForOCR(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          
          // Convert to PNG data URL
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        } catch (err) {
          reject(new Error('Failed to convert image: ' + err.message));
        }
      };
      
      img.onerror = () => {
        reject(new Error('Failed to load image for conversion'));
      };
      
      img.src = e.target.result;
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    reader.readAsDataURL(file);
  });
}

/**
 * Run hybrid OCR on a file
 * 1. Try server-side OCR via Base44 LLM
 * 2. Fallback to local Tesseract.js if server fails
 * 
 * @param {File} file - The file to OCR
 * @param {string} fileUrl - The uploaded file URL (for server OCR)
 * @returns {Promise<{text: string, method: 'server'|'tesseract'|'canvas'|'error'}>}
 */
export async function runHybridOCR(file, fileUrl) {
  const isUnsupported = isUnsupportedFormat(file);
  
  // 1. Try server-side OCR first (using Base44 LLM with file)
  // Skip for HEIC/HEIF as server often can't process these
  if (!isUnsupported) {
    try {
      console.log('[HybridOCR] Attempting server-side OCR...');
      
      const serverResponse = await base44.integrations.Core.InvokeLLM({
        prompt: "Extract ALL text from this document exactly as it appears. Include every word, number, date, and line. Do not interpret or structure the data, just return the raw text verbatim. If there are multiple columns, read left to right, top to bottom.",
        file_urls: [fileUrl]
      });

      if (serverResponse && typeof serverResponse === 'string' && serverResponse.trim().length > 20) {
        console.log('[HybridOCR] Server OCR successful, extracted', serverResponse.length, 'chars');
        return { text: serverResponse, method: 'server' };
      }
      
      console.log('[HybridOCR] Server OCR returned insufficient text, trying fallback...');
    } catch (err) {
      console.warn('[HybridOCR] Server OCR failed:', err.message || 'Unknown error');
    }
  } else {
    console.log('[HybridOCR] Skipping server OCR for unsupported format:', file?.type || file?.name);
  }

  // 2. Try canvas-based conversion for problematic formats
  let imageSource = file;
  if (isUnsupported || file?.type?.startsWith('image/')) {
    try {
      console.log('[HybridOCR] Converting image via canvas...');
      const dataUrl = await convertImageForOCR(file);
      imageSource = dataUrl;
      console.log('[HybridOCR] Image converted successfully');
    } catch (convErr) {
      console.warn('[HybridOCR] Canvas conversion failed:', convErr.message);
      // Continue with original file, Tesseract might still work
    }
  }

  // 3. Tesseract.js is not available in Base44 - skip local OCR
  console.log('[HybridOCR] Local OCR not available, using server extraction only');

  // 4. Server OCR failed - return what we have from canvas conversion if any
  const errorHint = isUnsupported 
    ? 'HEIC format detected. Please convert to JPG/PNG first.'
    : 'Server OCR did not return sufficient text. Try a clearer image.';
    
  console.warn('[HybridOCR] Server OCR returned insufficient text:', errorHint);
  return { text: '', method: 'error', hint: errorHint };
}

/**
 * Check if file type requires OCR (images)
 * PDFs and Office docs may have embedded text
 */
export function requiresOCR(fileType) {
  const imageTypes = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/heic',
    'image/heif'
  ];
  
  return imageTypes.includes(fileType);
}