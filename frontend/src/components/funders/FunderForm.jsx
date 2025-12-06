import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function FunderForm({ funder, onClose }) {
  const [formData, setFormData] = useState({
    name: funder?.name || '',
    funder_type: funder?.funder_type || 'foundation',
    website: funder?.website || '',
    email: funder?.email || '',
    phone: funder?.phone || '',
    address: funder?.address || '',
    city: funder?.city || '',
    state: funder?.state || '',
    zip: funder?.zip || '',
    contact_person: funder?.contact_person || '',
    contact_title: funder?.contact_title || '',
    mission: funder?.mission || '',
    focus_areas: funder?.focus_areas || '',
    geographic_scope: funder?.geographic_scope || '',
    typical_award_min: funder?.typical_award_min || '',
    typical_award_max: funder?.typical_award_max || '',
    application_preferences: funder?.application_preferences || '',
    submission_portal: funder?.submission_portal || '',
    deadline_frequency: funder?.deadline_frequency || 'rolling',
    next_deadline: funder?.next_deadline || '',
    relationship_strength: funder?.relationship_strength || 'none',
    notes: funder?.notes || ''
  });

  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (funder?.id) {
        return await base44.entities.Funder.update(funder.id, data);
      } else {
        return await base44.entities.Funder.create(data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['funders'] });
      toast.success(funder ? 'Funder updated' : 'Funder created');
      onClose();
    },
    onError: () => {
      toast.error('Failed to save funder');
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    const dataToSave = { ...formData };
    if (dataToSave.typical_award_min) dataToSave.typical_award_min = Number(dataToSave.typical_award_min);
    if (dataToSave.typical_award_max) dataToSave.typical_award_max = Number(dataToSave.typical_award_max);
    saveMutation.mutate(dataToSave);
  };

  return (
    <div>
      <div className="mb-6">
        <Button variant="ghost" onClick={onClose} className="gap-2 mb-4">
          <ArrowLeft className="w-4 h-4" />
          Back to Funders
        </Button>
        <h1 className="text-3xl font-bold text-slate-900">
          {funder ? 'Edit Funder' : 'Add New Funder'}
        </h1>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Funder Name *</label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  required
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Type</label>
                  <Select value={formData.funder_type} onValueChange={(value) => setFormData({...formData, funder_type: value})}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="foundation">Foundation</SelectItem>
                      <SelectItem value="government">Government</SelectItem>
                      <SelectItem value="corporate">Corporate</SelectItem>
                      <SelectItem value="individual">Individual</SelectItem>
                      <SelectItem value="nonprofit">Nonprofit</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Relationship Strength</label>
                  <Select value={formData.relationship_strength} onValueChange={(value) => setFormData({...formData, relationship_strength: value})}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="initial_contact">Initial Contact</SelectItem>
                      <SelectItem value="developing">Developing</SelectItem>
                      <SelectItem value="established">Established</SelectItem>
                      <SelectItem value="strong">Strong</SelectItem>
                      <SelectItem value="very_strong">Very Strong</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Mission Statement</label>
                <Textarea
                  value={formData.mission}
                  onChange={(e) => setFormData({...formData, mission: e.target.value})}
                  rows={3}
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Focus Areas</label>
                <Input
                  value={formData.focus_areas}
                  onChange={(e) => setFormData({...formData, focus_areas: e.target.value})}
                  placeholder="Education, Health, Environment..."
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Contact Person</label>
                  <Input
                    value={formData.contact_person}
                    onChange={(e) => setFormData({...formData, contact_person: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Title</label>
                  <Input
                    value={formData.contact_title}
                    onChange={(e) => setFormData({...formData, contact_title: e.target.value})}
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Email</label>
                  <Input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({...formData, email: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Phone</label>
                  <Input
                    value={formData.phone}
                    onChange={(e) => setFormData({...formData, phone: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Website</label>
                <Input
                  value={formData.website}
                  onChange={(e) => setFormData({...formData, website: e.target.value})}
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Address</label>
                <Input
                  value={formData.address}
                  onChange={(e) => setFormData({...formData, address: e.target.value})}
                />
              </div>

              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">City</label>
                  <Input
                    value={formData.city}
                    onChange={(e) => setFormData({...formData, city: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">State</label>
                  <Input
                    value={formData.state}
                    onChange={(e) => setFormData({...formData, state: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">ZIP</label>
                  <Input
                    value={formData.zip}
                    onChange={(e) => setFormData({...formData, zip: e.target.value})}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Funding Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Typical Award Min</label>
                  <Input
                    type="number"
                    value={formData.typical_award_min}
                    onChange={(e) => setFormData({...formData, typical_award_min: e.target.value})}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Typical Award Max</label>
                  <Input
                    type="number"
                    value={formData.typical_award_max}
                    onChange={(e) => setFormData({...formData, typical_award_max: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Geographic Scope</label>
                <Input
                  value={formData.geographic_scope}
                  onChange={(e) => setFormData({...formData, geographic_scope: e.target.value})}
                  placeholder="e.g., National, California only, Northeast US..."
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Deadline Frequency</label>
                  <Select value={formData.deadline_frequency} onValueChange={(value) => setFormData({...formData, deadline_frequency: value})}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rolling">Rolling</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="annual">Annual</SelectItem>
                      <SelectItem value="biannual">Biannual</SelectItem>
                      <SelectItem value="one-time">One-time</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Next Deadline</label>
                  <Input
                    type="date"
                    value={formData.next_deadline}
                    onChange={(e) => setFormData({...formData, next_deadline: e.target.value})}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Application Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Submission Portal</label>
                <Input
                  value={formData.submission_portal}
                  onChange={(e) => setFormData({...formData, submission_portal: e.target.value})}
                  placeholder="URL to submission portal"
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Application Preferences</label>
                <Textarea
                  value={formData.application_preferences}
                  onChange={(e) => setFormData({...formData, application_preferences: e.target.value})}
                  placeholder="Preferred methods, formats, requirements..."
                  rows={3}
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Notes</label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({...formData, notes: e.target.value})}
                  rows={4}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Funder
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}