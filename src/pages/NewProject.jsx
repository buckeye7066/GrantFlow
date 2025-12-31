import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ArrowLeft } from 'lucide-react';
import { createPageUrl } from '@/utils';

export default function NewProject() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    organization_id: '',
    project_name: '',
    pricing_model: 'hourly',
    hourly_rate: 125,
    fixed_fee_amount: 5000,
    status: 'quoted',
    scope_of_work: ''
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
  });
  
  const { data: billingSettings } = useQuery({
      queryKey: ['billingAccount'],
      queryFn: () => base44.entities.BillingAccount.list().then(res => res[0]),
  });

  React.useEffect(() => {
    if (billingSettings?.default_hourly_rate) {
      setFormData(prev => ({...prev, hourly_rate: billingSettings.default_hourly_rate}));
    }
  }, [billingSettings]);

  const mutation = useMutation({
    mutationFn: (newProject) => base44.entities.Project.create(newProject),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(createPageUrl('Billing'));
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    mutation.mutate(formData);
  };

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto">
      <Button variant="ghost" onClick={() => navigate(createPageUrl('Billing'))} className="mb-6">
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Billing
      </Button>
      <Card className="shadow-lg border-0">
        <CardHeader>
          <CardTitle>Create New Project</CardTitle>
          <CardDescription>Define a new scope of work for a client.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="organization">Client Organization</Label>
              <Select
                onValueChange={value => setFormData({...formData, organization_id: value})}
                required
              >
                <SelectTrigger id="organization" disabled={isLoadingOrgs}>
                  <SelectValue placeholder="Select a client..." />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project_name">Project Name</Label>
              <Input
                id="project_name"
                value={formData.project_name}
                onChange={e => setFormData({...formData, project_name: e.target.value})}
                placeholder="e.g., Federal Comprehensive Grant Proposal"
                required
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="pricing_model">Pricing Model</Label>
              <Select
                value={formData.pricing_model}
                onValueChange={value => setFormData({...formData, pricing_model: value})}
              >
                <SelectTrigger id="pricing_model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="fixed_fee">Fixed Fee</SelectItem>
                  <SelectItem value="retainer">Monthly Retainer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.pricing_model === 'hourly' && (
              <div className="space-y-2">
                <Label htmlFor="hourly_rate">Hourly Rate ($)</Label>
                <Input
                  id="hourly_rate"
                  type="number"
                  value={formData.hourly_rate}
                  onChange={e => setFormData({...formData, hourly_rate: parseFloat(e.target.value) || 0})}
                />
              </div>
            )}

            {formData.pricing_model === 'fixed_fee' && (
              <div className="space-y-2">
                <Label htmlFor="fixed_fee_amount">Fixed Fee Amount ($)</Label>
                <Input
                  id="fixed_fee_amount"
                  type="number"
                  value={formData.fixed_fee_amount}
                  onChange={e => setFormData({...formData, fixed_fee_amount: parseFloat(e.target.value) || 0})}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="scope">Scope of Work</Label>
              <Textarea
                id="scope"
                value={formData.scope_of_work}
                onChange={e => setFormData({...formData, scope_of_work: e.target.value})}
                placeholder="Describe the deliverables, timeline, and key activities for this project."
                className="h-32"
              />
            </div>
            
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => navigate(createPageUrl('Billing'))}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</> : 'Create Project'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}