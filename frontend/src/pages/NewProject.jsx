import React, { useState, useCallback, useRef, useEffect } from 'react';
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
import { useToast } from '@/components/ui/use-toast';

export default function NewProject() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    organization_id: '',           // string for <Select>
    project_name: '',
    pricing_model: 'hourly',
    hourly_rate: 125,
    fixed_fee_amount: 5000,
    status: 'quoted',
    scope_of_work: ''
  });

  const appliedDefaultRate = useRef(false);

  // Current user
  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Orgs (remove unsupported sort args)
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Organization.list()
        : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  // Billing account (list -> client-side sort desc)
  const { data: billingSettings } = useQuery({
    queryKey: ['billingAccount'],
    queryFn: async () => {
      const accounts = await base44.entities.BillingAccount.list();
      if (!Array.isArray(accounts)) return null;
      const sorted = [...accounts].sort((a, b) => {
        const ad = new Date(a.created_at ?? a.created_date ?? 0).getTime();
        const bd = new Date(b.created_at ?? b.created_date ?? 0).getTime();
        return bd - ad; // newest first
      });
      return sorted[0] ?? null;
    },
  });

  // Apply default hourly rate once
  useEffect(() => {
    if (billingSettings?.default_hourly_rate && !appliedDefaultRate.current) {
      setFormData(prev => ({ ...prev, hourly_rate: Number(billingSettings.default_hourly_rate) || prev.hourly_rate }));
      appliedDefaultRate.current = true;
    }
  }, [billingSettings]);

  // Field updater
  const updateField = useCallback(
    (field) => (value) => {
      setFormData(prev => ({ ...prev, [field]: value }));
    },
    []
  );

  const mutation = useMutation({
    mutationFn: (newProject) => base44.entities.Project.create(newProject),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', user?.email, isAdmin] });
      toast({ title: "Project Created", description: "Your project has been successfully created." });
      navigate(createPageUrl('Billing'));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Unknown error occurred";
      toast({ variant: "destructive", title: "Failed to Create Project", description: message });
    }
  });

  const validateForm = () => {
    if (!formData.organization_id) {
      toast({ variant: "destructive", title: "Invalid Input", description: "Please select a client organization." });
      return false;
    }
    if (!formData.project_name.trim()) {
      toast({ variant: "destructive", title: "Invalid Input", description: "Please enter a project name." });
      return false;
    }
    if (formData.pricing_model === 'hourly' && (!formData.hourly_rate || formData.hourly_rate <= 0)) {
      toast({ variant: "destructive", title: "Invalid Input", description: "Hourly rate must be greater than 0." });
      return false;
    }
    if ((formData.pricing_model === 'fixed_fee' || formData.pricing_model === 'retainer') &&
        (!formData.fixed_fee_amount || formData.fixed_fee_amount <= 0)) {
      toast({
        variant: "destructive",
        title: "Invalid Input",
        description: formData.pricing_model === 'retainer'
          ? "Please enter a monthly retainer amount."
          : "Fixed fee amount must be greater than 0.",
      });
      return false;
    }
    return true;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validateForm()) return;
    mutation.mutate(formData);
  };

  // Safe number parsing (keeps 0 if empty/NaN)
  const parseMoney = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
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
                value={String(formData.organization_id)}
                onValueChange={updateField('organization_id')}
                disabled={isLoadingOrgs || organizations.length === 0}
                required
              >
                <SelectTrigger id="organization">
                  <SelectValue placeholder="Select a client..." />
                </SelectTrigger>
                <SelectContent>
                  {organizations.length === 0 ? (
                    <SelectItem value="no-orgs" disabled>
                      No organizations found
                    </SelectItem>
                  ) : (
                    organizations.map((org) => (
                      <SelectItem key={org.id} value={String(org.id)}>
                        {org.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project_name">Project Name</Label>
              <Input
                id="project_name"
                value={formData.project_name}
                onChange={e => updateField('project_name')(e.target.value)}
                placeholder="e.g., Federal Comprehensive Grant Proposal"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pricing_model">Pricing Model</Label>
              <Select
                value={formData.pricing_model}
                onValueChange={updateField('pricing_model')}
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
                  min="0"
                  step="0.01"
                  value={formData.hourly_rate}
                  onChange={e => updateField('hourly_rate')(parseMoney(e.target.value))}
                />
              </div>
            )}

            {(formData.pricing_model === 'fixed_fee' || formData.pricing_model === 'retainer') && (
              <div className="space-y-2">
                <Label htmlFor="fixed_fee_amount">
                  {formData.pricing_model === 'retainer' ? 'Monthly Retainer Amount ($)' : 'Fixed Fee Amount ($)'}
                </Label>
                <Input
                  id="fixed_fee_amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.fixed_fee_amount}
                  onChange={e => updateField('fixed_fee_amount')(parseMoney(e.target.value))}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="scope">Scope of Work</Label>
              <Textarea
                id="scope"
                value={formData.scope_of_work}
                onChange={e => updateField('scope_of_work')(e.target.value)}
                placeholder="Describe the deliverables, timeline, and key activities for this project."
                className="h-32"
              />
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => navigate(createPageUrl('Billing'))}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...
                  </>
                ) : (
                  'Create Project'
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}