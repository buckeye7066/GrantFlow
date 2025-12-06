import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export function useProfileMutations(organizationId) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();

  // Helper to log billable time for automated work
  const logAutomatedTime = async (organizationId, taskCategory, minutes, note) => {
    try {
      const user = await base44.auth.me();
      const now = new Date();
      const startTime = new Date(now.getTime() - (minutes * 60 * 1000));
      
      await base44.entities.TimeEntry.create({
        organization_id: organizationId,
        user_id: user.id,
        task_category: taskCategory,
        start_at: startTime.toISOString(),
        end_at: now.toISOString(),
        raw_minutes: minutes,
        rounded_minutes: minutes,
        note: note,
        source: 'auto',
        invoiced: false
      });
      
      console.log('[Billing] Logged automated time:', { taskCategory, minutes, note });
    } catch (error) {
      console.error('[Billing] Failed to log time:', error);
    }
  };

  // AUTOMATED WORKFLOW: Run after profile creation
  const runAutomatedOnboarding = async (newOrg) => {
    console.log('[Automation] Starting onboarding for:', newOrg.name);
    const startTime = Date.now();
    
    try {
      // STEP 1: Discover local sources (6 min billable)
      toast({
        title: '🤖 Automation Running',
        description: 'Discovering local funding sources...',
        duration: 3000,
      });
      
      await base44.functions.invoke('discoverLocalSources', {
        profile_id: newOrg.id
      });
      
      await logAutomatedTime(newOrg.id, 'Discovery', 6, 'Automated source discovery on profile creation');
      
      // STEP 2: Run comprehensive search (12 min billable)
      toast({
        title: '🔍 Searching Opportunities',
        description: 'AI is analyzing 1000+ funding sources...',
        duration: 3000,
      });
      
      const searchResponse = await base44.functions.invoke('comprehensiveMatch', {
        profile_id: newOrg.id,
        states: newOrg.state ? [newOrg.state] : [],
        freshness_days: 60
      });
      
      await logAutomatedTime(newOrg.id, 'Research', 12, 'Automated comprehensive opportunity search');
      
      // STEP 3: Auto-add top 5 matches to pipeline (18 min billable)
      if (searchResponse.data?.success && searchResponse.data?.opportunities?.length > 0) {
        const topMatches = searchResponse.data.opportunities
          .sort((a, b) => (b.match || 0) - (a.match || 0))
          .slice(0, 5);
        
        toast({
          title: '➕ Adding Top Matches',
          description: `Adding ${topMatches.length} best opportunities to pipeline...`,
          duration: 3000,
        });
        
        let addedCount = 0;
        
        // SEQUENTIAL grant creation - one at a time to prevent 502 errors
        for (const opp of topMatches) {
          try {
            const grantData = {
              organization_id: newOrg.id,
              organization_created_by: newOrg.created_by,
              title: opp.title || 'Untitled',
              funder: opp.sponsor || 'Unknown',
              url: opp.url || '',
              deadline: opp.deadlineAt || opp.deadline || null,
              program_description: opp.descriptionMd || '',
              status: 'discovered',
            };
            
            const newGrant = await base44.entities.Grant.create(grantData);
            addedCount++;
            
            // NOTE: Removed background AI analysis - will be triggered by background job
            // This prevents parallel mutations that cause 502 errors
            
          } catch (error) {
            console.error('[Automation] Failed to add grant (skipping):', error);
          }
        }
        
        if (addedCount > 0) {
          await logAutomatedTime(newOrg.id, 'Analysis', 18, `Automated pipeline setup - added ${addedCount} grants`);
          
          toast({
            title: '✅ Automation Complete!',
            description: `Added ${addedCount} opportunities to pipeline.`,
            duration: 8000,
          });
        }
      }
      
    } catch (error) {
      console.error('[Automation] Onboarding failed:', error);
      toast({
        title: '⚠️ Partial Automation',
        description: 'Profile created, but automated search encountered an issue. You can manually discover grants.',
      });
    }
  };

  // FIXED: Create mutation with automation
  const createMutation = useMutation({
    mutationFn: async (data) => {
      console.log('[useProfileMutations] Creating organization:', data?.name);
      
      if (!data || !data.name) {
        throw new Error('Organization name is required');
      }

      const startTime = Date.now();
      
      try {
        const newOrg = await base44.entities.Organization.create(data);
        console.log('[useProfileMutations] Organization created:', newOrg?.id);
        
        // Log initial profile creation time (6 min)
        await logAutomatedTime(newOrg.id, 'Setup', 6, 'Profile creation and initial setup');
        
        // Trigger automated onboarding in background
        setTimeout(() => runAutomatedOnboarding(newOrg), 1000);
        
        return newOrg;
      } catch (error) {
        console.error('[useProfileMutations] Create failed:', error);
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      
      toast({
        title: '✅ Profile Created',
        description: `"${data.name}" created. Automated discovery starting...`,
        duration: 5000,
      });
    },
    onError: (error) => {
      console.error('[useProfileMutations] Create error:', error);
      
      const errorMsg = error?.message || error?.error || 'Failed to create profile';
      
      toast({
        variant: 'destructive',
        title: 'Creation Failed',
        description: errorMsg,
      });
    }
  });

  // FIXED: Update mutation with retry logic and save verification
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      console.log('[useProfileMutations] Updating organization:', id, 'with data:', data);
      
      if (!id) {
        throw new Error('Organization ID is required');
      }
      
      if (!data || Object.keys(data).length === 0) {
        throw new Error('No data provided for update');
      }

      // CRITICAL: Sanitize all fields - handle empty strings and type conversions
      const numericFields = [
        'hpsa_score', 'crs_score', 'percent_ami', 'distance_to_services', 'broadband_speed',
        'gpa', 'act_score', 'sat_score', 'community_service_hours', 'annual_budget', 'staff_count',
        'indirect_rate', 'age', 'household_income', 'household_size', 'cancer_diagnosis_year',
        'years_in_ministry', 'va_disability_percent', 'frpl_percentage', 'gre_score', 'gmat_score',
        'lsat_score', 'mcat_score', 'single_audit_year', 'indirect_cost_rate', 'insurance_gl_limits',
        'endowment_size', 'research_expenditures', 'member_count', 'stewardship_acres',
        'msi_designation_year', 'farmer_acreage', 'nicra_rate', 'liability_coverage',
        'planned_enrollment_year', 'years_in_office'
      ];
      
      // String fields that should be removed if empty (not sent as empty string)
      const stringFields = [
        'email', 'phone', 'website', 'address', 'city', 'state', 'zip', 'ein', 'uei', 'cage_code',
        'ssn', 'green_card_number', 'medicaid_number', 'tenncare_id', 'ruca_code',
        'mission', 'goals', 'unique_story', 'funding_need', 'challenges_barriers', 'support_system',
        'primary_goal', 'target_population', 'geographic_focus', 'funding_amount_needed', 'timeline',
        'past_experience', 'unique_qualities', 'collaboration_partners', 'sustainability_plan', 'barriers_faced',
        'special_circumstances', 'current_college', 'intended_major', 'tribal_affiliation',
        'religious_affiliation', 'religious_denomination', 'military_branch', 'character_of_discharge',
        'organization_type', 'nonprofit_type', 'ntee_code', 'evidence_based_program',
        'sba_size_standard', 'size_standard_status', 'idea_disability_category', 'cte_pathway',
        'efc_sai_band', 'housing_status', 'support_needs_level', 'rare_disease_type',
        'primary_diagnosis', 'denominational_affiliation', 'clergy_credential_level',
        'pastoral_assignment_type', 'hunting_license_state', 'public_office_held',
        'political_party_affiliation', 'party_leadership_position', 'civic_engagement_level'
      ];
      
      const sanitizedData = { ...data };
      
      // Sanitize string fields - remove empty strings
      for (const field of stringFields) {
        if (field in sanitizedData) {
          const val = sanitizedData[field];
          if (val === '' || val === null || val === undefined) {
            delete sanitizedData[field];
          } else if (typeof val !== 'string') {
            sanitizedData[field] = String(val); // Convert to string if needed
          }
        }
      }
      
      // Sanitize numeric fields
      for (const field of numericFields) {
        if (field in sanitizedData) {
          const val = sanitizedData[field];
          if (val === '' || val === null || val === undefined) {
            delete sanitizedData[field];
          } else if (typeof val === 'string') {
            const parsed = parseFloat(val);
            if (Number.isFinite(parsed)) {
              sanitizedData[field] = parsed;
            } else {
              delete sanitizedData[field];
            }
          }
        }
      }

      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          console.log('[useProfileMutations] 🔄 Calling base44.entities.Organization.update...');
          console.log('[useProfileMutations] Update payload:', { id, data: sanitizedData });
          console.log('[useProfileMutations] Data keys:', Object.keys(sanitizedData));
          
          const updated = await base44.entities.Organization.update(id, sanitizedData);
          
          console.log('[useProfileMutations] ✅ Organization updated successfully!');
          console.log('[useProfileMutations] Full returned object:', JSON.stringify(updated, null, 2));
          console.log('[useProfileMutations] Updated keywords specifically:', updated.keywords);
          console.log('[useProfileMutations] Updated focus_areas specifically:', updated.focus_areas);
          
          // SAVE VERIFICATION: Compare sent vs received (optimized)
          const mismatches = [];
          const dataKeys = Object.keys(sanitizedData);
          
          for (const key of dataKeys) {
            const serverValue = updated[key];
            const sentValue = sanitizedData[key];
            
            // Fast primitive check first
            if (serverValue === sentValue) continue;
            
            // Deep compare only when needed
            const matches = JSON.stringify(serverValue) === JSON.stringify(sentValue);
            
            if (!matches) {
              mismatches.push({ field: key, sent: sentValue, received: serverValue });
              console.log(`[useProfileMutations] 🔍 Field "${key}": ❌ MISMATCH`, {
                sent: sentValue,
                received: serverValue
              });
            }
          }
          
          if (mismatches.length > 0) {
            console.warn('[useProfileMutations] ⚠️ SAVE VERIFICATION - Some fields differ (may be expected for computed/normalized values):');
            mismatches.forEach(m => console.warn(`  - ${m.field}: sent=${JSON.stringify(m.sent)}, received=${JSON.stringify(m.received)}`));
          } else {
            console.log('[useProfileMutations] ✅ Save verification passed - all fields match');
          }
          
          // Log update time (3 min)
          await logAutomatedTime(id, 'Updates', 3, 'Profile data update');
          
          return updated;
        } catch (error) {
          console.error(`[useProfileMutations] ❌ Update attempt ${retryCount + 1} failed`);
          console.error(`[useProfileMutations] Error type:`, error?.constructor?.name);
          console.error(`[useProfileMutations] Error message:`, error?.message);
          console.error(`[useProfileMutations] Error response status:`, error?.response?.status);
          console.error(`[useProfileMutations] Error response data:`, error?.response?.data);
          console.error(`[useProfileMutations] Full error:`, error);
          
          if (retryCount >= maxRetries - 1) {
            console.error(`[useProfileMutations] ❌ Max retries reached, throwing error`);
            throw error;
          }
          
          retryCount++;
          console.log(`[useProfileMutations] 🔄 Retry ${retryCount}/${maxRetries} - waiting ${500 * retryCount}ms`);
          await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
        }
      }
    },
    onSuccess: async (data) => {
        console.log('[useProfileMutations] ✅ Update mutation onSuccess triggered for org:', organizationId);
        console.log('[useProfileMutations] Returned data from server:', JSON.stringify(data, null, 2));

        // Invalidate all organization-related queries using prefix matching
        await queryClient.invalidateQueries({ queryKey: ['organizations'] });
        
        // Invalidate using predicate to catch ALL queries starting with 'organization' regardless of extra params
        await queryClient.invalidateQueries({ 
          predicate: (query) => {
            const key = query.queryKey;
            if (!Array.isArray(key)) return false;
            // Match 'organization' (singular) queries for this specific org
            if (key[0] === 'organization' && key[1] === organizationId) return true;
            // Match 'organizations' (plural) list queries
            if (key[0] === 'organizations') return true;
            return false;
          }
        });

        // Force refetch immediately
        await queryClient.refetchQueries({ 
          predicate: (query) => {
            const key = query.queryKey;
            if (!Array.isArray(key)) return false;
            return key[0] === 'organization' && key[1] === organizationId;
          }
        });

        toast({
          title: '✅ Profile Updated',
          description: `"${data?.name || 'Profile'}" has been updated successfully.`,
        });
      },
    onError: (error) => {
      console.error('[useProfileMutations] ❌ Update error caught in onError');
      console.error('[useProfileMutations] Error object:', error);
      console.error('[useProfileMutations] Error message:', error?.message);
      console.error('[useProfileMutations] Error response:', error?.response);
      console.error('[useProfileMutations] Error response data:', error?.response?.data);
      console.error('[useProfileMutations] Full error JSON:', JSON.stringify(error, null, 2));
      
      const errorMsg = error?.response?.data?.message || error?.response?.data?.error || error?.message || error?.error || 'Failed to update profile';
      
      toast({
        variant: 'destructive',
        title: '❌ Update Failed',
        description: errorMsg,
        duration: 10000,
      });
    }
  });

  // FIXED: Delete mutation with better error handling
  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      console.log('[useProfileMutations] Deleting organization:', id);
      
      if (!id) {
        throw new Error('Organization ID is required');
      }

      try {
        // First delete related entities to prevent orphaned records
        const [grants, documents, contacts, timeEntries] = await Promise.all([
          base44.entities.Grant.filter({ organization_id: id }).catch(() => []),
          base44.entities.Document.filter({ organization_id: id }).catch(() => []),
          base44.entities.ContactMethod.filter({ organization_id: id }).catch(() => []),
          base44.entities.TimeEntry.filter({ organization_id: id }).catch(() => []),
        ]);
        
        // Delete related records
        const deletePromises = [];
        for (const grant of grants) {
          deletePromises.push(base44.entities.Grant.delete(grant.id).catch(e => console.warn('Grant delete failed:', e)));
        }
        for (const doc of documents) {
          deletePromises.push(base44.entities.Document.delete(doc.id).catch(e => console.warn('Doc delete failed:', e)));
        }
        for (const contact of contacts) {
          deletePromises.push(base44.entities.ContactMethod.delete(contact.id).catch(e => console.warn('Contact delete failed:', e)));
        }
        for (const entry of timeEntries) {
          deletePromises.push(base44.entities.TimeEntry.delete(entry.id).catch(e => console.warn('TimeEntry delete failed:', e)));
        }
        
        await Promise.all(deletePromises);
        
        // Now delete the organization
        await base44.entities.Organization.delete(id);
        console.log('[useProfileMutations] Organization deleted:', id);
      } catch (error) {
        console.error('[useProfileMutations] Delete failed:', error);
        
        // Check if organization doesn't exist (already deleted)
        const errorMsg = error?.message || error?.response?.data?.error || '';
        if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
          console.log('[useProfileMutations] Organization already deleted or not found');
          return; // Treat as success - it's already gone
        }
        
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      
      toast({
        title: '✅ Profile Deleted',
        description: 'The profile has been permanently deleted.',
      });
      
      // Navigate back to list
      navigate(createPageUrl('Organizations'));
    },
    onError: (error) => {
      console.error('[useProfileMutations] Delete error:', error);
      
      const errorMsg = error?.message || error?.error || 'Failed to delete profile';
      
      // If not found, still navigate away
      if (errorMsg.includes('not found')) {
        navigate(createPageUrl('Organizations'));
        return;
      }
      
      toast({
        variant: 'destructive',
        title: 'Deletion Failed',
        description: errorMsg,
      });
    }
  });

  // Find picture mutation
  const findPictureMutation = useMutation({
    mutationFn: async ({ id, name, website }) => {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Find a high-quality profile picture URL for: ${name}. Website: ${website}. Return ONLY a direct image URL.`,
        add_context_from_internet: true
      });
      
      const imageUrl = typeof response === 'string' ? response.trim() : response?.url || response?.image_url;
      
      if (imageUrl && imageUrl.startsWith('http')) {
        await base44.entities.Organization.update(id, {
          profile_image_url: imageUrl
        });
        return imageUrl;
      }
      
      throw new Error('No valid image URL found');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
      toast({
        title: '✅ Picture Updated',
        description: 'Profile picture has been updated.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Picture Search Failed',
        description: error?.message || 'Could not find a suitable picture.',
      });
    }
  });

  // Grant update mutation
  const grantUpdateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Grant.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    }
  });

  // Grant delete mutation
  const grantDeleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Grant.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: 'Grant Removed',
        description: 'The grant has been removed from the pipeline.',
      });
    }
  });

  return {
    // Mutations
    createMutation,
    updateMutation,
    deleteMutation,
    
    // Wrapper functions for cleaner API
    updateOrganization: (id, data) => {
      console.log('[useProfileMutations] 📤 updateOrganization wrapper called');
      console.log('[useProfileMutations] ID:', id);
      console.log('[useProfileMutations] Data:', JSON.stringify(data));
      console.log('[useProfileMutations] Data keys:', Object.keys(data || {}));
      
      if (!id) {
        console.error('[useProfileMutations] ❌ No ID provided!');
        return;
      }
      if (!data || Object.keys(data).length === 0) {
        console.error('[useProfileMutations] ❌ No data provided!');
        return;
      }
      
      console.log('[useProfileMutations] ✅ Calling mutate...');
      updateMutation.mutate({ id, data });
    },
    deleteOrganization: (id) => {
      deleteMutation.mutate(id);
    },
    findPicture: (id, name, website) => findPictureMutation.mutate({ id, name, website }),
    updateGrant: (id, data) => grantUpdateMutation.mutate({ id, data }),
    deleteGrant: (id) => grantDeleteMutation.mutate(id),
    
    // Loading states
    isUpdatingOrg: updateMutation.isPending,
    isDeletingOrg: deleteMutation.isPending,
    isFindingPicture: findPictureMutation.isPending,
  };
}