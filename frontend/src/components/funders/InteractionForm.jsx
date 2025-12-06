import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Save, X } from 'lucide-react';
import { toast } from 'sonner';

export default function InteractionForm({ funderId, funderName, onClose }) {
  const [formData, setFormData] = useState({
    interaction_type: 'email',
    interaction_date: new Date().toISOString().split('T')[0],
    contact_person: '',
    subject: '',
    summary: '',
    outcome: '',
    follow_up_needed: false,
    follow_up_date: ''
  });

  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.FunderInteraction.create({
        funder_id: funderId,
        ...data
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interactions', funderId] });
      toast.success('Interaction logged');
      onClose();
    },
    onError: () => {
      toast.error('Failed to log interaction');
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    saveMutation.mutate(formData);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Log Interaction with {funderName}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Interaction Type *</label>
              <Select value={formData.interaction_type} onValueChange={(value) => setFormData({...formData, interaction_type: value})}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="phone">Phone Call</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="site_visit">Site Visit</SelectItem>
                  <SelectItem value="conference">Conference</SelectItem>
                  <SelectItem value="letter">Letter</SelectItem>
                  <SelectItem value="proposal_submission">Proposal Submission</SelectItem>
                  <SelectItem value="award_notification">Award Notification</SelectItem>
                  <SelectItem value="rejection">Rejection</SelectItem>
                  <SelectItem value="follow_up">Follow-up</SelectItem>
                  <SelectItem value="report_submission">Report Submission</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Date *</label>
              <Input
                type="date"
                value={formData.interaction_date}
                onChange={(e) => setFormData({...formData, interaction_date: e.target.value})}
                required
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Subject *</label>
            <Input
              value={formData.subject}
              onChange={(e) => setFormData({...formData, subject: e.target.value})}
              required
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Contact Person</label>
            <Input
              value={formData.contact_person}
              onChange={(e) => setFormData({...formData, contact_person: e.target.value})}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Summary</label>
            <Textarea
              value={formData.summary}
              onChange={(e) => setFormData({...formData, summary: e.target.value})}
              rows={3}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Outcome / Next Steps</label>
            <Textarea
              value={formData.outcome}
              onChange={(e) => setFormData({...formData, outcome: e.target.value})}
              rows={2}
            />
          </div>

          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded">
            <Checkbox
              checked={formData.follow_up_needed}
              onCheckedChange={(checked) => setFormData({...formData, follow_up_needed: checked})}
            />
            <label className="text-sm font-medium">Follow-up needed</label>
          </div>

          {formData.follow_up_needed && (
            <div>
              <label className="text-sm font-medium mb-2 block">Follow-up Date</label>
              <Input
                type="date"
                value={formData.follow_up_date}
                onChange={(e) => setFormData({...formData, follow_up_date: e.target.value})}
              />
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? 'Saving...' : 'Log Interaction'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}