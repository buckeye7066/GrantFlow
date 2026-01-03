import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Download, Trash2, Printer } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

export default function DocumentItem({ document, onDelete }) {
  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const fileUri = document.file_url ?? document.file_uri;

  const getSignedUrlAndDownload = async () => {
    if (!fileUri) {
      alert("This document does not have a stored file URL.");
      return;
    }
    try {
        const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: fileUri });
        window.open(signed_url, '_blank');
    } catch (error) {
        console.error("Failed to get download URL", error);
        alert("Could not generate download link. Please try again.");
    }
  };

  const handlePrint = async () => {
    if (!fileUri) {
      alert("This document does not have a stored file URL.");
      return;
    }
    try {
        const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: fileUri });
        // Open in new window and trigger print
        const printWindow = window.open(signed_url, '_blank');
        if (printWindow) {
          printWindow.onload = () => {
            printWindow.print();
          };
        }
    } catch (error) {
        console.error("Failed to get print URL", error);
        alert("Could not generate print link. Please try again.");
    }
  };

  const uploadedLabel = isValidDate(document.created_at)
    ? format(new Date(document.created_at), 'MMM dd, yyyy')
    : 'Unknown date';

  const processingStatus = document.processing_status ?? 'pending';

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center gap-4 space-y-0 pb-4">
        <div className="p-3 bg-blue-50 rounded-lg">
          <FileText className="w-6 h-6 text-blue-600" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base leading-tight">{document.name}</CardTitle>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-xs text-slate-500 capitalize">{(document.type || 'unspecified').replace(/_/g, ' ')}</p>
            <Badge
              variant={
                processingStatus === 'completed'
                  ? 'default'
                  : processingStatus === 'failed'
                  ? 'destructive'
                  : 'secondary'
              }
              className="text-[10px]"
            >
              {processingStatus}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-grow space-y-2">
        <p className="text-xs text-slate-500">Uploaded on {uploadedLabel}</p>
        {document.ai_summary ? (
          <p className="text-xs text-slate-600 line-clamp-3">
            {document.ai_summary}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={getSignedUrlAndDownload}
          disabled={!fileUri}
        >
          <Download className="w-3 h-3 mr-2" /> Download
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrint}
          disabled={!fileUri}
        >
          <Printer className="w-3 h-3 mr-2" /> Print
        </Button>
        <Button
          variant="destructive-outline"
          size="icon"
          onClick={() => onDelete(document)}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}