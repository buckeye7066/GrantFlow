import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

/**
 * Dialog for adding a partner using AI to fetch details
 */
export default function AIAddPartnerDialog({ open, onOpenChange, onFound }) {
  const [partnerName, setPartnerName] = useState('');
  const { toast } = useToast();

  const aiAssistMutation = useMutation({
    mutationFn: (name) => base44.integrations.Core.InvokeLLM({
      prompt: `You are a research assistant. Find information about the organization named '${name}'. Return its official website URL, a general public-facing contact email, and classify its organization type from this list: university, utility, foundation, municipality, other.`,
      add_context_from_internet: true,
      response_json_schema: {
        type: 'object',
        properties: {
          org_type: { type: 'string', enum: ['university', 'utility', 'foundation', 'municipality', 'other'] },
          api_base_url: { type: 'string', description: 'The main official website URL.' },
          contact_email: { type: 'string', description: 'A general contact email, like contact@ or info@.' }
        }
      }
    }),
    onSuccess: (data) => {
      const newPartnerData = {
        name: partnerName,
        org_type: data.org_type || 'other',
        api_base_url: data.api_base_url || '',
        contact_email: data.contact_email || '',
        auth_type: 'none',
        status: 'inactive',
      };
      onFound(newPartnerData);
      onOpenChange(false);
      setPartnerName('');
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'AI Assistant Failed',
        description: `Could not find information. Please add manually. Error: ${error.message}`,
      });
    }
  });

  const handleFind = () => {
    if (!partnerName) return;
    aiAssistMutation.mutate(partnerName);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-500" />
            Add Partner with AI
          </DialogTitle>
          <DialogDescription>
            Enter the name of the organization, and the AI will try to find its details.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="ai-partner-name">Partner Name</Label>
            <Input
              id="ai-partner-name"
              value={partnerName}
              onChange={(e) => setPartnerName(e.target.value)}
              placeholder="e.g., Ford Foundation"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && partnerName && !aiAssistMutation.isPending) {
                  handleFind();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleFind} 
            disabled={aiAssistMutation.isPending || !partnerName}
          >
            {aiAssistMutation.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Find & Pre-fill Form
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}