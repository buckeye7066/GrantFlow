import React, { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Wand, Check, X, Pencil, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AIInvoiceGenerator({ organizationId, projectId, onApprove, onCancel }) {
  const [proposedItems, setProposedItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [validationError, setValidationError] = useState(null);

  const { data: activities } = useQuery({
    queryKey: ['activitiesForBilling', organizationId, projectId],
    queryFn: async () => {
      const grants = await base44.entities.Grant.list(`-updated_date`, 10, { organization_id: organizationId });
      const docs = await base44.entities.Document.list(`-updated_date`, 10, { organization_id: organizationId });
      return { grants, docs };
    },
    enabled: !!organizationId,
  });

  const activitySummary = useMemo(() => {
    if (!activities) return '';
    
    return `
      Recent Grant Updates:
      ${activities.grants.map(g => `- Grant "${g.title}" status changed to ${g.status} on ${new Date(g.updated_date).toLocaleDateString()}`).join('\n')}

      Recent Document Uploads:
      ${activities.docs.map(d => `- Uploaded "${d.title}" (${d.document_type}) on ${new Date(d.created_date).toLocaleDateString()}`).join('\n')}
    `;
  }, [activities]);

  const totalCost = useMemo(() => {
    return proposedItems.reduce((sum, item) => {
      const hours = parseFloat(item.hours) || 0;
      const rate = parseFloat(item.rate) || 0;
      return sum + (hours * rate);
    }, 0);
  }, [proposedItems]);

  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);
    setValidationError(null);
    setProposedItems([]);
    
    const prompt = `You are an expert grant writer's billing assistant. Based on the following recent activity for a client, generate a list of billable line items for an invoice.
    Assume a standard hourly rate. Be concise and professional.
    
    Recent Activity:
    ${activitySummary}

    Based on this, propose 2-4 distinct billable line items. For each item, provide a professional description, estimate the hours (e.g., 0.5, 1.0, 2.5), and a suggested hourly rate. For example, reviewing and updating a grant could be 1.5 hours. Uploading and organizing documents could be 0.5 hours.`;

    try {
      const result = await base44.integrations.Core.InvokeLLM({
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
      setProposedItems(result.line_items.map(item => ({...item, isEditing: false })));
    } catch (err) {
      setError("Failed to generate suggestions. Please try again or add items manually.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleItemChange = (index, field, value) => {
    const newItems = [...proposedItems];
    newItems[index][field] = value;
    setProposedItems(newItems);
    setValidationError(null);
  };
  
  const toggleEdit = (index) => {
    const newItems = [...proposedItems];
    newItems[index].isEditing = !newItems[index].isEditing;
    setProposedItems(newItems);
  };

  const validateItems = () => {
    for (const item of proposedItems) {
      if (!item.description || item.description.trim() === '') {
        return 'All items must have a description.';
      }
      const hours = parseFloat(item.hours);
      if (isNaN(hours) || hours <= 0) {
        return 'All items must have hours greater than 0.';
      }
    }
    return null;
  };

  const handleApproveAll = () => {
    const validationErrorMsg = validateItems();
    if (validationErrorMsg) {
      setValidationError(validationErrorMsg);
      return;
    }
    setValidationError(null);
    onApprove(proposedItems);
  };
  
  const handleRemoveItem = (index) => {
    setProposedItems(proposedItems.filter((_, i) => i !== index));
    setValidationError(null);
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
            <div className="flex justify-between items-center">
              <h3 className="font-semibold">Proposed Line Items</h3>
              <div className="text-right">
                <p className="text-sm text-slate-500">Estimated Total</p>
                <p className="text-xl font-bold text-slate-900">${totalCost.toFixed(2)}</p>
              </div>
            </div>

            {validationError && (
              <Alert variant="destructive" className="mb-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{validationError}</AlertDescription>
              </Alert>
            )}

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
                        onChange={(e) => handleItemChange(index, 'hours', parseFloat(e.target.value) || 0)}
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
                    {!item.isEditing && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-500 hover:text-slate-800" onClick={() => toggleEdit(index)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-700" onClick={() => handleRemoveItem(index)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
             <div className="flex justify-end gap-3 pt-4">
              <Button variant="outline" onClick={onCancel}>Cancel</Button>
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