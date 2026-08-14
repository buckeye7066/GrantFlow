import React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import client from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { createLogger } from '@/utils/logger'

const sourceTypes = [
  "university",
  "community_college",
  "service_club_lions",
  "service_club_rotary",
  "service_club_kiwanis",
  "service_club_elks",
  "masonic_lodge",
  "masonic_shrine",
  "masonic_scottish_rite",
  "masonic_york_rite",
  "vfw_post",
  "american_legion",
  "community_foundation",
  "corporate_csr",
  "hospital_system",
  "credit_union",
  "utility_company",
  "professional_association",
  "labor_union",
  "faith_based",
  "tribal",
  "city_government",
  "county_government",
  "state_agency",
  "federal_agency",
  "hoa",
  "neighborhood_association",
  "other"
];

const crawlFrequencies = ["daily", "weekly", "monthly", "quarterly", "annually"];

export default function AddSourceForm({ source, organizationId, onSuccess, onCancel }) {
  const log = React.useMemo(() => createLogger('AddSourceForm'), [])
  const { register, handleSubmit, control, formState: { errors }, setValue, watch } = useForm({
    defaultValues: source || {
      name: '',
      parent_organization: '',
      source_type: 'university',
      website_url: '',
      scholarship_page_url: '',
      city: '',
      state: '',
      zip: '',
      crawl_frequency: 'monthly',
      active: true,
      notes: ''
    }
  });

  const mutation = useMutation({
    mutationFn: async (data) => {
      // FIXED: Check if source has an ID to determine create vs update
      if (source && source.id !== null && source.id !== undefined) {
        log.debug('updating source', { id: source.id })
        return client.entities.SourceDirectory.update(source.id, data);
      } else {
        log.debug('creating new source')
        const orgId = organizationId ?? data.discovered_for_organization_id ?? null
        if (!orgId) {
          throw new Error('Missing organization for source directory entry')
        }
        return client.entities.SourceDirectory.create({
          ...data,
          discovered_for_organization_id: orgId,
        });
      }
    },
    onSuccess: (result) => {
      log.debug('save success')
      if (onSuccess) onSuccess(result);
    },
    onError: (error) => {
      console.error('[AddSourceForm] Error:', error);
      alert(`Failed to ${source && source.id ? 'update' : 'add'} source: ${error.message}`);
    }
  });

  const onSubmit = (data) => {
    log.debug('submitting')
    mutation.mutate(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">Source Name *</Label>
          <Input 
            id="name" 
            {...register("name", { required: "Source name is required" })} 
            placeholder="e.g., Lee University"
          />
          {errors.name && <p className="text-red-500 text-xs">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="parent_organization">Parent Organization</Label>
          <Input 
            id="parent_organization" 
            {...register("parent_organization")} 
            placeholder="e.g., Lions Clubs International"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="source_type">Source Type *</Label>
        <Controller
          name="source_type"
          control={control}
          rules={{ required: "Source type is required" }}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value}>
              <SelectTrigger>
                <SelectValue placeholder="Select a source type..." />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {sourceTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {type.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.source_type && <p className="text-red-500 text-xs">{errors.source_type.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="website_url">Website URL *</Label>
          <Input 
            id="website_url" 
            type="url" 
            {...register("website_url", { required: "Website URL is required" })} 
            placeholder="https://example.edu"
          />
          {errors.website_url && <p className="text-red-500 text-xs">{errors.website_url.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="scholarship_page_url">Scholarship/Grant Page URL</Label>
          <Input 
            id="scholarship_page_url" 
            type="url" 
            {...register("scholarship_page_url")} 
            placeholder="https://example.edu/scholarships"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input id="city" {...register("city")} placeholder="Cleveland" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="state">State</Label>
          <Input id="state" {...register("state")} placeholder="TN" maxLength={2} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="zip">ZIP Code</Label>
          <Input id="zip" {...register("zip")} placeholder="37311" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="crawl_frequency">Crawl Frequency</Label>
          <Controller
            name="crawl_frequency"
            control={control}
            render={({ field }) => (
              <Select onValueChange={field.onChange} value={field.value}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {crawlFrequencies.map(freq => (
                    <SelectItem key={freq} value={freq}>
                      {freq.charAt(0).toUpperCase() + freq.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="contact_email">Contact Email</Label>
          <Input 
            id="contact_email" 
            type="email" 
            {...register("contact_email")} 
            placeholder="scholarships@example.edu"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea 
          id="notes" 
          {...register("notes")} 
          placeholder="Additional information about this source..."
          rows={3}
        />
      </div>

      <div className="flex items-center gap-2">
        <input 
          type="checkbox" 
          id="active" 
          {...register("active")} 
          className="w-4 h-4"
        />
        <Label htmlFor="active" className="cursor-pointer">Active (include in crawls)</Label>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {source && source.id ? 'Update Source' : 'Add Source'}
        </Button>
      </div>
    </form>
  );
}