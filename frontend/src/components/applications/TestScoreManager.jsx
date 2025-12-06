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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Award, Send, CheckCircle2, AlertCircle, Clock, Plus, X, Zap, DollarSign, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const TEST_TYPES = [
  { value: 'ACT', label: 'ACT', sendUrl: 'https://www.act.org/content/act/en/products-and-services/the-act/scores/send-scores.html' },
  { value: 'SAT', label: 'SAT', sendUrl: 'https://satsuite.collegeboard.org/sat/scores/send-scores' },
  { value: 'GRE', label: 'GRE (Graduate)', sendUrl: 'https://www.ets.org/gre/scores/send.html' },
  { value: 'GMAT', label: 'GMAT (Business)', sendUrl: 'https://www.mba.com/exams/gmat-exam/after-the-exam/send-your-scores' },
  { value: 'LSAT', label: 'LSAT (Law)', sendUrl: 'https://www.lsac.org/lsat/lsat-scoring/score-reporting' },
  { value: 'MCAT', label: 'MCAT (Medical)', sendUrl: 'https://students-residents.aamc.org/applying-medical-school/article/score-reporting-service/' },
  { value: 'AP', label: 'AP Exams', sendUrl: 'https://apstudents.collegeboard.org/sending-scores' },
  { value: 'TOEFL', label: 'TOEFL', sendUrl: 'https://www.ets.org/toefl/test-takers/ibt/scores/send.html' },
  { value: 'IELTS', label: 'IELTS', sendUrl: 'https://www.ielts.org/for-test-takers/results' }
];

export default function TestScoreManager({ organizationId, organization, isStudent }) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [selectedRelease, setSelectedRelease] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newRelease, setNewRelease] = useState({
    test_type: 'ACT',
    recipient_name: '',
    recipient_code: '',
    cost: 0
  });

  const { data: releases = [] } = useQuery({
    queryKey: ['testScoreReleases', organizationId],
    queryFn: () => base44.entities.TestScoreRelease.filter({ organization_id: organizationId }, '-created_date'),
    enabled: !!organizationId && isStudent
  });

  const { data: universities = [] } = useQuery({
    queryKey: ['universityApplications', organizationId],
    queryFn: () => base44.entities.UniversityApplication.filter({ organization_id: organizationId }),
    enabled: !!organizationId && isStudent
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.TestScoreRelease.create({
      ...data,
      organization_id: organizationId
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['testScoreReleases', organizationId] });
      setIsAdding(false);
      setNewRelease({
        test_type: 'ACT',
        recipient_name: '',
        recipient_code: '',
        cost: 0
      });
      toast.success('Test score release added');
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.TestScoreRelease.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['testScoreReleases', organizationId] });
    }
  });

  const handleAuthorizeTransfer = (release) => {
    setSelectedRelease(release);
    setShowAuthDialog(true);
  };

  const confirmAuthorization = () => {
    if (!selectedRelease) return;
    
    updateMutation.mutate({
      id: selectedRelease.id,
      data: {
        authorization_granted: true,
        authorized_date: new Date().toISOString(),
        send_status: 'processing',
        payment_status: selectedRelease.cost > 0 ? 'pending' : 'waived'
      }
    });
    
    toast.success('Authorization granted - scores will be sent', {
      description: 'You will receive confirmation once the scores are sent.'
    });
    
    setShowAuthDialog(false);
    setSelectedRelease(null);
  };

  if (!isStudent) return null;

  const handleAILookup = async () => {
    if (!newRelease.recipient_name || !newRelease.test_type) {
      toast.error('Please select test type and recipient first');
      return;
    }
    
    setIsGenerating(true);
    
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Research ${newRelease.recipient_name} and find:
1. The official ${newRelease.test_type} recipient code/institution code for sending test scores
2. The current cost to send ${newRelease.test_type} scores to this institution

For reference:
- ACT institution codes are 4-digit numbers
- SAT institution codes (CSS codes) are 4-digit numbers
- GRE and other graduate test codes vary by institution

Return as JSON with keys: recipient_code (as string), cost (as number)`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            recipient_code: { type: "string" },
            cost: { type: "number" }
          }
        }
      });
      
      setNewRelease(prev => ({
        ...prev,
        recipient_code: response.recipient_code || prev.recipient_code,
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
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Award className="w-5 h-5 text-purple-600" />
              Test Score Releases
            </CardTitle>
            <Button size="sm" onClick={() => setIsAdding(!isAdding)}>
              {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4 mr-1" />}
              {isAdding ? 'Cancel' : 'Add Release'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdding && (
            <div className="p-4 bg-slate-50 rounded-lg space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm">Test Type</Label>
                  <Select value={newRelease.test_type} onValueChange={(v) => setNewRelease({...newRelease, test_type: v})}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEST_TYPES.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm">Recipient</Label>
                  <Select 
                    value={newRelease.recipient_name} 
                    onValueChange={(v) => {
                      const uni = universities.find(u => u.university_name === v);
                      setNewRelease({...newRelease, recipient_name: v, university_application_id: uni?.id});
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select or type below" />
                    </SelectTrigger>
                    <SelectContent>
                      {universities.map(u => (
                        <SelectItem key={u.id} value={u.university_name}>{u.university_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-sm">Or Enter Recipient Name</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g., University of Tennessee"
                    value={newRelease.recipient_name}
                    onChange={(e) => setNewRelease({...newRelease, recipient_name: e.target.value})}
                    className="flex-1"
                  />
                  <Button 
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleAILookup}
                    disabled={!newRelease.recipient_name || !newRelease.test_type || isGenerating}
                    className="gap-1"
                  >
                    <Sparkles className="w-3 h-3" />
                    {isGenerating ? 'Looking up...' : 'AI Lookup'}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm">Recipient Code (if known)</Label>
                  <Input
                    placeholder="e.g., 1843"
                    value={newRelease.recipient_code}
                    onChange={(e) => setNewRelease({...newRelease, recipient_code: e.target.value})}
                  />
                </div>
                <div>
                  <Label className="text-sm">Cost</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={newRelease.cost}
                    onChange={(e) => setNewRelease({...newRelease, cost: parseFloat(e.target.value) || 0})}
                  />
                </div>
              </div>
              <Button onClick={() => createMutation.mutate(newRelease)} disabled={!newRelease.recipient_name || createMutation.isPending} className="w-full">
                Add Score Release
              </Button>
            </div>
          )}

          {releases.length === 0 && !isAdding && (
            <p className="text-sm text-slate-500 italic text-center py-4">
              No test score releases scheduled. Add one to track score sends.
            </p>
          )}

          {releases.map((release) => {
            const testInfo = TEST_TYPES.find(t => t.value === release.test_type);
            
            return (
              <div key={release.id} className="p-3 border rounded-lg bg-white">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Award className="w-4 h-4 text-purple-600" />
                      <span className="font-medium text-sm">{release.test_type}</span>
                      <span className="text-xs text-slate-500">→</span>
                      <span className="text-sm text-slate-700">{release.recipient_name}</span>
                    </div>
                    {release.recipient_code && (
                      <p className="text-xs text-slate-500 mt-1">Code: {release.recipient_code}</p>
                    )}
                  </div>
                  <Badge className={getStatusColor(release.send_status)}>
                    {release.send_status}
                  </Badge>
                </div>

                {release.cost > 0 && (
                  <div className="flex items-center gap-1 text-xs text-slate-600 mt-2">
                    <DollarSign className="w-3 h-3" />
                    <span>${release.cost.toFixed(2)}</span>
                    <Badge variant="outline" className="ml-2 text-xs">
                      {release.payment_status}
                    </Badge>
                  </div>
                )}

                {release.sent_date && (
                  <div className="text-xs text-slate-500 mt-2">
                    Sent: {format(new Date(release.sent_date), 'MMM dd, yyyy')}
                    {release.confirmation_number && ` • Confirmation: ${release.confirmation_number}`}
                  </div>
                )}

                <div className="flex gap-2 mt-3 pt-2 border-t">
                  {!release.authorization_granted && release.send_status === 'pending' && (
                    <Button
                      size="sm"
                      className="flex-1 gap-2"
                      onClick={() => handleAuthorizeTransfer(release)}
                    >
                      <Zap className="w-3 h-3" />
                      Authorize Auto-Send
                    </Button>
                  )}
                  {testInfo?.sendUrl && release.payment_status !== 'paid' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 gap-2"
                      onClick={() => {
                        window.open(testInfo.sendUrl, '_blank');
                        if (release.cost > 0) {
                          updateMutation.mutate({ 
                            id: release.id, 
                            data: { payment_status: 'paid' }
                          });
                        }
                      }}
                    >
                      <Send className="w-3 h-3" />
                      {release.cost > 0 ? 'Pay & Send' : 'Send'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm('Remove this score release?')) {
                        updateMutation.mutate({ 
                          id: release.id, 
                          data: { send_status: 'cancelled' } 
                        });
                      }
                    }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={showAuthDialog} onOpenChange={setShowAuthDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Authorize Automatic Score Send</DialogTitle>
            <DialogDescription>
              You are authorizing GrantFlow to automatically send your {selectedRelease?.test_type} scores to {selectedRelease?.recipient_name}.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 rounded-lg space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5" />
                <div className="text-sm text-blue-900">
                  <p className="font-medium">What happens next:</p>
                  <ul className="list-disc ml-4 mt-2 space-y-1 text-blue-800">
                    <li>Your scores will be requested from the testing agency</li>
                    <li>Scores will be sent directly to the institution</li>
                    <li>You'll receive confirmation when complete</li>
                    {selectedRelease?.cost > 0 && (
                      <li>Fee of ${selectedRelease.cost} will be charged</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>

            <div className="bg-slate-50 p-3 rounded text-xs space-y-1">
              <div><strong>Test:</strong> {selectedRelease?.test_type}</div>
              <div><strong>Recipient:</strong> {selectedRelease?.recipient_name}</div>
              {selectedRelease?.recipient_code && (
                <div><strong>Code:</strong> {selectedRelease?.recipient_code}</div>
              )}
              {selectedRelease?.cost > 0 && (
                <div><strong>Cost:</strong> ${selectedRelease?.cost.toFixed(2)}</div>
              )}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowAuthDialog(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={confirmAuthorization} className="flex-1">
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Authorize Send
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}