import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FileText, Send, CheckCircle2, Plus, X, ExternalLink, DollarSign, GraduationCap, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const INSTITUTION_TYPES = [
  { value: 'high_school', label: 'High School' },
  { value: 'community_college', label: 'Community College' },
  { value: 'university', label: 'University/College' },
  { value: 'graduate_school', label: 'Graduate School' },
  { value: 'other', label: 'Other' }
];

export default function TranscriptRequestManager({ organizationId, organization, isStudent }) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newRequest, setNewRequest] = useState({
    institution_name: '',
    institution_type: 'high_school',
    years_attended: '',
    recipient_name: '',
    recipient_address: '',
    delivery_method: 'electronic',
    transcript_portal_url: '',
    cost: 0
  });

  const { data: requests = [] } = useQuery({
    queryKey: ['transcriptRequests', organizationId],
    queryFn: () => base44.entities.TranscriptRequest.filter({ organization_id: organizationId }, '-requested_date'),
    enabled: !!organizationId && isStudent
  });

  const { data: universities = [] } = useQuery({
    queryKey: ['universityApplications', organizationId],
    queryFn: () => base44.entities.UniversityApplication.filter({ organization_id: organizationId }),
    enabled: !!organizationId && isStudent
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.TranscriptRequest.create({
      ...data,
      organization_id: organizationId,
      requested_date: new Date().toISOString(),
      payment_status: data.cost > 0 ? 'pending' : 'not_required'
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transcriptRequests', organizationId] });
      setIsAdding(false);
      setNewRequest({
        institution_name: '',
        institution_type: 'high_school',
        years_attended: '',
        recipient_name: '',
        recipient_address: '',
        delivery_method: 'electronic',
        transcript_portal_url: '',
        cost: 0
      });
      toast.success('Transcript request created');
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.TranscriptRequest.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transcriptRequests', organizationId] });
      toast.success('Updated');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.TranscriptRequest.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transcriptRequests', organizationId] });
      toast.success('Request removed');
    }
  });

  if (!isStudent) return null;

  // Get institutions from profile education history
  const profileInstitutions = organization?.education_history || [];

  const handleAILookup = async () => {
    if (!newRequest.recipient_name) {
      toast.error('Please enter a recipient name first');
      return;
    }
    
    setIsGenerating(true);
    
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Research ${newRequest.recipient_name} and find:
1. The official mailing address for transcript requests/admissions office
2. The URL for their online transcript request portal (e.g., Parchment, National Student Clearinghouse, or their own system)
3. The typical cost to send official transcripts to this institution

Return as JSON with keys: recipient_address (as string), transcript_portal_url (as string), cost (as number)`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            recipient_address: { type: "string" },
            transcript_portal_url: { type: "string" },
            cost: { type: "number" }
          }
        }
      });
      
      setNewRequest(prev => ({
        ...prev,
        recipient_address: response.recipient_address || prev.recipient_address,
        transcript_portal_url: response.transcript_portal_url || prev.transcript_portal_url,
        cost: response.cost || prev.cost
      }));
      
      toast.success('AI lookup complete!');
    } catch (error) {
      toast.error('Failed to lookup information');
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'received': return 'bg-green-100 text-green-800';
      case 'sent': return 'bg-blue-100 text-blue-800';
      case 'processing': return 'bg-yellow-100 text-yellow-800';
      case 'failed': return 'bg-red-100 text-red-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-600" />
            Transcript Requests
          </CardTitle>
          <Button size="sm" onClick={() => setIsAdding(!isAdding)}>
            {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4 mr-1" />}
            {isAdding ? 'Cancel' : 'Request Transcript'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdding && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Institution Name</Label>
                {profileInstitutions.length > 0 ? (
                  <Select 
                    value={newRequest.institution_name} 
                    onValueChange={(v) => {
                      if (v === '__custom__') {
                        setNewRequest({...newRequest, institution_name: '', years_attended: ''});
                      } else {
                        const school = profileInstitutions.find(s => s.institution_name === v);
                        setNewRequest({
                          ...newRequest, 
                          institution_name: v,
                          institution_type: school?.institution_type || newRequest.institution_type,
                          years_attended: school?.years_attended || ''
                        });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select from your profile" />
                    </SelectTrigger>
                    <SelectContent>
                      {profileInstitutions.map((school, idx) => (
                        <SelectItem key={idx} value={school.institution_name}>
                          {school.institution_name}
                          {school.years_attended && ` (${school.years_attended})`}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">+ Enter Different Institution</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    placeholder="e.g., Cleveland High School"
                    value={newRequest.institution_name}
                    onChange={(e) => setNewRequest({...newRequest, institution_name: e.target.value})}
                  />
                )}
              </div>
              <div>
                <Label className="text-sm">Type</Label>
                <Select value={newRequest.institution_type} onValueChange={(v) => setNewRequest({...newRequest, institution_type: v})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INSTITUTION_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {profileInstitutions.length > 0 && !profileInstitutions.find(s => s.institution_name === newRequest.institution_name) && (
              <div>
                <Label className="text-sm">Or Enter Different Institution</Label>
                <Input
                  placeholder="e.g., Previous School Name"
                  value={newRequest.institution_name}
                  onChange={(e) => setNewRequest({...newRequest, institution_name: e.target.value})}
                />
              </div>
            )}
            <div>
              <Label className="text-sm">Years Attended</Label>
              <Input
                placeholder="e.g., 2018-2022"
                value={newRequest.years_attended}
                onChange={(e) => setNewRequest({...newRequest, years_attended: e.target.value})}
              />
            </div>
            <div>
              <Label className="text-sm">Send To (Recipient)</Label>
              <Select 
                value={newRequest.recipient_name} 
                onValueChange={(v) => {
                  const uni = universities.find(u => u.university_name === v);
                  setNewRequest({...newRequest, recipient_name: v, university_application_id: uni?.id});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select university or type below" />
                </SelectTrigger>
                <SelectContent>
                  {universities.map(u => (
                    <SelectItem key={u.id} value={u.university_name}>{u.university_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">Or Enter Recipient Name</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., University of Tennessee Admissions"
                  value={newRequest.recipient_name}
                  onChange={(e) => setNewRequest({...newRequest, recipient_name: e.target.value})}
                  className="flex-1"
                />
                <Button 
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAILookup}
                  disabled={!newRequest.recipient_name || isGenerating}
                  className="gap-1"
                >
                  <Sparkles className="w-3 h-3" />
                  {isGenerating ? 'Looking up...' : 'AI Lookup'}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm">Recipient Address (if mailing)</Label>
              <Textarea
                rows={2}
                placeholder="Full mailing address..."
                value={newRequest.recipient_address}
                onChange={(e) => setNewRequest({...newRequest, recipient_address: e.target.value})}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Delivery Method</Label>
                <Select value={newRequest.delivery_method} onValueChange={(v) => setNewRequest({...newRequest, delivery_method: v})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="electronic">Electronic</SelectItem>
                    <SelectItem value="mail">Mail</SelectItem>
                    <SelectItem value="pickup">Pickup</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm">Cost</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={newRequest.cost}
                  onChange={(e) => setNewRequest({...newRequest, cost: parseFloat(e.target.value) || 0})}
                />
              </div>
            </div>
            <div>
              <Label className="text-sm">Transcript Request Portal URL</Label>
              <Input
                placeholder="https://..."
                value={newRequest.transcript_portal_url}
                onChange={(e) => setNewRequest({...newRequest, transcript_portal_url: e.target.value})}
              />
            </div>
            <Button 
              onClick={() => createMutation.mutate(newRequest)} 
              disabled={!newRequest.institution_name || !newRequest.recipient_name || createMutation.isPending} 
              className="w-full"
            >
              Submit Request
            </Button>
          </div>
        )}

        {requests.length === 0 && !isAdding && (
          <p className="text-sm text-slate-500 italic text-center py-4">
            No transcript requests yet. Click "Request Transcript" to get started.
          </p>
        )}

        {requests.map((req) => {
          const institutionType = INSTITUTION_TYPES.find(t => t.value === req.institution_type);
          
          return (
            <Card key={req.id} className="border-l-4 border-l-indigo-600">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <GraduationCap className="w-4 h-4 text-indigo-600" />
                      <h3 className="font-semibold text-sm">{req.institution_name}</h3>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-slate-600">
                      {institutionType && <span>{institutionType.label}</span>}
                      {req.years_attended && <span>• {req.years_attended}</span>}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-slate-700">
                      <div><strong>Send to:</strong> {req.recipient_name}</div>
                      <div><strong>Method:</strong> {req.delivery_method}</div>
                      {req.requested_date && (
                        <div><strong>Requested:</strong> {format(new Date(req.requested_date), 'MMM dd, yyyy')}</div>
                      )}
                    </div>
                  </div>
                  <Badge className={getStatusColor(req.request_status)}>
                    {req.request_status}
                  </Badge>
                </div>

                {req.recipient_address && req.delivery_method === 'mail' && (
                  <div className="text-xs text-slate-600 bg-slate-50 p-2 rounded">
                    <strong>Mailing to:</strong><br />
                    {req.recipient_address}
                  </div>
                )}

                {req.cost > 0 && (
                  <div className="flex items-center justify-between p-2 bg-slate-50 rounded">
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
                    {req.transcript_portal_url && req.payment_status === 'pending' && (
                      <Button
                        size="sm"
                        className="h-6 text-xs gap-1"
                        onClick={() => {
                          window.open(req.transcript_portal_url, '_blank');
                          updateMutation.mutate({ 
                            id: req.id, 
                            data: { 
                              payment_status: 'paid',
                              payment_date: new Date().toISOString(),
                              request_status: 'processing'
                            }
                          });
                        }}
                      >
                        <ExternalLink className="w-3 h-3" />
                        Pay & Request
                      </Button>
                    )}
                  </div>
                )}

                {req.transcript_portal_url && (req.payment_status === 'paid' || req.cost === 0) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => window.open(req.transcript_portal_url, '_blank')}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open Portal
                  </Button>
                )}

                <div className="flex items-center gap-2 pt-2 border-t">
                  <Select 
                    value={req.request_status} 
                    onValueChange={(v) => updateMutation.mutate({ id: req.id, data: { 
                      request_status: v,
                      sent_date: v === 'sent' ? new Date().toISOString() : req.sent_date
                    }})}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="sent">Sent</SelectItem>
                      <SelectItem value="received">Received</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => {
                      if (window.confirm('Remove this transcript request?')) {
                        deleteMutation.mutate(req.id);
                      }
                    }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}