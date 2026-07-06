import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { 
  Users, 
  Mail, 
  Phone, 
  Building, 
  Clock, 
  CheckCircle, 
  XCircle,
  RefreshCw,
  UserPlus,
  Eye,
  Trash2
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { apiFetch } from '@/api/client';
import { parseTimestamp } from '@/lib/utils'

const STATUS_COLORS = {
  new: 'bg-blue-500',
  reviewed: 'bg-yellow-500',
  contacted: 'bg-purple-500',
  converted: 'bg-green-500',
  archived: 'bg-gray-500',
};

const STATUS_LABELS = {
  new: 'New',
  reviewed: 'Reviewed',
  contacted: 'Contacted',
  converted: 'Converted',
  archived: 'Archived',
};

export default function AdminServiceApplications() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedApp, setSelectedApp] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const { toast } = useToast();

  const fetchApplications = async () => {
    setLoading(true);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const response = await apiFetch(`/api/service-application/list${params}`);
      // Backward-compatible: some responses wrap in { success, applications }.
      const apps = response?.applications ?? response?.data?.applications ?? response;
      setApplications(Array.isArray(apps) ? apps : []);
    } catch (error) {
      // Auth/permission errors (401/403) are expected during bootstrap or for
      // non-admin users — don't show a scary toast, just log quietly.
      if (error?.status === 401 || error?.status === 403) {
        console.warn('[AdminServiceApplications] Auth/permission error fetching applications:', error.status);
      } else {
        console.error('Failed to fetch applications:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load service applications',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApplications();
  }, [statusFilter]);

  const updateApplicationStatus = async (id, status, notes = null) => {
    try {
      const body = { status };
      if (notes) body.notes = notes;

      const response = await apiFetch(`/api/service-application/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Converting creates (or links) a real client profile server-side —
      // surface which one so the admin can find it in the profile list.
      const conversion = response?.conversion;
      toast({
        title: status === 'converted' ? 'Converted to profile' : 'Updated',
        description:
          status === 'converted' && conversion
            ? conversion.created
              ? 'A new client profile was created and linked. It now appears in Profiles.'
              : `Linked to existing profile (matched by ${conversion.matched_by}).`
            : `Application marked as ${STATUS_LABELS[status]}`,
      });

      fetchApplications();
      setSelectedApp(null);
    } catch (error) {
      console.error('Failed to update application:', error);
      const candidates = error?.details?.candidates;
      toast({
        variant: 'destructive',
        title: 'Error',
        description: candidates?.length
          ? 'Multiple existing profiles match this applicant — open Profiles and link one manually.'
          : (error?.message || 'Failed to update application'),
      });
    }
  };

  const deleteApplication = async (id) => {
    try {
      await apiFetch(`/api/service-application/${id}`, { method: 'DELETE' })
      toast({ title: 'Deleted', description: 'Application removed' })
      setSelectedApp(null)
      fetchApplications()
    } catch (error) {
      console.error('Failed to delete application:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error?.message || 'Failed to delete application',
      })
    }
  }

  const deleteProfileForApplication = async (id) => {
    try {
      const res = await apiFetch(`/api/service-application/${id}/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      toast({
        title: 'Deleted',
        description: res?.profile_id
          ? `Deleted profile ${res.profile_id}`
          : 'Deleted matching profile',
      })
      setSelectedApp(null)
      fetchApplications()
    } catch (error) {
      console.error('Failed to delete profile for application:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error?.message || 'Failed to delete profile',
      })
    }
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A'
    const date = parseTimestamp(dateStr)
    if (!date) return 'N/A'
    return date.toLocaleString()
  };

  const newCount = applications.filter(a => a.status === 'new').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Service Applications
              {newCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {newCount} New
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              New service applications and contact form submissions
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="reviewed">Reviewed</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="converted">Converted</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={fetchApplications}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : applications.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No applications found
          </div>
        ) : (
          <div className="space-y-3">
            {applications.map((app) => (
              <div
                key={app.id}
                className="border rounded-lg p-4 hover:bg-muted/50 cursor-pointer transition-colors"
                onClick={() => setSelectedApp(app)}
              >
                <div className="flex justify-between items-start">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{app.full_name}</span>
                      <Badge className={STATUS_COLORS[app.status]}>
                        {STATUS_LABELS[app.status]}
                      </Badge>
                      {app.type === 'contact_admin' && (
                        <Badge variant="outline">Contact Form</Badge>
                      )}
                      {app.type === 'signup' && (
                        <Badge variant="outline">Signup</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        {app.email}
                      </span>
                      {app.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {app.phone}
                        </span>
                      )}
                      {app.organization && (
                        <span className="flex items-center gap-1">
                          <Building className="h-3 w-3" />
                          {app.organization}
                        </span>
                      )}
                    </div>
                    {app.client_category && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Category:</span>{' '}
                        {app.client_category}
                      </div>
                    )}
                    {app.subject && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Subject:</span>{' '}
                        {app.subject}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDate(app.created_at)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Detail Dialog */}
        <Dialog open={!!selectedApp} onOpenChange={() => setSelectedApp(null)}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{selectedApp?.full_name}</DialogTitle>
              <DialogDescription>
                {selectedApp?.type === 'contact_admin' ? 'Contact Form Submission' : 'Service Application'}
              </DialogDescription>
            </DialogHeader>
            
            {selectedApp && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Email</label>
                    <p>{selectedApp.email}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Phone</label>
                    <p>{selectedApp.phone || 'Not provided'}</p>
                  </div>
                  {selectedApp.organization && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Organization</label>
                      <p>{selectedApp.organization}</p>
                    </div>
                  )}
                  {selectedApp.title && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Title</label>
                      <p>{selectedApp.title}</p>
                    </div>
                  )}
                  {selectedApp.client_category && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Client Category</label>
                      <p>{selectedApp.client_category}</p>
                    </div>
                  )}
                  {selectedApp.total_cost && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Estimated Cost</label>
                      <p>${selectedApp.total_cost}</p>
                    </div>
                  )}
                </div>

                {selectedApp.selected_services?.length > 0 && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Selected Services</label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedApp.selected_services.map((service, i) => (
                        <Badge key={i} variant="secondary">{service}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedApp.subject && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Subject</label>
                    <p>{selectedApp.subject}</p>
                  </div>
                )}

                {selectedApp.message && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Message</label>
                    <p className="whitespace-pre-wrap bg-muted p-3 rounded-md text-sm">
                      {selectedApp.message}
                    </p>
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium text-muted-foreground">Status</label>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className={STATUS_COLORS[selectedApp.status]}>
                      {STATUS_LABELS[selectedApp.status]}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Submitted: {formatDate(selectedApp.created_at)}
                    </span>
                  </div>
                </div>

                {selectedApp.notes && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Notes</label>
                    <p className="text-sm">{selectedApp.notes}</p>
                  </div>
                )}

                {selectedApp.profile_id ? (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Linked Profile</label>
                    <p className="text-sm font-mono">{selectedApp.profile_id}</p>
                  </div>
                ) : null}
              </div>
            )}

            <DialogFooter className="flex gap-2">
              <div className="flex-1 flex gap-2">
                {selectedApp?.status === 'new' && (
                  <Button
                    variant="outline"
                    onClick={() => updateApplicationStatus(selectedApp.id, 'reviewed')}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Mark Reviewed
                  </Button>
                )}
                {selectedApp?.status !== 'contacted' && selectedApp?.status !== 'converted' && (
                  <Button
                    variant="outline"
                    onClick={() => updateApplicationStatus(selectedApp.id, 'contacted')}
                  >
                    <Phone className="h-4 w-4 mr-2" />
                    Mark Contacted
                  </Button>
                )}
                {selectedApp?.status !== 'converted' && !selectedApp?.profile_id && (
                  <Button
                    variant="default"
                    onClick={() => {
                      const ok = window.confirm(
                        'Convert this application to a profile?\n\nThis creates (or links) a real client profile, adds the applicant email for login access, and marks the application converted.',
                      );
                      if (!ok) return;
                      updateApplicationStatus(selectedApp.id, 'converted');
                    }}
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    Convert to Profile
                  </Button>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  onClick={() => {
                    const ok = window.confirm(
                      'Delete the matching profile for this application?\n\nThis is intended for test data cleanup. This cannot be undone.',
                    )
                    if (!ok) return
                    deleteProfileForApplication(selectedApp.id)
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Profile
                </Button>

                {selectedApp?.status !== 'archived' && (
                  <Button
                    variant="ghost"
                    onClick={() => updateApplicationStatus(selectedApp.id, 'archived')}
                  >
                    Archive
                  </Button>
                )}

                <Button
                  variant="outline"
                  onClick={() => {
                    const ok = window.confirm('Delete this application entry?')
                    if (!ok) return
                    deleteApplication(selectedApp.id)
                  }}
                >
                  Delete Entry
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
