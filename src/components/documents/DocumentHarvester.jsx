import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, UploadCloud, CheckCircle, AlertTriangle, FileUp, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { Badge } from '@/components/ui/badge';
import { ingestDocument } from '@/api/documents';

export default function DocumentHarvester({ profileId, organizationId, onComplete }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState('other');
  const [processingDocs, setProcessingDocs] = useState([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ file, title, documentType }) => {
      if (!profileId) {
        throw new Error('Profile ID is required for document ingestion.');
      }
      const docId = Date.now(); // Unique ID for tracking

      setProcessingDocs(prev => [
        ...prev,
        {
          id: docId,
          name: title || file.name,
          status: 'uploading',
        },
      ]);

      try {
        setProcessingDocs(prev =>
          prev.map(doc => (doc.id === docId ? { ...doc, status: 'extracting' } : doc)),
        );

        const formData = new FormData();
        formData.append('profile_id', profileId);
        if (organizationId) {
          formData.append('organization_id', organizationId);
        }
        formData.append('document', file);
        formData.append('name', title || file.name);
        formData.append('type', documentType);

        setProcessingDocs(prev =>
          prev.map(doc => (doc.id === docId ? { ...doc, status: 'queuing' } : doc)),
        );

        const serverDocument = await ingestDocument(formData);

        return { docId, document: serverDocument };
      } catch (error) {
        setProcessingDocs(prev =>
          prev.map(doc =>
            doc.id === docId ? { ...doc, status: 'failed', error: error.message } : doc,
          ),
        );
        throw error;
      }
    },
    onSuccess: ({ docId }) => {
      // Update to success status
      setProcessingDocs(prev => prev.map(doc => 
        doc.id === docId ? { ...doc, status: 'queued' } : doc
      ));

      queryClient.invalidateQueries({ queryKey: ['documents', profileId] });
      queryClient.invalidateQueries({ queryKey: ['profile', profileId] });
      
      toast({
        title: "📄 Document queued for enrichment",
        description: "We’ll parse the document and update the profile automatically.",
      });

      if (onComplete) {
        onComplete();
      }

      // Remove from list after 3 seconds
      setTimeout(() => {
        setProcessingDocs(prev => prev.filter(doc => doc.id !== docId));
      }, 3000);
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Upload Failed",
        description: err.message,
      });
    }
  });

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      if (!title) {
        setTitle(selectedFile.name.replace(/\.[^/.]+$/, ""));
      }
    }
  };

  const handleHarvest = () => {
    if (file && title) {
      // Start the background process
      mutation.mutate({ file, title, documentType });
      
      // Reset the form immediately so user can upload another
      setFile(null);
      setTitle('');
      setDocumentType('other');
      
      // Reset file input
      const fileInput = document.getElementById('file-upload');
      if (fileInput) fileInput.value = '';
    }
  };

  return (
    <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileUp className="w-5 h-5 text-blue-600" />
          Upload Documents for AI Extraction
        </CardTitle>
        <CardDescription className="text-xs">
          Upload multiple documents. Each will be processed in the background while you continue working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="file-upload">Document File *</Label>
          <Input 
            id="file-upload" 
            type="file" 
            onChange={handleFileChange} 
            className="pt-2 cursor-pointer"
            accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg"
          />
          {file && (
            <p className="text-sm text-slate-600">
              Selected: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB)
            </p>
          )}
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="title">Document Title *</Label>
          <Input 
            id="title" 
            value={title} 
            onChange={e => setTitle(e.target.value)} 
            placeholder="e.g., Resume, IRS Determination Letter" 
          />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="doc-type">Document Type</Label>
          <Select value={documentType} onValueChange={setDocumentType}>
            <SelectTrigger id="doc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="resume">Resume/CV</SelectItem>
              <SelectItem value="irs_determination">IRS Determination Letter</SelectItem>
              <SelectItem value="financial_statement">Financial Statement</SelectItem>
              <SelectItem value="audit">Audit Report</SelectItem>
              <SelectItem value="letter_of_support">Letter of Support</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <Button
          onClick={handleHarvest}
          disabled={!file || !title}
          className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
        >
          <UploadCloud className="w-4 h-4 mr-2" />
          Upload Document
        </Button>

        {/* Processing Queue */}
        {processingDocs.length > 0 && (
          <div className="mt-4 pt-4 border-t border-blue-200 space-y-2">
            <p className="text-sm font-semibold text-slate-700 mb-2">Processing Queue:</p>
            {processingDocs.map(doc => (
              <div key={doc.id} className="flex items-center justify-between p-2 bg-white rounded border border-slate-200">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {doc.status === 'uploading' && <Loader2 className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" />}
                  {doc.status === 'extracting' && <Clock className="w-4 h-4 text-purple-600 flex-shrink-0" />}
                  {doc.status === 'queuing' && <Clock className="w-4 h-4 text-blue-500 flex-shrink-0" />}
                  {doc.status === 'queued' && <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />}
                  {doc.status === 'failed' && <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />}
                  <span className="text-sm truncate">{doc.name}</span>
                </div>
                <Badge
                  variant={doc.status === 'queued' ? 'default' : doc.status === 'failed' ? 'destructive' : 'secondary'}
                  className="text-xs ml-2 flex-shrink-0"
                >
                  {doc.status === 'uploading' && 'Uploading'}
                  {doc.status === 'extracting' && 'Extracting'}
                  {doc.status === 'queuing' && 'Queuing'}
                  {doc.status === 'queued' && 'Queued'}
                  {doc.status === 'failed' && 'Failed'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}