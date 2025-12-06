import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  ArrowLeft, 
  Edit, 
  Building2, 
  Mail, 
  Phone, 
  Globe, 
  MapPin,
  DollarSign,
  Calendar,
  MessageSquare,
  Bell,
  Plus,
  Loader2
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import FunderForm from '@/components/funders/FunderForm';
import InteractionForm from '@/components/funders/InteractionForm';
import ReminderForm from '@/components/funders/ReminderForm';

export default function FunderProfile() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showInteractionForm, setShowInteractionForm] = useState(false);
  const [showReminderForm, setShowReminderForm] = useState(false);
  
  const [searchParams] = useSearchParams();
  const funderId = searchParams.get("id") || null;

  const { data: funder, isLoading } = useQuery({
    queryKey: ['funder', funderId],
    queryFn: async () => {
      if (!funderId) return null;
      const results = await base44.entities.Funder.filter({ id: funderId });
      return results?.[0] || null;
    },
    enabled: !!funderId
  });

  const { data: interactions } = useQuery({
    queryKey: ['interactions', funderId],
    queryFn: async () => {
      if (!funderId) return [];
      const r = await base44.entities.FunderInteraction.filter({ funder_id: funderId }, '-interaction_date');
      return Array.isArray(r) ? r : [];
    },
    enabled: !!funderId
  });

  const { data: reminders } = useQuery({
    queryKey: ['reminders', funderId],
    queryFn: async () => {
      if (!funderId) return [];
      const r = await base44.entities.FunderReminder.filter({ funder_id: funderId }, 'due_date');
      return Array.isArray(r) ? r : [];
    },
    enabled: !!funderId
  });

  const { data: grants } = useQuery({
    queryKey: ['grants'],
    queryFn: () => base44.entities.Grant.list("-created_date")
  });

  const funderGrants = Array.isArray(grants)
    ? grants.filter(g =>
        (g.funder || "").trim().toLowerCase() ===
        (funder?.name || "").trim().toLowerCase()
      )
    : [];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!funder) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-slate-600">Funder not found</p>
          <Button onClick={() => navigate(createPageUrl('Funders'))} className="mt-4">
            Back to Funders
          </Button>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-4xl mx-auto">
          <FunderForm funder={funder} onClose={() => setEditing(false)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <Button variant="ghost" onClick={() => navigate(createPageUrl('Funders'))} className="gap-2 mb-4">
            <ArrowLeft className="w-4 h-4" />
            Back to Funders
          </Button>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Building2 className="w-8 h-8 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-slate-900">{funder.name}</h1>
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline">{funder.funder_type}</Badge>
                  <Badge>{(funder.relationship_strength || "none").replace(/_/g, ' ')}</Badge>
                </div>
              </div>
            </div>
            <Button onClick={() => setEditing(true)}>
              <Edit className="w-4 h-4 mr-2" />
              Edit
            </Button>
          </div>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="interactions">
              Interactions ({interactions?.length || 0})
            </TabsTrigger>
            <TabsTrigger value="reminders">
              Reminders ({Array.isArray(reminders) ? reminders.filter(r => !r.completed).length : 0})
            </TabsTrigger>
            <TabsTrigger value="grants">
              Grants ({funderGrants.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Contact Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {funder.contact_person && (
                    <div>
                      <p className="text-sm font-medium text-slate-900">{funder.contact_person}</p>
                      {funder.contact_title && (
                        <p className="text-sm text-slate-600">{funder.contact_title}</p>
                      )}
                    </div>
                  )}
                  {funder.email && (
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <a href={`mailto:${funder.email}`} className="text-blue-600 hover:underline">
                        {funder.email}
                      </a>
                    </div>
                  )}
                  {funder.phone && (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="w-4 h-4 text-slate-400" />
                      <span>{funder.phone}</span>
                    </div>
                  )}
                  {funder.website && (
                    <div className="flex items-center gap-2 text-sm">
                      <Globe className="w-4 h-4 text-slate-400" />
                      <a href={funder.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {funder.website}
                      </a>
                    </div>
                  )}
                  {(funder.address || funder.city) && (
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                      <div>
                        {funder.address && <p>{funder.address}</p>}
                        {funder.city && (
                          <p>{funder.city}, {funder.state} {funder.zip}</p>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Funding Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(funder.typical_award_min || funder.typical_award_max) && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Typical Award Range</p>
                      <div className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-green-600" />
                        <span className="text-lg font-semibold">
                          ${(funder.typical_award_min || 0).toLocaleString()} - 
                          ${(funder.typical_award_max || 0).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                  {funder.total_awarded > 0 && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Total Awarded to Us</p>
                      <p className="text-lg font-semibold text-blue-600">
                        ${funder.total_awarded.toLocaleString()}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium text-slate-600 mb-1">Deadline Frequency</p>
                    <Badge variant="outline">{funder.deadline_frequency}</Badge>
                  </div>
                  {funder.next_deadline && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Next Deadline</p>
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-orange-600" />
                        <span>{funder.next_deadline ? new Date(funder.next_deadline).toLocaleDateString() : "N/A"}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {funder.mission && (
              <Card>
                <CardHeader>
                  <CardTitle>Mission</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-700">{funder.mission}</p>
                </CardContent>
              </Card>
            )}

            {(funder.focus_areas || funder.geographic_scope) && (
              <Card>
                <CardHeader>
                  <CardTitle>Focus & Scope</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {funder.focus_areas && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Focus Areas</p>
                      <p className="text-slate-700">{funder.focus_areas}</p>
                    </div>
                  )}
                  {funder.geographic_scope && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Geographic Scope</p>
                      <p className="text-slate-700">{funder.geographic_scope}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {(funder.application_preferences || funder.submission_portal) && (
              <Card>
                <CardHeader>
                  <CardTitle>Application Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {funder.submission_portal && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Submission Portal</p>
                      <a 
                        href={funder.submission_portal?.startsWith("http") 
                          ? funder.submission_portal 
                          : `https://${funder.submission_portal}`} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="text-blue-600 hover:underline"
                      >
                        {funder.submission_portal}
                      </a>
                    </div>
                  )}
                  {funder.application_preferences && (
                    <div>
                      <p className="text-sm font-medium text-slate-600 mb-1">Application Preferences</p>
                      <p className="text-slate-700 whitespace-pre-wrap">{funder.application_preferences}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {funder.notes && (
              <Card>
                <CardHeader>
                  <CardTitle>Notes</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-700 whitespace-pre-wrap">{funder.notes}</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="interactions">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold">Interaction History</h2>
                <Button onClick={() => setShowInteractionForm(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Log Interaction
                </Button>
              </div>

              {showInteractionForm && (
                <InteractionForm 
                  funderId={funderId}
                  funderName={funder.name}
                  onClose={() => setShowInteractionForm(false)}
                />
              )}

              {(interactions || []).length > 0 ? (
                <div className="space-y-3">
                  {(interactions || []).map((interaction) => (
                    <Card key={interaction.id}>
                      <CardContent className="pt-6">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <h3 className="font-semibold">{interaction.subject}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline">{interaction.interaction_type}</Badge>
                              <span className="text-sm text-slate-600">
                                {new Date(interaction.interaction_date).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                          {interaction.follow_up_needed && !interaction.follow_up_completed && (
                            <Badge className="bg-orange-100 text-orange-800">Follow-up Needed</Badge>
                          )}
                        </div>
                        {interaction.contact_person && (
                          <p className="text-sm text-slate-600 mb-2">Contact: {interaction.contact_person}</p>
                        )}
                        {interaction.summary && (
                          <p className="text-sm text-slate-700 mb-2">{interaction.summary}</p>
                        )}
                        {interaction.outcome && (
                          <div className="mt-2 p-2 bg-blue-50 rounded">
                            <p className="text-sm"><strong>Outcome:</strong> {interaction.outcome}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <MessageSquare className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500">No interactions logged yet</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="reminders">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold">Reminders & Deadlines</h2>
                <Button onClick={() => setShowReminderForm(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Reminder
                </Button>
              </div>

              {showReminderForm && (
                <ReminderForm 
                  funderId={funderId}
                  funderName={funder.name}
                  onClose={() => setShowReminderForm(false)}
                />
              )}

              {(reminders || []).length > 0 ? (
                <div className="space-y-3">
                  {(reminders || []).map((reminder) => (
                    <Card key={reminder.id} className={reminder.completed ? 'opacity-60' : ''}>
                      <CardContent className="pt-6">
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="font-semibold">{reminder.title}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline">{reminder.reminder_type}</Badge>
                              <Badge variant={reminder.priority === 'critical' ? 'destructive' : 'secondary'}>
                                {reminder.priority}
                              </Badge>
                              <span className="text-sm text-slate-600">
                                Due: {new Date(reminder.due_date).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                          {reminder.completed ? (
                            <Badge className="bg-green-100 text-green-800">Completed</Badge>
                          ) : (
                            <Badge className="bg-orange-100 text-orange-800">Active</Badge>
                          )}
                        </div>
                        {reminder.description && (
                          <p className="text-sm text-slate-700 mt-2">{reminder.description}</p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Bell className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500">No reminders set</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="grants">
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Associated Grants</h2>
              {(funderGrants || []).length > 0 ? (
                <div className="grid md:grid-cols-2 gap-4">
                  {(funderGrants || []).map((grant) => (
                    <Card 
                      key={grant.id}
                      className="cursor-pointer hover:shadow-lg transition-shadow"
                      onClick={() => navigate(createPageUrl(`GrantDetail?id=${grant.id}`))}
                    >
                      <CardHeader>
                        <CardTitle className="text-lg">{grant.title}</CardTitle>
                        <CardDescription>
                          <Badge variant="outline">{grant.status}</Badge>
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {grant.deadline && (
                          <p className="text-sm text-slate-600">
                            Deadline: {new Date(grant.deadline).toLocaleDateString()}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <p className="text-slate-500">No grants associated with this funder</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}