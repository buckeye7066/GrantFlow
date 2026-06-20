import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, FileText, Printer } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import DocumentItem from './DocumentItem';
import { useToast } from '@/components/ui/use-toast';
import client, { apiFetch } from '@/api/client';
export default function DocumentList({ profileId }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: documents = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['documents', profileId],
    queryFn: () => apiFetch(`/api/documents?profile_id=${profileId}`),
    enabled: !!profileId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (documentId) => {
      return apiFetch(`/api/documents/${documentId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', profileId] });
      toast({
        title: 'Document deleted',
        description: 'The document has been removed successfully.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to delete document',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleDelete = (document) => {
    if (window.confirm(`Are you sure you want to delete "${document.name}"?`)) {
      deleteMutation.mutate(document.id);
    }
  };

  const resolveDocumentUrl = async (doc) => {
    const fileUri = doc.file_url ?? doc.file_uri;
    if (!fileUri) return null;
    if (fileUri.startsWith('http://') || fileUri.startsWith('https://')) {
      try {
        const parsed = new URL(fileUri);
        if (parsed.hostname) {
          return fileUri;
        }
      } catch (_) {
        // malformed URL â fall through to return null
      }
      console.warn(`[DocumentList] Rejected malformed URL for doc id=${doc.id}: ${fileUri}`);
      return null;
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
      const { signed_url } =
        await client.integrations.Core.CreateFileSignedUrl({ file_uri: fileUri });
      return signed_url ?? null;
    } catch (resolveError) {
      console.error(`Failed to resolve document URL for ${doc.name}:`, resolveError);
      return null;
    }
  };

  const printDocument = (doc, url) => {
    if (url) {
      const printWindow = window.open(url, '_blank', 'noopener,noreferrer');
      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print();
        };
      }
      return;
    }
    if (!doc.extracted_text) return;
    // No "noopener" — it makes window.open() return null, so document.write
    // below never runs and the tab opens blank. Same-origin content we own.
    const printable = window.open('', '_blank');
    if (!printable) return;
    const safeTitle = (doc.name || 'Document')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const safeContent = doc.extracted_text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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

  const handlePrintAll = async () => {
    let skipped = 0;
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const url = await resolveDocumentUrl(doc);
      if (url || doc.extracted_text) {
        printDocument(doc, url);
        if (i < documents.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } else {
        skipped += 1;
        console.warn(`[DocumentList] Skipped document id=${doc.id} name="${doc.name}": no resolvable URL and no extracted_text.`);
      }
    }
    if (skipped > 0) {
      toast({
        title: 'Some documents could not be printed',
        description: `${skipped} document${skipped > 1 ? 's' : ''} had no printable content or a resolvable URL and were skipped.`,
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load documents. Please try again.
        </AlertDescription>
      </Alert>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="text-center p-8 text-slate-500">
        <FileText className="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <p>No documents uploaded yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Documents ({documents.length})</h3>
        {documents.length > 0 && (
          <Button variant="outline" size="sm" onClick={handlePrintAll}>
            <Printer className="w-4 h-4 mr-2" />
            Print All
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {documents.map((document) => (
          <DocumentItem
            key={document.id}
            document={document}
            onDelete={handleDelete}
            onResolveUrl={resolveDocumentUrl}
          />
        ))}
      </div>
    </div>
  );
}
