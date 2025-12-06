import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Upload,
  FileText,
  Trash2,
  Download,
  Loader2,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Eye,
  Search,
  Filter,
  X
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Document Manager - Comprehensive document organization and AI suggestions
 * 
 * Features:
 * - Upload and categorize documents
 * - Link documents to specific grants
 * - AI-powered document suggestions based on grant requirements
 * - Quick access during application preparation
 * - Document library with search and filters
 */
export default function DocumentManager({ 
  organizationId, 
  grantId = null,
  mode = 'full', // 'full' | 'compact' | 'suggestions'
  onDocumentSelect = null
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    title: '',
    document_type: 'other',
    description: '',
    tags: []
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch all documents for organization
  const { data: allDocuments = [], isLoading } = useQuery({
    queryKey: ['documents', organizationId],
    queryFn: () => base44.entities.Document.filter({ organization_id: organizationId }, '-created_date'),
    enabled: !!organizationId
  });

  // Fetch grant-specific documents if grantId provided
  const { data: grantDocuments = [] } = useQuery({
    queryKey: ['grantDocuments', grantId],
    queryFn: () => base44.entities.Document.filter({ grant_id: grantId }, '-created_date'),
    enabled: !!grantId
  });

  // Fetch grant details for AI suggestions
  const { data: grant } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: () => base44.entities.Grant.get(grantId),
    enabled: !!grantId && mode === 'suggestions'
  });

  // Document types
  const DOCUMENT_TYPES = [
    { value: 'nofo', label: 'NOFO / RFP', icon: FileText },
    { value: 'proposal', label: 'Proposal Draft', icon: FileText },
    { value: 'budget', label: 'Budget / Financial', icon: FileText },
    { value: 'letter_of_support', label: 'Letter of Support', icon: FileText },
    { value: 'mou', label: 'MOU / Partnership Agreement', icon: FileText },
    { value: 'resume', label: 'Resume / CV', icon: FileText },
    { value: 'irs_determination', label: 'IRS Determination Letter', icon: FileText },
    { value: 'financial_statement', label: 'Financial Statement', icon: FileText },
    { value: 'audit', label: 'Audit Report', icon: FileText },
    { value: 'logic_model', label: 'Logic Model', icon: FileText },
    { value: 'timeline', label: 'Project Timeline', icon: FileText },
    { value: 'other', label: 'Other', icon: FileText }
  ];

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file) => {
      // Upload file to private storage
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });

      // Create document record
      return await base44.entities.Document.create({
        organization_id: organizationId,
        grant_id: grantId || null,
        title: uploadForm.title || file.name,
        document_type: uploadForm.document_type,
        file_uri: file_uri,
        file_type: file.name.split('.').pop().toLowerCase(),
        status: 'uploaded',
        description: uploadForm.description,
        tags: uploadForm.tags
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['grantDocuments'] });
      
      setShowUploadForm(false);
      setUploadForm({ title: '', document_type: 'other', description: '', tags: [] });
      
      toast({
        title: '✅ Document Uploaded',
        description: 'Document has been added to your library',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: error.message,
      });
    },
    onSettled: () => {
      setUploading(false);
    }
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (docId) => base44.entities.Document.delete(docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['grantDocuments'] });
      
      toast({
        title: '🗑️ Document Deleted',
        description: 'Document has been removed',
      });
    }
  });

  // Link document to grant
  const linkToGrantMutation = useMutation({
    mutationFn: ({ docId, targetGrantId }) => 
      base44.entities.Document.update(docId, { grant_id: targetGrantId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['grantDocuments'] });
      
      toast({
        title: '🔗 Document Linked',
        description: 'Document has been linked to this grant',
      });
    }
  });

  // AI Document Suggestions
  const getSuggestedDocuments = async () => {
    if (!grant) return;
    
    setSuggestionsLoading(true);
    
    try {
      const response = await base44.functions.invoke('suggestDocumentsForGrant', {
        grant_id: grantId,
        organization_id: organizationId
      });

      setSuggestions(response.data.suggestions || []);
      
      if (response.data.suggestions.length === 0) {
        toast({
          title: 'No Suggestions',
          description: 'All required documents appear to be uploaded',
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Suggestion Failed',
        description: error.message,
      });
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    uploadMutation.mutate(file);
  };

  const handleDownloadDocument = async (doc) => {
    try {
      const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: doc.file_uri,
        expires_in: 300
      });

      window.open(signed_url, '_blank');
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download Failed',
        description: error.message,
      });
    }
  };

  // Filter documents
  const filteredDocuments = useMemo(() => {
    let docs = grantId && mode !== 'full' ? grantDocuments : allDocuments;
    
    // Search filter
    if (searchTerm) {
      docs = docs.filter(doc =>
        doc.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (doc.description && doc.description.toLowerCase().includes(searchTerm.toLowerCase()))
      );
    }

    // Type filter
    if (typeFilter !== 'all') {
      docs = docs.filter(doc => doc.document_type === typeFilter);
    }

    return docs;
  }, [allDocuments, grantDocuments, searchTerm, typeFilter, grantId, mode]);

  // Group by type
  const documentsByType = useMemo(() => {
    return filteredDocuments.reduce((acc, doc) => {
      const type = doc.document_type || 'other';
      if (!acc[type]) acc[type] = [];
      acc[type].push(doc);
      return acc;
    }, {});
  }, [filteredDocuments]);

  // Documents not linked to current grant
  const availableDocuments = useMemo(() => {
    if (!grantId) return [];
    return allDocuments.filter(doc => !doc.grant_id || doc.grant_id !== grantId);
  }, [allDocuments, grantId]);

  // Compact mode for quick access
  if (mode === 'compact') {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">📎 Attached Documents</CardTitle>
            <Button onClick={() => setShowUploadForm(true)} size="sm" variant="outline">
              <Upload className="w-4 h-4 mr-2" />
              Upload
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {filteredDocuments.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              No documents attached to this grant yet
            </p>
          ) : (
            <div className="space-y-2">
              {filteredDocuments.slice(0, 5).map(doc => (
                <div key={doc.id} className="flex items-center justify-between p-2 bg-slate-50 rounded border">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FileText className="w-4 h-4 text-slate-600 shrink-0" />
                    <span className="text-sm truncate">{doc.title}</span>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {doc.file_type}
                    </Badge>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDownloadDocument(doc)}
                      className="h-8 w-8"
                    >
                      <Download className="w-3 h-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(doc.id)}
                      className="h-8 w-8 text-red-600"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Suggestions mode for AI-powered recommendations
  if (mode === 'suggestions') {
    return (
      <Card className="border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Document Suggestions
              </CardTitle>
              <CardDescription className="mt-1">
                Recommended documents for this grant application
              </CardDescription>
            </div>
            <Button
              onClick={getSuggestedDocuments}
              disabled={suggestionsLoading}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {suggestionsLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Get Suggestions
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {suggestions.length === 0 && !suggestionsLoading ? (
            <div className="text-center py-8">
              <Sparkles className="w-12 h-12 mx-auto text-purple-300 mb-3" />
              <p className="text-slate-600 mb-2">
                Click "Get Suggestions" to analyze grant requirements
              </p>
              <p className="text-sm text-slate-500">
                AI will recommend documents you should prepare or upload
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((suggestion, idx) => (
                <Card key={idx} className={`${
                  suggestion.status === 'missing' 
                    ? 'border-amber-300 bg-amber-50' 
                    : 'border-green-300 bg-green-50'
                }`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          {suggestion.status === 'missing' ? (
                            <AlertCircle className="w-4 h-4 text-amber-600" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4 text-green-600" />
                          )}
                          <h4 className="font-semibold text-slate-900">
                            {suggestion.document_name}
                          </h4>
                          <Badge variant={suggestion.required ? 'default' : 'outline'}>
                            {suggestion.required ? 'Required' : 'Recommended'}
                          </Badge>
                        </div>
                        <p className="text-sm text-slate-700 mb-2">
                          {suggestion.reason}
                        </p>
                        {suggestion.existing_document && (
                          <div className="flex items-center gap-2 text-xs text-green-700 bg-green-100 px-2 py-1 rounded">
                            <CheckCircle2 className="w-3 h-3" />
                            Already have: {suggestion.existing_document.title}
                          </div>
                        )}
                      </div>
                      {suggestion.status === 'missing' && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setUploadForm({ 
                              ...uploadForm, 
                              document_type: suggestion.document_type,
                              title: suggestion.document_name 
                            });
                            setShowUploadForm(true);
                          }}
                        >
                          <Upload className="w-4 h-4 mr-2" />
                          Upload
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Full mode - Complete document management interface
  return (
    <div className="space-y-6">
      {/* Header with Stats */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FolderOpen className="w-7 h-7 text-blue-600" />
            Document Library
          </h2>
          <p className="text-slate-600 mt-1">
            Manage supporting documents for grant applications
          </p>
        </div>
        <div className="flex gap-2">
          {grantId && (
            <Button
              onClick={getSuggestedDocuments}
              disabled={suggestionsLoading}
              variant="outline"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              AI Suggestions
            </Button>
          )}
          <Button onClick={() => setShowUploadForm(true)} className="bg-blue-600">
            <Upload className="w-4 h-4 mr-2" />
            Upload Document
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <FileText className="w-8 h-8 mx-auto text-blue-600 mb-2" />
            <p className="text-2xl font-bold text-slate-900">{allDocuments.length}</p>
            <p className="text-xs text-slate-600">Total Documents</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <FolderOpen className="w-8 h-8 mx-auto text-purple-600 mb-2" />
            <p className="text-2xl font-bold text-slate-900">
              {grantId ? grantDocuments.length : '-'}
            </p>
            <p className="text-xs text-slate-600">For This Grant</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <CheckCircle2 className="w-8 h-8 mx-auto text-green-600 mb-2" />
            <p className="text-2xl font-bold text-slate-900">
              {allDocuments.filter(d => d.status === 'processed').length}
            </p>
            <p className="text-xs text-slate-600">Processed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <AlertCircle className="w-8 h-8 mx-auto text-amber-600 mb-2" />
            <p className="text-2xl font-bold text-slate-900">
              {Object.keys(documentsByType).length}
            </p>
            <p className="text-xs text-slate-600">Document Types</p>
          </CardContent>
        </Card>
      </div>

      {/* AI Suggestions Alert */}
      {grantId && suggestions.length > 0 && (
        <Alert className="bg-purple-50 border-purple-300">
          <Sparkles className="h-4 w-4 text-purple-600" />
          <AlertDescription className="text-purple-900">
            <strong>AI found {suggestions.filter(s => s.status === 'missing').length} missing documents</strong>
            <p className="text-sm mt-1">
              Review suggestions below to ensure you have all required materials
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Upload Form */}
      {showUploadForm && (
        <Card className="border-2 border-blue-500">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Upload New Document</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUploadForm(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label>Document Title *</Label>
                <Input
                  placeholder="e.g., 2024 Financial Audit"
                  value={uploadForm.title}
                  onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
                  className="mt-2"
                />
              </div>
              <div>
                <Label>Document Type *</Label>
                <Select
                  value={uploadForm.document_type}
                  onValueChange={(value) => setUploadForm({ ...uploadForm, document_type: value })}
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Description</Label>
              <Textarea
                placeholder="Brief description of this document..."
                value={uploadForm.description}
                onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
                rows={3}
                className="mt-2"
              />
            </div>

            <div>
              <Label>Select File *</Label>
              <input
                type="file"
                onChange={handleFileUpload}
                disabled={uploading}
                className="mt-2 block w-full text-sm text-slate-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-lg file:border-0
                  file:text-sm file:font-semibold
                  file:bg-blue-50 file:text-blue-700
                  hover:file:bg-blue-100
                  file:cursor-pointer cursor-pointer"
              />
              <p className="text-xs text-slate-500 mt-1">
                Accepted: PDF, Word, Excel, Images
              </p>
            </div>

            {uploading && (
              <Alert className="bg-blue-50 border-blue-300">
                <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                <AlertDescription className="text-blue-900">
                  Uploading and processing document...
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Search and Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search documents..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {DOCUMENT_TYPES.map(type => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(searchTerm || typeFilter !== 'all') && (
              <Button
                variant="outline"
                onClick={() => {
                  setSearchTerm('');
                  setTypeFilter('all');
                }}
              >
                <X className="w-4 h-4 mr-2" />
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Documents Tabs */}
      <Tabs defaultValue={grantId ? 'grant' : 'all'}>
        <TabsList>
          <TabsTrigger value="all">All Documents ({allDocuments.length})</TabsTrigger>
          {grantId && (
            <TabsTrigger value="grant">This Grant ({grantDocuments.length})</TabsTrigger>
          )}
          {grantId && availableDocuments.length > 0 && (
            <TabsTrigger value="library">Add from Library ({availableDocuments.length})</TabsTrigger>
          )}
          <TabsTrigger value="by-type">By Type</TabsTrigger>
        </TabsList>

        {/* All Documents */}
        <TabsContent value="all">
          <DocumentGrid
            documents={filteredDocuments}
            onDownload={handleDownloadDocument}
            onDelete={deleteMutation.mutate}
            onLinkToGrant={grantId ? (docId) => linkToGrantMutation.mutate({ docId, targetGrantId: grantId }) : null}
            isDeleting={deleteMutation.isPending}
          />
        </TabsContent>

        {/* Grant Documents */}
        {grantId && (
          <TabsContent value="grant">
            <DocumentGrid
              documents={grantDocuments}
              onDownload={handleDownloadDocument}
              onDelete={deleteMutation.mutate}
              isDeleting={deleteMutation.isPending}
            />
          </TabsContent>
        )}

        {/* Library to Add */}
        {grantId && (
          <TabsContent value="library">
            <DocumentGrid
              documents={availableDocuments.filter(doc => 
                !searchTerm || doc.title.toLowerCase().includes(searchTerm.toLowerCase())
              )}
              onDownload={handleDownloadDocument}
              onDelete={deleteMutation.mutate}
              onLinkToGrant={(docId) => linkToGrantMutation.mutate({ docId, targetGrantId: grantId })}
              isDeleting={deleteMutation.isPending}
              showLinkButton={true}
            />
          </TabsContent>
        )}

        {/* By Type */}
        <TabsContent value="by-type">
          <div className="space-y-6">
            {Object.keys(documentsByType).length === 0 ? (
              <div className="text-center py-12 border border-dashed border-slate-300 rounded-lg">
                <FileText className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                <p className="text-slate-500">No documents found</p>
              </div>
            ) : (
              Object.entries(documentsByType).map(([type, docs]) => {
                const typeInfo = DOCUMENT_TYPES.find(t => t.value === type) || DOCUMENT_TYPES[DOCUMENT_TYPES.length - 1];
                return (
                  <Card key={type}>
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <typeInfo.icon className="w-4 h-4" />
                        {typeInfo.label} ({docs.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <DocumentGrid
                        documents={docs}
                        onDownload={handleDownloadDocument}
                        onDelete={deleteMutation.mutate}
                        onLinkToGrant={grantId ? (docId) => linkToGrantMutation.mutate({ docId, targetGrantId: grantId }) : null}
                        isDeleting={deleteMutation.isPending}
                        showLinkButton={grantId}
                      />
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Document Grid Component
 */
function DocumentGrid({ documents, onDownload, onDelete, onLinkToGrant, isDeleting, showLinkButton = false }) {
  if (documents.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed border-slate-300 rounded-lg">
        <FileText className="w-12 h-12 mx-auto text-slate-300 mb-3" />
        <p className="text-slate-500">No documents in this category</p>
      </div>
    );
  }

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      {documents.map(doc => (
        <Card key={doc.id} className="hover:shadow-lg transition-shadow">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-blue-50 rounded-lg">
                <FileText className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-slate-900 text-sm truncate" title={doc.title}>
                  {doc.title}
                </h4>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-xs">
                    {doc.file_type}
                  </Badge>
                  <Badge variant="secondary" className="text-xs capitalize">
                    {doc.document_type?.replace(/_/g, ' ')}
                  </Badge>
                </div>
                {doc.description && (
                  <p className="text-xs text-slate-600 mt-2 line-clamp-2">
                    {doc.description}
                  </p>
                )}
                <p className="text-xs text-slate-500 mt-2">
                  {new Date(doc.created_date).toLocaleDateString()}
                </p>
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDownload(doc)}
                className="flex-1"
              >
                <Download className="w-3 h-3 mr-2" />
                Download
              </Button>
              {showLinkButton && onLinkToGrant && (
                <Button
                  size="sm"
                  onClick={() => onLinkToGrant(doc.id)}
                  className="flex-1 bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle2 className="w-3 h-3 mr-2" />
                  Link
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(doc.id)}
                disabled={isDeleting}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}