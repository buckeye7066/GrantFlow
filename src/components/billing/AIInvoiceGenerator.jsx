import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Wand, Check, X, Pencil } from 'lucide-react';

export default function AIInvoiceGenerator({ organizationId, projectId, onApprove, onCancel }) {
  const [proposedItems, setProposedItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const { data: activities } = useQuery({
    queryKey: ['activitiesForBilling', organizationId, projectId],
    queryFn: async () => {
      // Validate input parameters to prevent injection and unexpected behavior.
      if (!organizationId || (typeof organizationId !== 'string' && typeof organizationId !== 'number')) {
        throw new Error('Invalid organizationId provided.');
      }
      // Pull recent real project activity, then let the LLM draft invoice lines from it.
      const grants = await client.entities.Grant.list(`-updated_date`, 10, { organization_id: organizationId, project_id: projectId });
      const docs = await client.entities.Document.list(`-updated_date`, 10, { organization_id: organizationId, project_id: projectId });
      return { grants, docs };
    },
    enabled: !!organizationId,
  });

  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);
    setProposedItems([]);

    const grants = activities?.grants ?? [];
    const docs = activities?.docs ?? [];

    if (grants.length === 0 && docs.length === 0) {
      setError('No recent activity found. Please ensure grants or documents exist for this project before generating invoice items.');
      setIsLoading(false);
      return;
    }

    const grantsText = grants.map(g => `- Grant "${g.title ?? 'Untitled'}" status changed to ${g.status ?? 'unknown'} on ${g.updated_date ? new Date(g.updated_date).toLocaleDateString() : 'unknown date'}`).join('\n');
    const docsText = docs.map(d => `- Uploaded "${d.title ?? 'Untitled'}" (${d.document_type ?? 'unknown type'}) on ${d.created_date ? new Date(d.created_date).toLocaleDateString() : 'unknown date'}`).join('\n');

    if (!grantsText.trim() && !docsText.trim()) {
      setError('Unable to build an activity summary from recent project activity. Please try again or add items manually.');
      setIsLoading(false);
      return;
    }

    const activitySummary = `
      Recent Grant Updates:
      ${grantsText}

      Recent Document Uploads:
      ${docsText}
    `;
    
    const prompt = `You are an expert grant writer's billing assistant. Based on the following recent activity for a client, generate a list of billable line items for an invoice.
    Assume a standard hourly rate. Be concise and professional.
    
    Recent Activity:
    ${activitySummary}

    Based on this, propose 2-4 distinct billable line items. For each item, provide a professional description, estimate the hours (e.g., 0.5, 1.0, 2.5), and a suggested hourly rate. For example, reviewing and updating a grant could be 1.5 hours. Uploading and organizing documents could be 0.5 hours.`;

    try {
      const result = await client.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            line_items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  hours: { type: "number" },
                  rate: { type: "number" }
                },
                required: ["description", "hours"]
              }
            }
          }
        }
      });
      const lineItems = Array.isArray(result?.line_items) ? result.line_items : [];
      if (lineItems.length === 0) {
        setError('AI did not return any line items. Try again or add items manually.');
      } else {
        setProposedItems(lineItems.map(item => ({
  ...item,
  rate: item.rate ?? 0,
  rateIsEstimated: item.rate === null,
  isEditing: item.rate === null, // auto-open edit mode when rate is missing so user must confirm
})));
      }
    } catch (err) {
      setError("Failed to generate suggestions. Please try again or add items manually.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleItemChange = (index, field, value) => {
    setProposedItems(prev => {
      const newItems = [...prev];
      newItems[index] = { ...newItems[index], [field]: value };
      return newItems;
    });
  };
  
  const toggleEdit = (index) => {
    setProposedItems(prev => {
      const newItems = [...prev];
      newItems[index] = { ...newItems[index], isEditing: !newItems[index].isEditing };
      return newItems;
    });
  };

  const handleApproveAll = () => {
    if (typeof onApprove !== 'function') {
      console.error('[AIInvoiceGenerator] onApprove prop is not a function; cannot submit invoice items.');
      return;
    }
    const itemsToSubmit = proposedItems.map(({ isEditing, ...rest }) => rest);
    onApprove(itemsToSubmit);
  };
  
  const handleRemoveItem = (index) => {
    setProposedItems(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <Card className="shadow-lg border-0 bg-slate-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wand className="text-blue-600" />
          AI Invoice Assistant
        </CardTitle>
        <CardDescription>
          Let AI draft billable line items based on recent project activity. Review and approve before adding to the invoice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {proposedItems.length === 0 && !isLoading && (
          <div className="text-center py-8">
            <Button onClick={handleGenerate} disabled={!activities}>
              <Wand className="w-4 h-4 mr-2"/>
              Generate Draft Line Items
            </Button>
          </div>
        )}
        
        {isLoading && (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            <p className="ml-4 text-slate-600">Analyzing recent activity...</p>
          </div>
        )}

        {error && <p className="text-red-600 text-center">{error}</p>}

        {proposedItems.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-semibold">Proposed Line Items</h3>
            {proposedItems.map((item, index) => (
              <div key={index} className="p-3 bg-white rounded-lg border flex flex-col md:flex-row items-center gap-3">
                <div className="flex-1 w-full">
                  {item.isEditing ? (
                    <Input
                      value={item.description}
                      onChange={(e) => handleItemChange(index, 'description', e.target.value)}
                      className="text-sm"
                    />
                  ) : (
                    <p className="text-sm text-slate-800">{item.description}</p>
                  )}
                </div>
                <div className="flex w-full md:w-auto items-center gap-3">
                  <div className="w-20">
                     <Label className="text-xs text-slate-500">Hours</Label>
                     <Input
                        type="number"
                        step="0.1"
                        value={item.hours}
                        onChange={(e) => {
  const parsed = parseFloat(e.target.value);
  const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 999)) : 0;
  handleItemChange(index, 'hours', clamped);
}}
                        className="h-8"
                      />
                  </div>
                   <div className="w-20">
                     <Label className="text-xs text-slate-500">Rate</Label>
                     <Input
                        type="number"
                        step="1"
                        value={item.rate}
                        onChange={(e) => handleItemChange(index, 'rate', parseFloat(e.target.value) || 0)}
                        className="h-8"
                        placeholder="Rate"
                      />
                  </div>
                  <div className="flex items-center gap-1 self-end">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-500 hover:text-slate-800" onClick={() => toggleEdit(index)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-700" onClick={() => handleRemoveItem(index)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
             <div className="flex justify-end gap-3 pt-4">
              <Button variant="outline" onClick={() => { if (typeof onCancel === 'function') onCancel(); }}>Cancel</Button>
              <Button onClick={handleApproveAll} className="bg-blue-600 hover:bg-blue-700">
                <Check className="w-4 h-4 mr-2" />
                Add {proposedItems.length} Items to Invoice
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
