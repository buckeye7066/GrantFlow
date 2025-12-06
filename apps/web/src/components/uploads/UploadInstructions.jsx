import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileText, AlertCircle } from 'lucide-react';

/**
 * UploadInstructions - Display instructions for file upload
 * @param {Object} props
 * @param {string} props.variant - Alert variant: 'info', 'warning', 'error'
 * @param {string} props.title - Instructions title
 * @param {string[]} props.points - Array of instruction points
 */
export default function UploadInstructions({ 
  variant = 'info',
  title = 'Accepted Formats',
  points = [
    'Screenshots, photos (JPG, PNG, HEIC), PDF, Word, or Excel files',
    'Maximum file size: 10MB',
    'Take a screenshot or photograph of your completed form',
    'Ensure text is clear and readable'
  ]
}) {
  const variantStyles = {
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-amber-50 border-amber-200',
    error: 'bg-red-50 border-red-200'
  };

  const iconStyles = {
    info: 'text-blue-600',
    warning: 'text-amber-600',
    error: 'text-red-600'
  };

  const textStyles = {
    info: 'text-blue-800',
    warning: 'text-amber-800',
    error: 'text-red-800'
  };

  const Icon = variant === 'error' ? AlertCircle : FileText;

  return (
    <Alert className={variantStyles[variant]}>
      <Icon className={`h-4 w-4 ${iconStyles[variant]}`} />
      <AlertDescription className={textStyles[variant]}>
        <strong>{title}:</strong>
        <ul className="mt-2 space-y-1 list-none">
          {points.map((point, index) => (
            <li key={index}>• {point}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}