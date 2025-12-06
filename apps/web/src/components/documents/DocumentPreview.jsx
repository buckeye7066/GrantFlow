import React from 'react';
import { 
  FileText, 
  File, 
  Image as ImageIcon, 
  Sheet, 
  FileSpreadsheet,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  FileCode,
  FolderOpen
} from 'lucide-react';

/**
 * Get appropriate icon for file type
 * @param {string} fileType - MIME type of the file
 * @returns {Object} Lucide icon component
 */
function getFileIcon(fileType) {
  if (!fileType) return FolderOpen;
  
  const type = fileType.toLowerCase();
  
  // PDF files
  if (type.includes('pdf')) return FileText;
  
  // Word documents
  if (type.includes('word') || type.includes('msword') || type.includes('document')) {
    return FileText;
  }
  
  // Excel/Spreadsheets
  if (type.includes('excel') || type.includes('spreadsheet') || type.includes('sheet')) {
    return FileSpreadsheet;
  }
  
  // Images
  if (type.includes('image') || type.includes('png') || type.includes('jpg') || type.includes('jpeg') || type.includes('gif')) {
    return FileImage;
  }
  
  // Archives
  if (type.includes('zip') || type.includes('rar') || type.includes('archive')) {
    return FileArchive;
  }
  
  // Video
  if (type.includes('video')) return FileVideo;
  
  // Audio
  if (type.includes('audio')) return FileAudio;
  
  // Code files
  if (type.includes('json') || type.includes('javascript') || type.includes('html') || type.includes('css')) {
    return FileCode;
  }
  
  // Default
  return File;
}

/**
 * Get color class for file type
 * @param {string} fileType - MIME type of the file
 * @returns {string} Tailwind color classes
 */
function getFileColor(fileType) {
  if (!fileType) return 'bg-slate-50 text-slate-600';
  
  const type = fileType.toLowerCase();
  
  if (type.includes('pdf')) return 'bg-red-50 text-red-600';
  if (type.includes('word') || type.includes('document')) return 'bg-blue-50 text-blue-600';
  if (type.includes('excel') || type.includes('spreadsheet')) return 'bg-green-50 text-green-600';
  if (type.includes('image')) return 'bg-purple-50 text-purple-600';
  if (type.includes('archive')) return 'bg-amber-50 text-amber-600';
  if (type.includes('video')) return 'bg-pink-50 text-pink-600';
  if (type.includes('audio')) return 'bg-indigo-50 text-indigo-600';
  
  return 'bg-slate-50 text-slate-600';
}

/**
 * DocumentPreview - Icon preview for document file types
 * @param {Object} props
 * @param {string} props.fileType - MIME type of the file
 * @param {string} props.size - Icon size (sm, md, lg)
 */
export default function DocumentPreview({ fileType, size = 'md' }) {
  const Icon = getFileIcon(fileType);
  const colorClass = getFileColor(fileType);
  
  const sizeClasses = {
    sm: 'w-8 h-8 p-1.5',
    md: 'w-12 h-12 p-3',
    lg: 'w-16 h-16 p-4'
  };
  
  const iconSizes = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8'
  };
  
  return (
    <div className={`${sizeClasses[size]} ${colorClass} rounded-lg flex items-center justify-center shrink-0`}>
      <Icon className={iconSizes[size]} aria-hidden="true" />
    </div>
  );
}