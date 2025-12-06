import React, { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

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

const formatSourceTypeLabel = (type) =>
  type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Normalize to a valid http(s) URL. Adds https:// if missing.
 * Throws on invalid/non-http(s).
 */
function normalizeHttpUrl(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withProto);
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('URL must start with http:// or https://');
  }
  return u.toString();
}

export default function AddSourceForm({ source, onSuccess, onCancel }) {
  const defaultValues = useMemo(() => source || {
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
  }, [source]);

  const { register, handleSubmit, control, formState: { errors } } = useForm({
    defaultValues
  });

  const { toast } = useToast();
  const [lastError, setLastError] = useState(null);

  const mutation = useMutation({
    mutationFn: async (data) => {
      // Harden payload: trim strings, normalize state/zip, normalize URLs
      const trimmed = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      );

      // State -> uppercase 2 letters if present
      if (trimmed.state) trimmed.state = trimmed.state.toUpperCase().slice(0, 2);

      // ZIP -> strip whitespace
      if (trimmed.zip) trimmed.zip = trimmed.zip.replace(/\s+/g, '');

      // URLs
      try {
        trimmed.website_url = normalizeHttpUrl(trimmed.website_url);
      } catch (e) {
        throw new Error(e?.message || 'Invalid Website URL');
      }
      if (trimmed.scholarship_page_url) {
        try {
          trimmed.scholarship_page_url = normalizeHttpUrl(trimmed.scholarship_page_url);
        } catch (e) {
          throw new Error(e?.message || 'Invalid Scholarship/Grant Page URL');
        }
      }

      // Active default
      if (typeof trimmed.active !== 'boolean') trimmed.active = true;

      if (source?.id) {
        return base44.entities.SourceDirectory.update(source.id, trimmed);
      } else {
        return base44.entities.SourceDirectory.create(trimmed);
      }
    },
    onSuccess: (result) => {
      setLastError(null);
      if (onSuccess) onSuccess(result);
      toast({ title: source?.id ? 'Source Updated' : 'Source Added' });
    },
    onError: (error) => {
      const msg = error?.message || 'Failed to save source';
      setLastError(msg);
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: msg
      });
    }
  });

  const onSubmit = (raw) => {
    setLastError(null);
    mutation.mutate(raw);
  };

  // Inline validators that defer heavy checks to mutation for single error path
  const validateUrlField = (value) => {
    if (!value) return 'Website URL is required';
    try {
      normalizeHttpUrl(value);
      return true;
    } catch {
      return 'URL must start with http:// or https://';
    }
  };

  const scholarshipUrlValidate = (value) => {
    if (!value) return true;
    try {
      normalizeHttpUrl(value);
      return true;
    } catch {
      return 'URL must start with http:// or https://';
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="source-name">Source Name *</Label>
          <Input
            id="source-name"
            {...register("name", { required: "Source name is required" })}
            placeholder="e.g., Lee University"
          />
          {errors.name && <p className="text-red-500 text-xs">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-parent-organization">Parent Organization</Label>
          <Input
            id="source-parent-organization"
            {...register("parent_organization")}
            placeholder="e.g., Lions Clubs International"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="source-type">Source Type *</Label>
        <Controller
          name="source_type"
          control={control}
          rules={{ required: "Source type is required" }}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value}>
              <SelectTrigger id="source-type">
                <SelectValue placeholder="Select a source type..." />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {sourceTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {formatSourceTypeLabel(type)}
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
          <Label htmlFor="source-website-url">Website URL *</Label>
          <Input
            id="source-website-url"
            type="url"
            {...register("website_url", {
              required: "Website URL is required",
              validate: validateUrlField
            })}
            placeholder="https://example.edu"
          />
          {errors.website_url && <p className="text-red-500 text-xs">{errors.website_url.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-scholarship-page-url">Scholarship/Grant Page URL</Label>
          <Input
            id="source-scholarship-page-url"
            type="url"
            {...register("scholarship_page_url", { validate: scholarshipUrlValidate })}
            placeholder="https://example.edu/scholarships"
          />
          {errors.scholarship_page_url && <p className="text-red-500 text-xs">{errors.scholarship_page_url.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="source-city">City</Label>
          <Input id="source-city" {...register("city")} placeholder="Cleveland" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-state">State</Label>
          <Input id="source-state" {...register("state")} placeholder="TN" maxLength={2} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-zip">ZIP Code</Label>
          <Input id="source-zip" {...register("zip")} placeholder="37311" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="source-crawl-frequency">Crawl Frequency</Label>
          <Controller
            name="crawl_frequency"
            control={control}
            render={({ field }) => (
              <Select onValueChange={field.onChange} value={field.value}>
                <SelectTrigger id="source-crawl-frequency">
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
          <Label htmlFor="source-contact-email">Contact Email</Label>
          <Input
            id="source-contact-email"
            type="email"
            {...register("contact_email")}
            placeholder="scholarships@example.edu"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="source-notes">Notes</Label>
        <Textarea
          id="source-notes"
          {...register("notes")}
          placeholder="Additional information about this source..."
          rows={3}
        />
      </div>

      <div className="flex items-center gap-2">
        <Controller
          name="active"
          control={control}
          render={({ field }) => (
            <Checkbox
              id="source-active"
              checked={!!field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
        <Label htmlFor="source-active" className="cursor-pointer">Active (include in crawls)</Label>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {source?.id ? 'Update Source' : 'Add Source'}
        </Button>
      </div>

      {/* Screen-reader only error for accessibility */}
      {lastError && <p className="sr-only" aria-live="polite">{lastError}</p>}
    </form>
  );
}