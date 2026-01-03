import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, FileText, Printer } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import DocumentItem from './DocumentItem';
import { useToast } from '@/components/ui/use-toast';
import { apiFetch } from '@/api/client';

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

  const handlePrintAll = () => {
    documents.forEach((doc, index) => {
      setTimeout(() => {
        const fileUri = doc.file_url ?? doc.file_uri;
        if (fileUri) {
          window.open(fileUri, '_blank');
        }
      }, index * 500); // Stagger the print windows
    });
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
          />
        ))}
      </div>
    </div>
  );
}
