import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tags, Sparkles, Loader2 } from 'lucide-react';
import EditableTagList from '@/components/shared/EditableTagList';
import { useToast } from '@/components/ui/use-toast';

export default function KeywordsSection({ organization, isUpdating, onUpdate }) {
  const safeOrg = organization || {};
  const safeOnUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
  
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  const handleSuggestKeywords = async () => {
    setIsGenerating(true);
    try {
      const contextInfo = `
Profile: ${safeOrg.name || 'Unknown'}
Type: ${safeOrg.applicant_type || 'Unknown'}
${safeOrg.mission ? `Mission: ${safeOrg.mission}` : ''}
${safeOrg.primary_goal ? `Goal: ${safeOrg.primary_goal}` : ''}
${safeOrg.target_population ? `Population: ${safeOrg.target_population}` : ''}
${safeOrg.intended_major ? `Major: ${safeOrg.intended_major}` : ''}
`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Based on the following profile, suggest 8-12 relevant keywords for funding matching. Return ONLY JSON: {"keywords": ["keyword1", ...]}

PROFILE:
${contextInfo}`,
        response_json_schema: {
          type: "object",
          properties: { keywords: { type: "array", items: { type: "string" } } },
          required: ["keywords"]
        }
      });

      if (response?.keywords?.length > 0) {
        safeOnUpdate('keywords', response.keywords);
        toast({ title: '✨ Keywords Generated', description: `Added ${response.keywords.length} keywords` });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'AI Generation Failed', description: error?.message || 'Could not generate keywords.' });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Tags className="w-5 h-5 text-blue-600" />
            Keywords
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSuggestKeywords}
            disabled={isGenerating || isUpdating}
            className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
          >
            {isGenerating ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
            ) : (
              <><Sparkles className="w-4 h-4 mr-2" />Suggest with AI</>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <EditableTagList
          tags={safeOrg.keywords || []}
          onUpdate={(newTags) => safeOnUpdate('keywords', newTags)}
          placeholder="Type keywords (e.g., education, healthcare, community service)..."
          disabled={isUpdating}
        />
        <p className="text-xs text-slate-500 mt-2">
          Keywords help match you with relevant funding opportunities
        </p>
      </CardContent>
    </Card>
  );
}