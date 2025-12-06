import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Clock, AlertTriangle, Plus, Upload, Send, X, DollarSign, ExternalLink, Sparkles, Loader2, FileText, Paperclip, Link2, FolderOpen, Wand2, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/use-toast';
import AIWritingAssistant from '@/components/wizard/AIWritingAssistant';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu';

const REQUIREMENT_TYPES = [
  { value: 'transcript', label: 'Official Transcript' },
  { value: 'test_score', label: 'Test Scores (ACT/SAT/GRE/etc.)' },
  { value: 'essay', label: 'Essay/Personal Statement' },
  { value: 'recommendation_letter', label: 'Letter of Recommendation' },
  { value: 'financial_document', label: 'Financial Documents' },
  { value: 'application_form', label: 'Application Form' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'resume', label: 'Resume/CV' },
  { value: 'personal_statement', label: 'Personal Statement' },
  { value: 'oration_manuscript', label: 'Oration Manuscript' },
  { value: 'proof_of_age', label: 'Proof of Age (Birth Certificate/ID)' },
  { value: 'proof_of_citizenship', label: 'Proof of Citizenship' },
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'custom_field', label: 'Custom Field/Document' },
  { value: 'other', label: 'Other' }
];

const DOCUMENT_TYPE_MAPPING = {
  'drivers_license': 'drivers_license',
  'proof_of_age': ['birth_certificate', 'drivers_license', 'other'],
  'proof_of_citizenship': ['citizenship_proof', 'other'],
  'transcript': ['transcript', 'other'],
  'recommendation_letter': ['recommendation_letter', 'letter_of_support'],
  'financial_document': ['financial_statement', 'audit', 'other'],
  'resume': ['resume', 'other'],
  'test_score': ['other'],
  'essay': ['other'],
  'application_form': ['other'],
  'portfolio': ['other'],
  'personal_statement': ['other'],
  'oration_manuscript': ['other'],
  'custom_field': ['other'],
  'other': ['other']
};

const PLATFORMS = [
  { value: 'direct', label: 'Direct to Institution' },
  { value: 'commonapp', label: 'Common Application' },
  { value: 'coalition', label: 'Coalition Application' },
  { value: 'apply_texas', label: 'ApplyTexas' },
  { value: 'uc_application', label: 'UC Application' },
  { value: 'nursingcas', label: 'NursingCAS' },
  { value: 'amcas', label: 'AMCAS (Medical)' },
  { value: 'lsac', label: 'LSAC (Law)' },
  { value: 'gradcas', label: 'GradCAS' },
  { value: 'other', label: 'Other Platform' }
];

export default function ApplicationRequirementsManager({ grantId, organizationId, grantTitle }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [editingReqId, setEditingReqId] = useState(null);
  const [uploadingReqId, setUploadingReqId] = useState(null);
  const [newReq, setNewReq] = useState({
    requirement_type: 'transcript',
    requirement_name: '',
    deadline: '',
    platform: 'direct',
    priority: 'medium',
    notes: '',
    cost: 0,
    payment_url: '',
    payment_status: 'not_required',
    word_limit: null,
    draft_content: ''
  });

  const { data: requirements = [] } = useQuery({
    queryKey: ['requirements', grantId],
    queryFn: () => base44.entities.ApplicationRequirement.filter({ grant_id: grantId }, 'deadline'),
    enabled: !!grantId
  });

  const { data: grant } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: () => base44.entities.Grant.filter({ id: grantId }).then(res => res[0]),
    enabled: !!grantId
  });

  const { data: organization } = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => base44.entities.Organization.filter({ id: organizationId }).then(res => res[0]),
    enabled: !!organizationId
  });

  const { data: profileDocuments = [] } = useQuery({
    queryKey: ['profileDocuments', organizationId],
    queryFn: () => base44.entities.Document.filter({ 
      organization_id: organizationId,
      grant_id: null // Only profile-level documents
    }),
    enabled: !!organizationId
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.ApplicationRequirement.create({
      ...data,
      grant_id: grantId,
      organization_id: organizationId
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements', grantId] });
      setIsAdding(false);
      setNewReq({
        requirement_type: 'transcript',
        requirement_name: '',
        deadline: '',
        platform: 'direct',
        priority: 'medium',
        notes: '',
        word_limit: null,
        draft_content: ''
      });
      toast({ title: 'Requirement added' });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ApplicationRequirement.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements', grantId] });
      toast({ title: 'Updated' });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.ApplicationRequirement.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements', grantId] });
      toast({ title: 'Requirement removed' });
    }
  });

  const [isGenerating, setIsGenerating] = useState(false);

  const handleAIGenerateRequirements = async () => {
    if (!grantId || !organizationId) {
      toast({ variant: 'destructive', title: 'Grant and organization required' });
      return;
    }

    setIsGenerating(true);
    try {
      toast({ title: 'Analyzing grant requirements with AI...' });
      
      const response = await base44.functions.invoke('analyzeGrant', {
        grant_id: grantId,
        organization_id: organizationId
      });

      const data = response?.data;
      
      if (data?.success) {
        queryClient.invalidateQueries({ queryKey: ['requirements', grantId] });
        queryClient.invalidateQueries({ queryKey: ['grant', grantId] });
        
        const reqCount = data.requirements_created || 0;
        toast({ title: `AI analysis complete! ${reqCount} requirements extracted from funder materials.` });
      } else {
        toast({ variant: 'destructive', title: data?.error || 'AI analysis failed' });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Failed to analyze grant: ' + (error?.message || 'Unknown error') });
    } finally {
      setIsGenerating(false);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'verified': return 'bg-green-100 text-green-800';
      case 'submitted': return 'bg-blue-100 text-blue-800';
      case 'in_progress': return 'bg-yellow-100 text-yellow-800';
      case 'rejected': return 'bg-red-100 text-red-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-800';
      case 'high': return 'bg-orange-100 text-orange-800';
      case 'medium': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  const getDaysUntil = (deadline) => {
    if (!deadline) return null;
    const days = Math.ceil((new Date(deadline) - new Date()) / (1000 * 60 * 60 * 24));
    return days;
  };

  const handleAdd = () => {
    if (!newReq.requirement_name || !newReq.deadline) {
      toast({ variant: 'destructive', title: 'Name and deadline are required' });
      return;
    }
    createMutation.mutate(newReq);
  };

  const handleUploadDocument = async (reqId, file) => {
    setUploadingReqId(reqId);
    try {
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });
      
      const document = await base44.entities.Document.create({
        organization_id: organizationId,
        grant_id: grantId,
        title: requirements.find(r => r.id === reqId)?.requirement_name || 'Application Document',
        document_type: 'other',
        file_uri,
        file_type: file.name.split('.').pop()
      });

      await updateMutation.mutateAsync({
        id: reqId,
        data: { 
          document_id: document.id,
          status: 'submitted',
          submitted_date: new Date().toISOString()
        }
      });

      toast({ title: 'Document uploaded and requirement marked complete' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed: ' + error.message });
    } finally {
      setUploadingReqId(null);
    }
  };

  const isWrittenRequirement = (type) => {
    return ['essay', 'personal_statement', 'oration_manuscript', 'custom_field'].includes(type);
  };

  const handleLinkProfileDocument = async (reqId, docId) => {
    try {
      await updateMutation.mutateAsync({
        id: reqId,
        data: { 
          document_id: docId,
          status: 'submitted',
          submitted_date: new Date().toISOString()
        }
      });

      toast({ title: 'Profile document linked to requirement' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Failed to link document: ' + error.message });
    }
  };

  const getMatchingProfileDocuments = (reqType, reqName) => {
    const searchTerms = reqName.toLowerCase();
    
    return profileDocuments.filter(doc => {
      // Exact document type match
      if (DOCUMENT_TYPE_MAPPING[reqType]) {
        const allowedTypes = Array.isArray(DOCUMENT_TYPE_MAPPING[reqType]) 
          ? DOCUMENT_TYPE_MAPPING[reqType] 
          : [DOCUMENT_TYPE_MAPPING[reqType]];
        
        if (allowedTypes.includes(doc.document_type)) {
          return true;
        }
      }
      
      // Title/keyword match
      const titleMatch = doc.title.toLowerCase().includes(searchTerms) || 
                        searchTerms.includes(doc.title.toLowerCase());
      
      // Tag match
      const tagMatch = doc.tags?.some(tag => 
        tag.toLowerCase().includes(searchTerms) || 
        searchTerms.includes(tag.toLowerCase())
      );
      
      return titleMatch || tagMatch;
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Application Requirements & Deadlines</CardTitle>
          <div className="flex gap-2">
            <Button 
              size="sm" 
              variant="outline" 
              onClick={handleAIGenerateRequirements}
              disabled={isGenerating}
              className="gap-1"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  AI Extract
                </>
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setIsAdding(!isAdding)}>
              {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4 mr-1" />}
              {isAdding ? 'Cancel' : 'Add Manual'}
            </Button>
          </div>
        </div>
        {requirements.length === 0 && (
          <p className="text-xs text-slate-500 mt-2">
            Click "AI Extract" to automatically parse requirements from the funder's program description.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isAdding && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={newReq.requirement_type} onValueChange={(v) => setNewReq({...newReq, requirement_type: v})}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIREMENT_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Platform</Label>
                <Select value={newReq.platform} onValueChange={(v) => setNewReq({...newReq, platform: v})}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Requirement Name</Label>
              <Input
                className="h-8 text-sm"
                placeholder="e.g., Official High School Transcript"
                value={newReq.requirement_name}
                onChange={(e) => setNewReq({...newReq, requirement_name: e.target.value})}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Deadline</Label>
                <Input
                  type="datetime-local"
                  className="h-8 text-sm"
                  value={newReq.deadline}
                  onChange={(e) => setNewReq({...newReq, deadline: e.target.value})}
                />
              </div>
              <div>
                <Label className="text-xs">Priority</Label>
                <Select value={newReq.priority} onValueChange={(v) => setNewReq({...newReq, priority: v})}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {isWrittenRequirement(newReq.requirement_type) && (
              <div>
                <Label className="text-xs">Word Limit (optional)</Label>
                <Input
                  type="number"
                  className="h-8 text-sm"
                  placeholder="Leave blank if no limit"
                  value={newReq.word_limit || ''}
                  onChange={(e) => setNewReq({...newReq, word_limit: parseInt(e.target.value) || null})}
                />
              </div>
            )}
            <div>
              <Label className="text-xs">Notes</Label>
              <Textarea
                className="text-sm"
                rows={2}
                placeholder="Additional notes..."
                value={newReq.notes}
                onChange={(e) => setNewReq({...newReq, notes: e.target.value})}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Cost (if applicable)</Label>
                <Input
                  type="number"
                  step="0.01"
                  className="h-8 text-sm"
                  placeholder="0.00"
                  value={newReq.cost}
                  onChange={(e) => setNewReq({...newReq, cost: parseFloat(e.target.value) || 0, payment_status: parseFloat(e.target.value) > 0 ? 'pending' : 'not_required'})}
                />
              </div>
              <div>
                <Label className="text-xs">Payment Portal URL</Label>
                <Input
                  className="h-8 text-sm"
                  placeholder="https://..."
                  value={newReq.payment_url}
                  onChange={(e) => setNewReq({...newReq, payment_url: e.target.value})}
                />
              </div>
            </div>
            <Button size="sm" onClick={handleAdd} disabled={createMutation.isPending} className="w-full">
              Add Requirement
            </Button>
          </div>
        )}

        {requirements.length === 0 && !isAdding && (
          <p className="text-sm text-slate-500 italic text-center py-4">
            No requirements tracked yet. Click "Add Requirement" to get started.
          </p>
        )}

        {requirements.map((req) => {
          const daysUntil = getDaysUntil(req.deadline);
          const isOverdue = daysUntil !== null && daysUntil < 0;
          const isUrgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 7;
          const isComplete = req.status === 'submitted' || req.status === 'verified';
          const isWritten = isWrittenRequirement(req.requirement_type);
          const isEditing = editingReqId === req.id;
          const matchingDocs = getMatchingProfileDocuments(req.requirement_type, req.requirement_name);

          return (
            <div key={req.id} className={`p-3 border-2 rounded-lg space-y-2 ${
              isComplete ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'
            }`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {isComplete ? (
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                    )}
                    <span className={`font-medium text-sm ${isComplete ? 'text-green-900' : 'text-red-900'}`}>
                      {req.requirement_name}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {REQUIREMENT_TYPES.find(t => t.value === req.requirement_type)?.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <span className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : isUrgent ? 'text-orange-600' : 'text-slate-600'}`}>
                      {req.deadline ? format(new Date(req.deadline), 'MMM dd, yyyy h:mm a') : 'No deadline'}
                      {daysUntil !== null && (
                        <span className="ml-1">
                          {isOverdue ? `(${Math.abs(daysUntil)} days overdue)` : `(${daysUntil} days left)`}
                        </span>
                      )}
                    </span>
                  </div>
                  {req.platform && req.platform !== 'direct' && (
                    <div className="text-xs text-slate-500 mt-1">
                      Via: {PLATFORMS.find(p => p.value === req.platform)?.label}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge className={getStatusColor(req.status)} variant="outline">
                    {req.status.replace(/_/g, ' ')}
                  </Badge>
                  <Badge className={getPriorityColor(req.priority)} variant="outline">
                    {req.priority}
                  </Badge>
                </div>
              </div>

              {req.notes && (
                <p className="text-xs text-slate-600 mt-2">{req.notes}</p>
              )}

              {/* AI Writing Assistant for written requirements */}
              {isWritten && isEditing && (
                <div className="mt-3">
                  <AIWritingAssistant
                    grant={grant}
                    organization={organization}
                    initialText={req.draft_content || ''}
                    sectionType={req.requirement_type}
                    onTextGenerated={(text) => {
                      updateMutation.mutate({
                        id: req.id,
                        data: { draft_content: text }
                      });
                    }}
                    wordLimit={req.word_limit}
                  />
                </div>
              )}

              {req.cost > 0 && (
                <div className="mt-2 p-2 bg-slate-50 rounded flex items-center justify-between">
                  <div className="flex items-center gap-1 text-xs">
                    <DollarSign className="w-3 h-3 text-slate-500" />
                    <span className="font-medium">${req.cost.toFixed(2)}</span>
                    <Badge variant="outline" className={`ml-2 text-xs ${
                      req.payment_status === 'paid' ? 'bg-green-100 text-green-800' :
                      req.payment_status === 'waived' ? 'bg-blue-100 text-blue-800' :
                      'bg-orange-100 text-orange-800'
                    }`}>
                      {req.payment_status}
                    </Badge>
                  </div>
                  {req.payment_url && req.payment_status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs gap-1"
                      onClick={() => window.open(req.payment_url, '_blank')}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Pay Now
                    </Button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t">
                <Select 
                  value={req.status} 
                  onValueChange={(v) => updateMutation.mutate({ id: req.id, data: { status: v } })}
                >
                  <SelectTrigger className="h-7 text-xs flex-1 min-w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="not_started">Not Started</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="submitted">Submitted</SelectItem>
                    <SelectItem value="verified">Verified</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>

                {isWritten && !isEditing && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setEditingReqId(req.id)}
                  >
                    <Sparkles className="w-3 h-3 mr-1" />
                    AI Write
                  </Button>
                )}

                {isWritten && isEditing && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setEditingReqId(null)}
                  >
                    <X className="w-3 h-3 mr-1" />
                    Close
                  </Button>
                )}

                {!req.document_id && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={uploadingReqId === req.id}
                      >
                        {uploadingReqId === req.id ? (
                          <>
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="w-3 h-3 mr-1" />
                            Attach
                          </>
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel className="text-xs">Upload New</DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <label className="cursor-pointer">
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleUploadDocument(req.id, file);
                            }}
                          />
                          <div className="flex items-center w-full">
                            <Upload className="w-3 h-3 mr-2" />
                            Upload New Document
                          </div>
                        </label>
                      </DropdownMenuItem>
                      
                      {matchingDocs.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs">
                            Use from Profile ({matchingDocs.length})
                          </DropdownMenuLabel>
                          {matchingDocs.map(doc => (
                            <DropdownMenuItem
                              key={doc.id}
                              onClick={() => handleLinkProfileDocument(req.id, doc.id)}
                            >
                              <Link2 className="w-3 h-3 mr-2" />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate">{doc.title}</div>
                                <div className="text-xs text-slate-500">
                                  {doc.document_type} • {new Date(doc.created_date).toLocaleDateString()}
                                </div>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                      
                      {profileDocuments.length > 0 && matchingDocs.length === 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs">
                            All Profile Documents ({profileDocuments.length})
                          </DropdownMenuLabel>
                          {profileDocuments.slice(0, 5).map(doc => (
                            <DropdownMenuItem
                              key={doc.id}
                              onClick={() => handleLinkProfileDocument(req.id, doc.id)}
                            >
                              <FolderOpen className="w-3 h-3 mr-2" />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate">{doc.title}</div>
                                <div className="text-xs text-slate-500">{doc.document_type}</div>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {req.document_id && (
                  <Badge className="bg-green-100 text-green-800">
                    <Paperclip className="w-3 h-3 mr-1" />
                    Uploaded
                  </Badge>
                )}

                {req.cost > 0 && req.payment_status === 'pending' && (
                  <Select 
                    value={req.payment_status} 
                    onValueChange={(v) => updateMutation.mutate({ id: req.id, data: { 
                      payment_status: v,
                      payment_date: v === 'paid' ? new Date().toISOString() : null
                    }})}
                  >
                    <SelectTrigger className="h-7 text-xs w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                      <SelectItem value="waived">Waived</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => deleteMutation.mutate(req.id)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}