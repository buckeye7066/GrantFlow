import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Download, Trash2, Printer, Wand2 } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { parseDocument } from '@/api/documents';
import { useToast } from '@/components/ui/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function DocumentItem({ document, onDelete }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isParsing, setIsParsing] = useState(false);
  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const fileUri = document.file_url ?? document.file_uri;

  const uploadedLabel = isValidDate(document.created_at)
    ? format(new Date(document.created_at), 'MMM dd, yyyy')
    : 'Unknown date';

  const processingStatus = document.processing_status ?? 'pending';
  const isUnparsed = processingStatus === 'pending' || processingStatus === 'failed';
  
  const parseMutation = useMutation({
    mutationFn: () => parseDocument(document.id),
    onSuccess: () => {
      toast({
        title: "📄 Document parsing queued",
        description: "AI will analyze the document and update the profile shortly.",
      });
      queryClient.invalidateQueries({ queryKey: ['documents', document.profile_id] });
      queryClient.invalidateQueries({ queryKey: ['profile', document.profile_id] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to queue parsing",
        description: error.message || "Please try again.",
      });
    }
  });
  
  const handleParse = async () => {
    setIsParsing(true);
    try {
      await parseMutation.mutateAsync();
    } finally {
      setIsParsing(false);
    }
  };

  const resolveFileUrl = async () => {
    if (!fileUri) return null;
    if (fileUri.startsWith('http://') || fileUri.startsWith('https://')) {
      return fileUri;
    }
    if (fileUri.startsWith('/')) {
      return fileUri;
    }
    if (fileUri.startsWith('uploads/')) {
      return `/${fileUri}`;
    }
    try {
      if (!base44?.integrations?.Core?.CreateFileSignedUrl) {
        return null;
      }
      const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: fileUri });
      return signed_url;
    } catch (error) {
      console.error('Failed to resolve remote document URL', error);
      return null;
    }
  };

  const openTextPrintWindow = (title, content) => {
    const printable = window.open('', '_blank', 'noopener,noreferrer');
    if (!printable) return;
    const safeTitle = escapeHtml(title || 'Document');
    const safeContent = escapeHtml(content || '');
    printable.document.write(`
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; padding: 24px; line-height: 1.5; }
            h1 { font-size: 20px; margin-bottom: 16px; }
            pre { white-space: pre-wrap; word-wrap: break-word; font-size: 14px; }
          </style>
        </head>
        <body>
          <h1>${safeTitle}</h1>
          <pre>${safeContent}</pre>
        </body>
      </html>
    `);
    printable.document.close();
    printable.focus();
    printable.print();
  };

  const handleDownload = async () => {
    const url = await resolveFileUrl();
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (document.extracted_text) {
      const blob = new Blob([document.extracted_text], { type: 'text/plain;charset=utf-8' });
      const fileName = `${document.name || 'document'}.txt`;
      const downloadUrl = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
      return;
    }
    alert('This document does not have a downloadable file.');
  };

  const handlePrint = async () => {
    const url = await resolveFileUrl();
    if (url) {
      const printWindow = window.open(url, '_blank', 'noopener,noreferrer');
      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print();
        };
      }
      return;
    }
    if (document.extracted_text) {
      openTextPrintWindow(document.name ?? 'Document', document.extracted_text);
      return;
    }
    alert('This document does not have printable content yet.');
  };

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
        {isUnparsed && (
          <Button
            variant="default"
            size="sm"
            className="flex-1"
            onClick={handleParse}
            disabled={isParsing || parseMutation.isPending}
          >
            <Wand2 className="w-3 h-3 mr-2" /> 
            {isParsing || parseMutation.isPending ? 'Parsing...' : 'Parse Document'}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className={isUnparsed ? "" : "flex-1"}
          onClick={handleDownload}
          disabled={!fileUri && !document.extracted_text}
        >
          <Download className="w-3 h-3 mr-2" /> Download
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrint}
          disabled={!fileUri && !document.extracted_text}
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