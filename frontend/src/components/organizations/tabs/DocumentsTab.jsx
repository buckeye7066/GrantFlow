import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Upload, FileText, Download, Trash2, RefreshCw, Loader2, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const DOCUMENT_TYPE_LABELS = {
  nofo: 'NOFO/RFP',
  proposal: 'Proposal Draft',
  budget: 'Budget Document',
  letter_of_support: 'Letter of Support',
  mou: 'MOU/Agreement',
  resume: 'Resume/CV',
  irs_determination: 'IRS Determination Letter',
  financial_statement: 'Financial Statement',
  audit: 'Audit Report',
  logic_model: 'Logic Model',
  timeline: 'Project Timeline',
  other: 'Other Document',
};

export default function DocumentsTab({ documents = [], isLoading, onOpenHarvester }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Try to infer organization id from first doc (fallback-safe)
  const orgId = documents?.[0]?.organization_id;

  const invalidate = () => {
    if (orgId) queryClient.invalidateQueries({ queryKey: ['documents', orgId] });
    queryClient.invalidateQueries({ queryKey: ['documents'] }); // legacy callers
    if (orgId) queryClient.invalidateQueries({ queryKey: ['organizations'] });
  };

  const deleteMutation = useMutation({
    mutationFn: (docId) => base44.entities.Document.delete(docId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Document deleted' });
    },
    onError: (error) => {
      toast({ variant: 'destructive', title: 'Delete failed', description: error?.message || 'Unable to delete document.' });
    }
  });

  const reprocessMutation = useMutation({
    mutationFn: async (doc) => {
      // Optimistically set processing
      await base44.entities.Document.update(doc.id, { status: 'processing' });
      // Call the server function (edge) with proper body
      const { data, error } = await base44.functions.invoke('processScannedApplication', {
        body: { document_id: doc.id, organization_id: doc.organization_id }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast({ title: 'Re-processing document', description: 'AI is extracting information again...' });
    },
    onError: (error) => {
      toast({ title: 'Re-processing failed', description: error?.message || 'Please try again later.', variant: 'destructive' });
      invalidate();
    }
  });

  const handleDownload = async (doc) => {
    try {
      const creator = base44?.integrations?.Core?.CreateFileSignedUrl;
      if (!creator) throw new Error('Download service unavailable.');
      if (!doc?.file_uri) throw new Error('Missing file reference.');
      const { signed_url } = await creator({ file_uri: doc.file_uri, expires_in: 300 });
      if (!signed_url) throw new Error('No signed URL returned.');
      // Normalize URL, then open safely
      const href = new URL(signed_url, window.location.origin).href;
      window.open(href, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast({ title: 'Download failed', description: error?.message || 'Could not download file.', variant: 'destructive' });
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'processed':
        return <CheckCircle2 className="w-4 h-4 text-green-600" />;
      case 'processing':
        return <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />;
      case 'failed':
        return <AlertCircle className="w-4 h-4 text-red-600" />;
      default:
        return <Clock className="w-4 h-4 text-slate-400" />;
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'processed':
        return <Badge className="bg-green-100 text-green-800">Processed</Badge>;
      case 'processing':
        return <Badge className="bg-blue-100 text-blue-800">Processing</Badge>;
      case 'failed':
        return <Badge className="bg-red-100 text-red-800">Failed</Badge>;
      default:
        return <Badge variant="outline">Uploaded</Badge>;
    }
  };

  const safeDate = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      {/* Upload Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-blue-600" />
              Upload Documents
            </CardTitle>
            <Button onClick={onOpenHarvester} className="bg-blue-600 hover:bg-blue-700">
              <Upload className="w-4 h-4 mr-2" />
              Upload New Document
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Upload documents to automatically extract profile information using AI. Supported formats: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG
          </p>
        </CardContent>
      </Card>

      {/* Documents List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-slate-600" />
            Uploaded Documents ({documents.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center p-8 text-slate-500">
              <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p>No documents uploaded yet</p>
              <Button onClick={onOpenHarvester} variant="outline" className="mt-4">
                <Upload className="w-4 h-4 mr-2" />
                Upload Your First Document
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1">
                    {getStatusIcon(doc.status)}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-slate-900">{doc.title || 'Untitled Document'}</h4>
                        {getStatusBadge(doc.status)}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-slate-500">
                          {DOCUMENT_TYPE_LABELS[doc.document_type || ''] || doc.document_type || 'Document'}
                        </span>
                        <span className="text-xs text-slate-400">•</span>
                        <span className="text-xs text-slate-500">{doc.file_type?.toUpperCase() || 'FILE'}</span>
                        <span className="text-xs text-slate-400">•</span>
                        <span className="text-xs text-slate-500">{safeDate(doc.created_date)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownload(doc)}
                      title="Download document"
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => reprocessMutation.mutate(doc)}
                      disabled={reprocessMutation.isPending}
                      title="Re-parse with AI"
                      className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(doc.id)}
                      disabled={deleteMutation.isPending}
                      title="Delete document"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}