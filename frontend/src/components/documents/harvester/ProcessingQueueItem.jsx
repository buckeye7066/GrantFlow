import React, { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, AlertCircle, FileUp, RotateCw, X } from 'lucide-react';

/**
 * ProcessingQueueItem - Shows document processing status in the queue
 * @param {Object} props
 * @param {Object} props.doc - Document being processed
 * @param {Function} props.onRetry - Callback to retry failed processing
 * @param {Function} props.onRemove - Callback to remove from queue
 */
export default function ProcessingQueueItem({ doc, onRetry, onRemove }) {
  // Tolerate missing/partial doc
  const safeDoc = doc || { id: 'unknown', name: 'Untitled', status: 'queued' };
  const status = safeDoc.status || 'queued';
  const name = safeDoc.name || 'Untitled';
  const docId = safeDoc.id;

  // Memoized status configuration
  const statusConfig = useMemo(() => {
    switch (status) {
      case 'uploading':
        return {
          icon: <Loader2 className="w-4 h-4 animate-spin text-blue-600" aria-hidden="true" />,
          text: 'Uploading file...',
          bgColor: 'bg-blue-50',
          borderColor: 'border-blue-200',
          textColor: 'text-blue-900',
          live: 'polite',
        };
      case 'extracting':
        return {
          icon: <Loader2 className="w-4 h-4 animate-spin text-purple-600" aria-hidden="true" />,
          text: 'Extracting text with AI...',
          bgColor: 'bg-purple-50',
          borderColor: 'border-purple-200',
          textColor: 'text-purple-900',
          live: 'polite',
        };
      case 'extracting_facts':
        return {
          icon: <Loader2 className="w-4 h-4 animate-spin text-indigo-600" aria-hidden="true" />,
          text: 'Extracting structured facts...',
          bgColor: 'bg-indigo-50',
          borderColor: 'border-indigo-200',
          textColor: 'text-indigo-900',
          live: 'polite',
        };
      case 'success':
        return {
          icon: <CheckCircle2 className="w-4 h-4 text-green-600" aria-label="Processing complete" />,
          text: 'Processing complete!',
          bgColor: 'bg-green-50',
          borderColor: 'border-green-200',
          textColor: 'text-green-900',
          live: 'polite',
        };
      case 'failed':
        return {
          icon: <AlertCircle className="w-4 h-4 text-red-600" aria-label="Processing failed" />,
          text: safeDoc.error || 'Processing failed',
          bgColor: 'bg-red-50',
          borderColor: 'border-red-200',
          textColor: 'text-red-900',
          live: 'assertive',
        };
      default:
        return {
          icon: <FileUp className="w-4 h-4 text-gray-600" aria-hidden="true" />,
          text: 'Queued',
          bgColor: 'bg-gray-50',
          borderColor: 'border-gray-200',
          textColor: 'text-gray-900',
          live: 'off',
        };
    }
  }, [status, safeDoc.error]);

  // Guard callbacks
  const handleRetry = () => {
    if (status === 'failed' && typeof onRetry === 'function') {
      onRetry(safeDoc);
    }
  };

  const handleRemove = () => {
    if ((status === 'failed' || status === 'success') && typeof onRemove === 'function') {
      onRemove(docId);
    }
  };

  return (
    <Card className={`p-3 ${statusConfig.bgColor} border ${statusConfig.borderColor}`}>
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0">{statusConfig.icon}</div>

        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${statusConfig.textColor} truncate`} title={name}>
            {name}
          </p>
          <p
            className={`text-xs ${statusConfig.textColor} opacity-75 mt-0.5`}
            role="status"
            aria-live={statusConfig.live}
          >
            {statusConfig.text}
          </p>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {status === 'failed' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-100"
              title="Retry"
              aria-label="Retry processing"
            >
              <RotateCw className="w-3 h-3" />
            </Button>
          )}

          {(status === 'failed' || status === 'success') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              className="h-7 px-2 text-gray-600 hover:text-gray-700 hover:bg-gray-100"
              title="Remove from queue"
              aria-label="Remove from queue"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}