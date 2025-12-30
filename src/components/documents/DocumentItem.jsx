import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Download, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

export default function DocumentItem({ document, onDelete }) {
  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const getSignedUrlAndDownload = async () => {
    try {
        const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: document.file_uri });
        window.open(signed_url, '_blank');
    } catch (error) {
        console.error("Failed to get download URL", error);
        alert("Could not generate download link. Please try again.");
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center gap-4 space-y-0 pb-4">
        <div className="p-3 bg-blue-50 rounded-lg">
          <FileText className="w-6 h-6 text-blue-600" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base leading-tight">{document.title}</CardTitle>
          <p className="text-xs text-slate-500 mt-1">{document.document_type.replace(/_/g, ' ')}</p>
        </div>
      </CardHeader>
      <CardContent className="flex-grow">
        <p className="text-xs text-slate-500">
          Uploaded on {isValidDate(document.created_date) ? format(new Date(document.created_date), 'MMM dd, yyyy') : 'Unknown date'}
        </p>
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={getSignedUrlAndDownload}>
          <Download className="w-3 h-3 mr-2" /> Download
        </Button>
        <Button variant="destructive-outline" size="icon" onClick={() => onDelete(document.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}