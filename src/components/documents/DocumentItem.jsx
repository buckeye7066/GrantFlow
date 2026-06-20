import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Download, Trash2, Printer, Wand2 } from 'lucide-react';
import { format } from 'date-fns';
import client from '@/api/client';
import { getDocumentExtract, parseDocument } from '@/api/documents';
import { useToast } from '@/components/ui/use-toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { downloadAuthenticatedUrl, openAuthenticatedUrlForPrint } from '@/utils/authenticatedDownload'

function escapeHtml(value) {
  if (value === null) return '';
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

  const fileUri = document.download_url ?? document.file_url ?? document.file_uri;

  const uploadedLabel = isValidDate(document.created_at)
    ? format(new Date(document.created_at), 'MMM dd, yyyy')
    : 'Unknown date';

  const processingStatus = document.processing_status ?? 'pending';
  const isUnparsed = processingStatus === 'pending' || processingStatus === 'failed';

  const extractQuery = useQuery({
    queryKey: ['document-extract', document.id],
    queryFn: () => getDocumentExtract(document.id),
    enabled: Boolean(document?.id),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'pending' || status === 'processing' ? 3000 : false
    },
  })

  const confidenceMeter = useMemo(() => {
    const data = extractQuery.data
    if (!data) return null

    // Show "Processing" for documents still being extracted
    if (data.status === 'pending' || data.status === 'processing') {
      return { label: 'Processing…', tone: 'warn', confidence: null }
    }

    const confidence = typeof data.confidence === 'number' ? data.confidence : 0
    const ocrUsed = Boolean(data.ocr_used)

    if (confidence >= 0.85) {
      return { label: ocrUsed ? 'Readable (OCR)' : 'Readable (text)', tone: 'ok', confidence }
    }
    if (confidence >= 0.5) {
      return { label: 'Partial', tone: 'warn', confidence }
    }
    return { label: 'Unreliable', tone: 'bad', confidence }
  }, [extractQuery.data])
  
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
      if (!client?.integrations?.Core?.CreateFileSignedUrl) {
        return null;
      }
      const { signed_url } = await client.integrations.Core.CreateFileSignedUrl({ file_uri: fileUri });
      return signed_url;
    } catch (error) {
      console.error('Failed to resolve remote document URL', error);
      return null;
    }
  };

  const openTextPrintWindow = (title, content) => {
    // No "noopener" — it makes window.open() return null, so document.write
    // below never runs and the tab opens blank. Same-origin content we own.
    const printable = window.open('', '_blank');
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
      try {
        await downloadAuthenticatedUrl(url, {
          fallbackFileName: String(document.file_name || document.name || 'document').trim() || 'document',
        })
      } catch (error) {
        // If authenticated download fails (e.g. 404 for URL-imported docs), fall through to extracted_text
        if (!document.extracted_text) {
          toast({
            variant: 'destructive',
            title: 'Download failed',
            description: error?.message || 'Unable to download this document right now.',
          })
          return
        }
      }
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
      try {
        await openAuthenticatedUrlForPrint(url)
      } catch (error) {
        // If authenticated print fails, fall through to extracted_text
        if (!document.extracted_text) {
          toast({
            variant: 'destructive',
            title: 'Print failed',
            description: error?.message || 'Unable to open printable view right now.',
          })
          return
        }
      }
    }
    if (document.extracted_text) {
      openTextPrintWindow(document.name ?? 'Document', document.extracted_text);
      return;
    }
    alert('This document does not have printable content yet.');
  };

  return (
    <Card className="flex flex-col h-full cursor-pointer hover:shadow-md hover:border-primary/30 transition-shadow">
      <div onClick={handleDownload} className="flex-1 min-w-0 flex flex-col" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleDownload() }}>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div className="p-2.5 bg-blue-50 rounded-lg shrink-0">
          <FileText className="w-5 h-5 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <CardTitle className="text-base leading-snug break-words">{document.name}</CardTitle>
          <p className="text-xs text-slate-500 capitalize mt-1">{(document.type || 'unspecified').replace(/_/g, ' ')}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
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
            {confidenceMeter ? (
              <Badge
                variant={
                  confidenceMeter.tone === 'ok'
                    ? 'default'
                    : confidenceMeter.tone === 'warn'
                    ? 'secondary'
                    : 'destructive'
                }
                className="text-[10px]"
                title={`Confidence ${(confidenceMeter.confidence ?? 0).toFixed(2)}`}
              >
                {confidenceMeter.label}
              </Badge>
            ) : null}
            {document.ai_sections ? (
              <Badge variant="default" className="text-[10px] bg-violet-600 hover:bg-violet-700">
                <Wand2 className="w-3 h-3 mr-0.5" /> AI Parsed
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-grow space-y-2 pt-0 pb-4">
        <p className="text-xs text-slate-500">Uploaded on {uploadedLabel}</p>
        {processingStatus === 'failed' && document.processing_error ? (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-md p-2">
            {document.processing_error}
          </p>
        ) : null}
        {document.ai_summary ? (
          <p className="text-xs text-slate-600 line-clamp-4 leading-relaxed">
            {document.ai_summary}
          </p>
        ) : null}
      </CardContent>
      </div>
      <CardFooter className="flex flex-wrap gap-2 pt-0 mt-auto">
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
        {typeof onDelete === "function" ? (
          <Button
            variant="outline"
            size="icon"
            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(document)}
            aria-label={`Delete ${String(document?.name || "document")}`}
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
