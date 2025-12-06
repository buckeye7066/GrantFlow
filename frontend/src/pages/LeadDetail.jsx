import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { 
  ArrowLeft,
  Save,
  Trash2,
  Plus,
  Calendar,
  Phone,
  Mail,
  MessageSquare,
  CheckCircle2,
  Clock,
  Loader2
} from "lucide-react";
import ActivityTimeline from "@/components/crm/ActivityTimeline";
import AddActivityDialog from "@/components/crm/AddActivityDialog";

export default function LeadDetail() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const leadId = searchParams.get('id');
  const isNew = searchParams.get('new') === 'true';
  
  const [formData, setFormData] = useState({
    first_name: "",
    last_name: "",
    organization_name: "",
    email: "",
    phone: "",
    title: "",
    lead_source: "website",
    status: "new",
    assigned_to: "",
    estimated_value: "",
    priority: "medium",
    notes: "",
    website: "",
    address: "",
    city: "",
    state: "",
    zip: ""
  });
  
  const [showActivityDialog, setShowActivityDialog] = useState(false);

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  useEffect(() => {
    if (user?.email) {
      base44.functions.invoke("autoCreateLead", { user });
    }
  }, [user]);

  const { data: lead, isLoading } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => base44.functions.invoke("getLead", { id: leadId }).then(r => r.data),
    enabled: Boolean(leadId && !isNew),
  });

  useEffect(() => {
    if (lead && lead.id) {
      setFormData(prev => ({
        ...prev,
        ...lead
      }));
    }
  }, [lead]);

  const { data: activities = [] } = useQuery({
    queryKey: ['activities', leadId],
    queryFn: () => base44.functions.invoke("getLeadActivities", { lead_id: leadId }).then(r => r.data || []),
    enabled: Boolean(leadId && !isNew),
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.functions.invoke("createLead", { data }).then(r => r.data),
    onSuccess: (newLead) => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast({
        title: "Lead Created",
        description: "The lead has been successfully created.",
      });
      navigate(createPageUrl(`LeadDetail?id=${newLead.id}`));
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error.message || "Failed to create lead.",
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.functions.invoke("updateLead", { id, data }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast({
        title: "Lead Updated",
        description: "Changes have been saved successfully.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "Failed to update lead.",
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.functions.invoke("deleteLead", { id }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast({
        title: "Lead Deleted",
        description: "The lead has been removed.",
      });
      navigate(createPageUrl('Leads'));
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "Failed to delete lead.",
      });
    }
  });

  const handleSave = () => {
    if (isNew) {
      createMutation.mutate(formData);
    } else if (lead?.id) {
      updateMutation.mutate({ id: lead.id, data: formData });
    }
  };

  const handleDelete = () => {
    if (window.confirm('Are you sure you want to delete this lead?')) {
      if (lead?.id) {
        deleteMutation.mutate(lead.id);
      }
    }
  };

  const handleChange = (field, value) => {
    if (field === "estimated_value") {
      value = Number(value || 0);
    }
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const currentLead = lead || null;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Button 
              variant="outline" 
              size="icon"
              onClick={() => navigate(createPageUrl('Leads'))}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">
                {isNew ? 'New Lead' : `${formData.first_name} ${formData.last_name}`}
              </h1>
              {!isNew && formData.organization_name && (
                <p className="text-slate-600 mt-1">{formData.organization_name}</p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            {!isNew && (
              <Button
                variant="outline"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </Button>
            )}
            <Button 
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              <Save className="w-4 h-4 mr-2" />
              {isNew ? 'Create Lead' : 'Save Changes'}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Info */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Lead Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>First Name *</Label>
                    <Input
                      value={formData.first_name}
                      onChange={(e) => handleChange('first_name', e.target.value)}
                      placeholder="John"
                    />
                  </div>
                  <div>
                    <Label>Last Name *</Label>
                    <Input
                      value={formData.last_name}
                      onChange={(e) => handleChange('last_name', e.target.value)}
                      placeholder="Doe"
                    />
                  </div>
                </div>

                <div>
                  <Label>Organization Name</Label>
                  <Input
                    value={formData.organization_name}
                    onChange={(e) => handleChange('organization_name', e.target.value)}
                    placeholder="Acme Inc."
                  />
                </div>

                <div>
                  <Label>Job Title</Label>
                  <Input
                    value={formData.title}
                    onChange={(e) => handleChange('title', e.target.value)}
                    placeholder="Executive Director"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Email</Label>
                    <Input
                      type="email"
                      value={formData.email}
                      onChange={(e) => handleChange('email', e.target.value)}
                      placeholder="john@example.com"
                    />
                  </div>
                  <div>
                    <Label>Phone</Label>
                    <Input
                      value={formData.phone}
                      onChange={(e) => handleChange('phone', e.target.value)}
                      placeholder="(555) 123-4567"
                    />
                  </div>
                </div>

                <div>
                  <Label>Website</Label>
                  <Input
                    value={formData.website}
                    onChange={(e) => handleChange('website', e.target.value)}
                    placeholder="https://example.com"
                  />
                </div>

                <div>
                  <Label>Address</Label>
                  <Input
                    value={formData.address}
                    onChange={(e) => handleChange('address', e.target.value)}
                    placeholder="123 Main St"
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label>City</Label>
                    <Input
                      value={formData.city}
                      onChange={(e) => handleChange('city', e.target.value)}
                      placeholder="Nashville"
                    />
                  </div>
                  <div>
                    <Label>State</Label>
                    <Input
                      value={formData.state}
                      onChange={(e) => handleChange('state', e.target.value)}
                      placeholder="TN"
                    />
                  </div>
                  <div>
                    <Label>ZIP</Label>
                    <Input
                      value={formData.zip}
                      onChange={(e) => handleChange('zip', e.target.value)}
                      placeholder="37203"
                    />
                  </div>
                </div>

                <div>
                  <Label>Notes</Label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) => handleChange('notes', e.target.value)}
                    placeholder="Additional information about this lead..."
                    rows={4}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Activity Timeline */}
            {!isNew && currentLead && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Activity Timeline</CardTitle>
                    <Button 
                      size="sm"
                      onClick={() => setShowActivityDialog(true)}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add Activity
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <ActivityTimeline activities={activities} leadId={currentLead.id} />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Sales Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Status</Label>
                  <Select 
                    value={formData.status}
                    onValueChange={(value) => handleChange('status', value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">New</SelectItem>
                      <SelectItem value="contacted">Contacted</SelectItem>
                      <SelectItem value="qualified">Qualified</SelectItem>
                      <SelectItem value="proposal_sent">Proposal Sent</SelectItem>
                      <SelectItem value="negotiation">Negotiation</SelectItem>
                      <SelectItem value="won">Won</SelectItem>
                      <SelectItem value="lost">Lost</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Priority</Label>
                  <Select 
                    value={formData.priority}
                    onValueChange={(value) => handleChange('priority', value)}
                  >
                    <SelectTrigger>
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

                <div>
                  <Label>Lead Source</Label>
                  <Select 
                    value={formData.lead_source}
                    onValueChange={(value) => handleChange('lead_source', value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="website">Website</SelectItem>
                      <SelectItem value="referral">Referral</SelectItem>
                      <SelectItem value="cold_outreach">Cold Outreach</SelectItem>
                      <SelectItem value="conference">Conference</SelectItem>
                      <SelectItem value="social_media">Social Media</SelectItem>
                      <SelectItem value="advertisement">Advertisement</SelectItem>
                      <SelectItem value="partnership">Partnership</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Assigned To</Label>
                  <Input
                    value={formData.assigned_to}
                    onChange={(e) => handleChange('assigned_to', e.target.value)}
                    placeholder="rep@example.com"
                  />
                </div>

                <div>
                  <Label>Estimated Value ($)</Label>
                  <Input
                    type="number"
                    value={formData.estimated_value}
                    onChange={(e) => handleChange('estimated_value', e.target.value)}
                    placeholder="10000"
                  />
                </div>
              </CardContent>
            </Card>

            {!isNew && activities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Quick Stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Total Activities</span>
                    <Badge variant="outline">{activities.length}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Completed</span>
                    <Badge variant="outline" className="bg-green-50 text-green-700">
                      {activities.filter(a => a.completed).length}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Pending</span>
                    <Badge variant="outline" className="bg-blue-50 text-blue-700">
                      {activities.filter(a => !a.completed).length}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {currentLead && (
        <AddActivityDialog
          open={showActivityDialog}
          onOpenChange={setShowActivityDialog}
          leadId={currentLead.id}
        />
      )}
    </div>
  );
}