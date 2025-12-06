import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Plus,
  Loader2,
  Search,
  Mail,
  TrendingUp,
  Clock,
  CheckCircle2,
  MessageSquare,
  Sparkles,
  Filter,
  BarChart3
} from 'lucide-react';
import OutreachCard from '@/components/outreach/OutreachCard';
import OutreachComposer from '@/components/outreach/OutreachComposer';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function OutreachCampaigns() {
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [editingOutreach, setEditingOutreach] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // M5 FIX: Use centralized auth context instead of duplicate query
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: async () => {
      const r = isAdmin
        ? await base44.entities.Organization.list()
        : await base44.entities.Organization.filter({ created_by: user?.email });
      if (r?.error) return [];
      return Array.isArray(r) ? r : (r?.data || []);
    },
    enabled: !!user?.email,
  });

  // H1 FIX: Added user?.email and isAdmin to query key for proper cache scoping
  const { data: outreachCampaigns = [], isLoading: isLoadingCampaigns } = useQuery({
    queryKey: ['outreachCampaigns', selectedOrgId, user?.email, isAdmin],
    queryFn: async () => {
      let r;
      if (selectedOrgId && selectedOrgId !== 'all') {
        r = await base44.entities.OutreachCampaign.filter(
          { organization_id: selectedOrgId }
        );
      } else {
        r = isAdmin
          ? await base44.entities.OutreachCampaign.list()
          : await base44.entities.OutreachCampaign.filter({ created_by: user?.email });
      }
      if (r?.error) return [];
      return Array.isArray(r) ? r : (r?.data || []);
    },
    enabled: !!user?.email,
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const r = await base44.entities.OutreachCampaign.create(data);
      if (r?.error) throw new Error(r.error);
      return r?.data || r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['outreachCampaigns', selectedOrgId, user?.email, isAdmin] });
      setShowComposer(false);
      setEditingOutreach(null);
      toast({
        title: '✅ Outreach Saved',
        description: 'Message saved and ready to send.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: error.message,
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      const r = await base44.entities.OutreachCampaign.update(id, data);
      if (r?.error) throw new Error(r.error);
      return r?.data || r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['outreachCampaigns', selectedOrgId, user?.email, isAdmin] });
      setShowComposer(false);
      setEditingOutreach(null);
      toast({
        title: '✅ Outreach Updated',
        description: 'Changes saved successfully.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Update Failed',
        description: error.message,
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const r = await base44.entities.OutreachCampaign.delete(id);
      if (r?.error) throw new Error(r.error);
      return r?.data || r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['outreachCampaigns', selectedOrgId, user?.email, isAdmin] });
      toast({
        title: 'Outreach Deleted',
        description: 'Outreach campaign removed.',
      });
    },
  });

  const selectedOrg = useMemo(() => 
    organizations.find(o => o.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  const filteredCampaigns = useMemo(() => {
    if (!Array.isArray(outreachCampaigns)) return [];
    return outreachCampaigns.filter(campaign => {
      const matchesSearch = !searchTerm || 
        (campaign?.funder_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (campaign?.subject_line || '').toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesStatus = statusFilter === 'all' || campaign?.status === statusFilter;
      
      return matchesSearch && matchesStatus;
    });
  }, [outreachCampaigns, searchTerm, statusFilter]);

  const stats = useMemo(() => {
    const campaigns = Array.isArray(outreachCampaigns) ? outreachCampaigns : [];
    const total = campaigns.length;
    const sent = campaigns.filter(c => ['sent', 'opened', 'replied'].includes(c?.status)).length;
    const replied = campaigns.filter(c => c?.status === 'replied').length;
    const followUpNeeded = campaigns.filter(c => c?.status === 'follow_up_needed').length;
    const won = campaigns.filter(c => c?.status === 'closed_won').length;
    
    const responseRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
    
    return { total, sent, replied, followUpNeeded, won, responseRate };
  }, [outreachCampaigns]);

  const handleSave = (outreachData) => {
    if (editingOutreach) {
      updateMutation.mutate({ id: editingOutreach.id, data: outreachData });
    } else {
      createMutation.mutate(outreachData);
    }
  };

  const handleEdit = (outreach) => {
    setEditingOutreach(outreach);
    setShowComposer(true);
  };

  const handleDelete = (outreach) => {
    if (confirm(`Delete outreach to ${outreach.funder_name}?`)) {
      deleteMutation.mutate(outreach.id);
    }
  };

  const handleMarkSent = (outreach) => {
    updateMutation.mutate({
      id: outreach.id,
      data: {
        status: 'sent',
        sent_date: new Date().toISOString()
      }
    });
  };

  if (showComposer) {
    return (
      <div className="p-6 md:p-8">
        <OutreachComposer
          organizationId={selectedOrgId}
          organizationName={selectedOrg?.name}
          existingOutreach={editingOutreach}
          onSave={handleSave}
          onCancel={() => {
            setShowComposer(false);
            setEditingOutreach(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Mail className="w-8 h-8 text-blue-600" />
              Outreach Campaigns
            </h1>
            <p className="text-slate-600 mt-2">
              AI-powered funder outreach with tracking
            </p>
          </div>
          
          <Button
            onClick={() => {
              setEditingOutreach(null);
              setShowComposer(true);
            }}
            disabled={!selectedOrgId || selectedOrgId === 'all'}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 shadow-lg"
          >
            <Plus className="w-5 h-5 mr-2" />
            Create Outreach
          </Button>
        </header>

        {!selectedOrgId || selectedOrgId === 'all' ? (
          <Alert className="bg-blue-50 border-blue-200">
            <MessageSquare className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-900">
              Select a profile below to view and manage outreach campaigns.
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardContent className="p-4">
            <label className="text-sm font-semibold mb-2 block">Select Profile</label>
            <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
              <SelectTrigger className="h-12">
                <SelectValue placeholder="Choose organization..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Organizations</SelectItem>
                {organizations.map(org => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {selectedOrgId && selectedOrgId !== 'all' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <BarChart3 className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                  <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
                  <p className="text-sm text-slate-600">Total Outreach</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4 text-center">
                  <Mail className="w-8 h-8 mx-auto text-purple-600 mb-2" />
                  <p className="text-2xl font-bold text-purple-900">{stats.sent}</p>
                  <p className="text-sm text-slate-600">Sent</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4 text-center">
                  <MessageSquare className="w-8 h-8 mx-auto text-blue-600 mb-2" />
                  <p className="text-2xl font-bold text-blue-900">{stats.replied}</p>
                  <p className="text-sm text-slate-600">Replied</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4 text-center">
                  <Clock className="w-8 h-8 mx-auto text-amber-600 mb-2" />
                  <p className="text-2xl font-bold text-amber-900">{stats.followUpNeeded}</p>
                  <p className="text-sm text-slate-600">Follow-Up</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-4 text-center">
                  <CheckCircle2 className="w-8 h-8 mx-auto text-green-600 mb-2" />
                  <p className="text-2xl font-bold text-green-900">{stats.won}</p>
                  <p className="text-sm text-slate-600">Won</p>
                </CardContent>
              </Card>
            </div>

            {stats.sent > 0 && (
              <Card className="bg-gradient-to-r from-emerald-50 to-blue-50 border-emerald-200">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-slate-600 font-semibold">Response Rate</p>
                      <p className="text-3xl font-bold text-emerald-700">{stats.responseRate}%</p>
                    </div>
                    <TrendingUp className="w-12 h-12 text-emerald-600" />
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by funder name or subject..."
                  className="h-12"
                />
              </div>
              
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-48 h-12">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="ready_to_send">Ready to Send</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="replied">Replied</SelectItem>
                  <SelectItem value="follow_up_needed">Follow-Up Needed</SelectItem>
                  <SelectItem value="closed_won">Won</SelectItem>
                  <SelectItem value="closed_lost">Lost</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoadingCampaigns ? (
              <div className="flex justify-center items-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : filteredCampaigns.length === 0 ? (
              <Card className="shadow-lg border-0">
                <CardContent className="p-12 text-center">
                  <Mail className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    {searchTerm || statusFilter !== 'all' 
                      ? 'No Matching Outreach' 
                      : 'No Outreach Campaigns Yet'
                    }
                  </h3>
                  <p className="text-slate-600 mb-4">
                    {searchTerm || statusFilter !== 'all'
                      ? 'Try adjusting your filters'
                      : 'Start building relationships with funders using AI-powered personalized messages'
                    }
                  </p>
                  {!searchTerm && statusFilter === 'all' && (
                    <Button
                      onClick={() => setShowComposer(true)}
                      className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                    >
                      <Sparkles className="w-5 h-5 mr-2" />
                      Create First Outreach
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                {filteredCampaigns.map(campaign => (
                  <OutreachCard
                    key={campaign.id}
                    outreach={campaign}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onSend={handleMarkSent}
                  />
                ))}
              </div>
            )}

            {filteredCampaigns.length > 0 && (
              <div className="text-center text-sm text-slate-500 mt-6">
                Showing {filteredCampaigns.length} of {(outreachCampaigns || []).length} campaigns
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}