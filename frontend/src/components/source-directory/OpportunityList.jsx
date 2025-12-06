import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText, ExternalLink, Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { isOpportunityInPipeline } from '@/components/shared/sourceDirectoryUtils';

/**
 * List of opportunities from an expanded source
 */
export default function OpportunityList({ 
  source, 
  opportunities, 
  isLoading, 
  allGrants, 
  selectedOrgId 
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleAddToPipeline = async (opp) => {
    // Check for duplicates
    if (opp.url) {
      const existingGrants = await base44.entities.Grant.filter({
        organization_id: selectedOrgId,
        url: opp.url
      });
      
      if (existingGrants.length > 0) {
        toast({
          title: 'Already in Pipeline',
          description: `"${opp.title}" is already in your pipeline.`,
        });
        queryClient.invalidateQueries({ queryKey: ['grants'] });
        return;
      }
    }
    
    const grantData = {
      organization_id: selectedOrgId,
      title: opp.title,
      funder: opp.sponsor,
      url: opp.url,
      deadline: opp.deadlineAt,
      award_floor: opp.awardMin,
      award_ceiling: opp.awardMax,
      eligibility_summary: opp.eligibilityBullets?.join('\n'),
      program_description: opp.descriptionMd,
      status: 'discovered',
    };
    
    await base44.entities.Grant.create(grantData);
    queryClient.invalidateQueries({ queryKey: ['grants'] });
    
    toast({
      title: 'Added to Pipeline',
      description: `${opp.title} has been added to your pipeline`,
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" />
        <p>No opportunities found from this source yet</p>
        <p className="text-xs mt-1">Try crawling this source to discover opportunities</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="font-semibold text-slate-900 mb-3">
        Opportunities from {source.name} ({opportunities.length})
      </h4>
      <div className="grid gap-2">
        {opportunities.map((opp) => {
          const inPipeline = isOpportunityInPipeline(opp.url, allGrants, selectedOrgId);
          const grant = allGrants.find(g => g.url === opp.url && g.organization_id === selectedOrgId);
          
          return (
            <div
              key={opp.id}
              className="flex items-center justify-between p-3 bg-white rounded-lg border hover:border-blue-300 transition-colors"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h5 className="font-medium text-slate-900">{opp.title}</h5>
                  {inPipeline && (
                    <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      In Pipeline
                    </Badge>
                  )}
                </div>
                {opp.awardMax && (
                  <p className="text-sm text-emerald-600 font-semibold">
                    ${opp.awardMax.toLocaleString()}
                  </p>
                )}
                {opp.deadlineAt && !opp.rolling && (
                  <p className="text-xs text-slate-500">
                    Deadline: {new Date(opp.deadlineAt).toLocaleDateString()}
                  </p>
                )}
                {opp.rolling && (
                  <p className="text-xs text-blue-600">Rolling deadline</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {opp.url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(opp.url, '_blank')}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                )}
                {inPipeline && grant ? (
                  <Link to={createPageUrl(`GrantDetail?id=${grant.id}`)}>
                    <Button size="sm" variant="outline">
                      <FileText className="w-4 h-4 mr-2" />
                      View in Pipeline
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleAddToPipeline(opp)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add to Pipeline
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}