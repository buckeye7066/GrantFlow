import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for saving parsed grant to pipeline and triggering analysis
 * @param {Object} extractedData - Extracted grant data
 * @param {string} selectedOrgId - Organization ID
 * @param {string} sourceUrl - Original URL if from URL mode
 */
export function useSaveParsedGrant(extractedData, selectedOrgId, sourceUrl = '') {
  const [isSaving, setIsSaving] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Helpers
  const safeTrim = (v) => (typeof v === 'string' ? v.trim() : '');
  const normalizeUrl = (raw) => {
    const s = safeTrim(raw);
    if (!s) return '';
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try {
      const u = new URL(withProto);
      if (!['http:', 'https:'].includes(u.protocol)) return '';
      return u.toString();
    } catch {
      return '';
    }
  };
  const normalizeDate = (raw) => {
    const s = safeTrim(raw);
    if (!s) return '';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const toNumber = (raw) => {
    if (raw == null) return undefined;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };

  const saveGrant = useCallback(async () => {
    // Basic guards
    if (!selectedOrgId) {
      toast({
        variant: 'destructive',
        title: 'Missing profile',
        description: 'Please select a profile before saving the grant.',
      });
      return;
    }
    if (!extractedData || typeof extractedData !== 'object') {
      toast({
        variant: 'destructive',
        title: 'No data',
        description: 'Nothing to save – the extracted data is missing.',
      });
      return;
    }

    setIsSaving(true);

    // Normalize inputs
    const normalizedUrl = normalizeUrl(sourceUrl || extractedData.url || extractedData.application_url);
    const normalizedDeadline = normalizeDate(extractedData.deadline);
    const title = safeTrim(extractedData.title) || 'Untitled Grant';
    const funder = safeTrim(extractedData.funder || extractedData.agency) || 'Unknown Funder';
    const program_description = safeTrim(extractedData.program_description);
    const award_floor = toNumber(extractedData.award_floor);
    const award_ceiling = toNumber(extractedData.award_ceiling);

    // Fast duplicate check (by URL if available; else by signature fields)
    try {
      const dedupeFilterByUrl = normalizedUrl
        ? { organization_id: selectedOrgId, url: normalizedUrl }
        : null;

      let existing = [];
      if (dedupeFilterByUrl) {
        existing = await base44.entities.Grant.filter(dedupeFilterByUrl);
      } else {
        // fallback heuristic: title + funder + deadline within same org
        const allOrg = await base44.entities.Grant.filter({ organization_id: selectedOrgId });
        existing = (allOrg || []).filter((g) => {
          const tMatch = safeTrim(g.title).toLowerCase() === title.toLowerCase();
          const fMatch = safeTrim(g.funder).toLowerCase() === funder.toLowerCase();
          const dMatch =
            (g.deadline ? String(g.deadline) : '') === normalizedDeadline ||
            (!g.deadline && !normalizedDeadline);
          return tMatch && fMatch && dMatch;
        });
      }

      if (existing && existing.length > 0) {
        const first = existing[0];
        toast({
          title: 'Already saved',
          description: 'This opportunity is already in your pipeline. Opening it instead.',
        });
        navigate(createPageUrl(`GrantDetail?id=${first.id}`));
        setIsSaving(false);
        return;
      }
    } catch (e) {
      // Non-fatal: continue saving
      console.warn('[useSaveParsedGrant] Dedupe check failed:', e);
    }

    // Build payload (per-profile isolation: include profile_id)
    const grantPayload = {
      organization_id: selectedOrgId,
      profile_id: selectedOrgId, // isolation guard
      title: title.slice(0, 300),
      funder: funder.slice(0, 300),
      status: 'discovered',
    };

    if (normalizedUrl) grantPayload.url = normalizedUrl;
    if (program_description) grantPayload.program_description = program_description;
    if (normalizedDeadline) grantPayload.deadline = normalizedDeadline;
    if (award_floor !== undefined) grantPayload.award_floor = award_floor;
    if (award_ceiling !== undefined) grantPayload.award_ceiling = award_ceiling;

    console.log('[useSaveParsedGrant] Grant payload:', grantPayload);

    try {
      // Create grant
      const newGrant = await base44.entities.Grant.create(grantPayload);

      // Queue AI analysis
      try {
        await base44.functions.invoke('analyzeGrant', {
          body: {
            grant_id: newGrant.id,
            organization_id: selectedOrgId,
          }
        });
      } catch (analysisErr) {
        console.warn('[useSaveParsedGrant] Analysis failed but grant was saved:', analysisErr);
      }

      // Invalidate caches precisely
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      queryClient.invalidateQueries({ queryKey: ['grants', selectedOrgId] });
      queryClient.invalidateQueries({ queryKey: ['organization', selectedOrgId] });
      queryClient.invalidateQueries({ queryKey: ['grant', newGrant.id] });

      toast({
        title: 'Saved and analyzing',
        description: `Grant "${newGrant.title}" created and sent for AI analysis.`,
      });

      navigate(createPageUrl(`GrantDetail?id=${newGrant.id}`));
    } catch (err) {
      console.error('[useSaveParsedGrant] Save failed:', err);

      let errorMessage = 'Failed to save grant';
      if (err?.response?.data) {
        const rd = err.response.data;
        if (typeof rd === 'string') errorMessage = rd;
        else if (rd.message) errorMessage = rd.message;
        else if (rd.error) errorMessage = typeof rd.error === 'string' ? rd.error : JSON.stringify(rd.error);
        else if (rd.details) errorMessage = typeof rd.details === 'string' ? rd.details : JSON.stringify(rd.details);
        else errorMessage = JSON.stringify(rd);
      } else if (err?.message) {
        errorMessage = err.message;
      }

      toast({
        title: 'Error',
        description: `Failed to save grant: ${errorMessage}`,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }, [extractedData, selectedOrgId, sourceUrl, queryClient, navigate, toast]);

  return {
    saveGrant,
    isSaving,
  };
}