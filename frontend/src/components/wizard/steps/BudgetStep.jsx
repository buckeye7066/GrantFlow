import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, DollarSign, Sparkles, Loader2, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Budget Step - Detailed budget breakdown
 */
export default function BudgetStep({ data, onChange, organization, grant }) {
  const [generatingSection, setGeneratingSection] = useState(null);
  const [generatingItems, setGeneratingItems] = useState(false);
  const { toast } = useToast();

  const handleChange = (field, value) => {
    onChange({ [field]: value });
  };

  const generateBudgetItems = async () => {
    if (!organization) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Organization information is required to generate budget suggestions.',
      });
      return;
    }

    // Check for any project narrative data
    const narrativeData = [
      data.project_narrative,
      data.problem_statement,
      data.project_goals,
      data.methods,
      data.outcomes
    ].filter(Boolean).join('\n\n');

    if (!narrativeData) {
      toast({
        variant: 'destructive',
        title: 'Missing Project Information',
        description: 'Please complete at least one section of the project narrative first.',
      });
      return;
    }

    setGeneratingItems(true);
    
    // Use requested amount from form or grant's award ceiling as target budget
    const targetBudget = data.requested_amount || grant?.award_ceiling || 50000;
    
    try {
      const result = await base44.integrations.Core.InvokeLLM({
        prompt: `Based on this project information, suggest 5-7 realistic budget line items with quantities, unit costs, and justifications.

IMPORTANT: The total budget MUST equal approximately $${targetBudget.toLocaleString()}. Distribute costs appropriately across categories to reach this target amount.

Project Details:
${narrativeData}

Organization: ${organization.name}
Target Budget: $${targetBudget.toLocaleString()}

Return a JSON array of budget items with this structure:
{
  "items": [
    {
      "category": "personnel|equipment|supplies|travel|other_direct",
      "line_item": "Brief description",
      "quantity": number,
      "unit_cost": number,
      "justification": "Why this expense is necessary"
    }
  ]
}

Be specific and realistic with costs. Focus on essential project expenses.`,
        response_json_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  line_item: { type: "string" },
                  quantity: { type: "number" },
                  unit_cost: { type: "number" },
                  justification: { type: "string" }
                }
              }
            }
          }
        }
      });

      const newItems = result.items.map((item, idx) => ({
        id: Date.now() + idx,
        category: item.category,
        line_item: item.line_item,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        total: item.quantity * item.unit_cost,
        justification: item.justification
      }));

      onChange({ budget_items: [...budgetItems, ...newItems] });
      
      toast({
        title: '✨ Budget Items Generated',
        description: `Added ${newItems.length} suggested line items. Review and adjust as needed.`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    } finally {
      setGeneratingItems(false);
    }
  };

  const generateBudgetNarrative = async () => {
    if (!organization || budgetItems.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Please add budget items before generating a narrative.',
      });
      return;
    }

    setGeneratingSection('budget_narrative');
    try {
      // Prepare budget summary
      const budgetSummary = budgetItems.map(item => 
        `- ${item.line_item} (${item.category}): $${item.total?.toLocaleString() || 0} - ${item.justification || 'No justification provided'}`
      ).join('\n');

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: `Write a comprehensive budget narrative for this grant application. Explain the overall budget approach, justify major expense categories, and connect costs to project goals.

Project: ${data.project_title || 'Grant Project'}
Organization: ${organization.name}
Total Budget: $${totalBudget.toLocaleString()}

Budget Line Items:
${budgetSummary}

Project Context:
${data.problem_statement || ''}
${data.project_goals || ''}

Write a professional, persuasive budget narrative (300-500 words) that:
1. Provides an overview of the budget approach
2. Justifies major expense categories
3. Explains how costs support project objectives
4. Addresses cost-effectiveness and value
5. Notes any matching funds or in-kind contributions if applicable

Return plain text, no markdown formatting.`,
        add_context_from_internet: false
      });

      handleChange('budget_narrative', result);
      
      toast({
        title: '✨ Budget Narrative Generated',
        description: 'Review and customize as needed.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message,
      });
    } finally {
      setGeneratingSection(null);
    }
  };
  const budgetItems = data.budget_items || [];

  const categories = [
    'personnel',
    'fringe',
    'travel',
    'equipment',
    'supplies',
    'contractual',
    'construction',
    'other_direct',
    'indirect'
  ];

  const addBudgetItem = () => {
    const newItem = {
      id: Date.now(),
      category: 'personnel',
      line_item: '',
      quantity: 1,
      unit_cost: 0,
      total: 0,
      justification: ''
    };
    onChange({ budget_items: [...budgetItems, newItem] });
  };

  const updateBudgetItem = (index, field, value) => {
    const updated = [...budgetItems];
    updated[index][field] = value;
    
    // Auto-calculate total
    if (field === 'quantity' || field === 'unit_cost') {
      const quantity = parseFloat(updated[index].quantity) || 0;
      const unitCost = parseFloat(updated[index].unit_cost) || 0;
      updated[index].total = quantity * unitCost;
    }
    
    onChange({ budget_items: updated });
  };

  const removeBudgetItem = (index) => {
    const updated = budgetItems.filter((_, i) => i !== index);
    onChange({ budget_items: updated });
  };

  const totalBudget = budgetItems.reduce((sum, item) => sum + (parseFloat(item.total) || 0), 0);

  // Group by category for summary
  const categoryTotals = budgetItems.reduce((acc, item) => {
    const cat = item.category || 'other';
    acc[cat] = (acc[cat] || 0) + (parseFloat(item.total) || 0);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Budget Summary */}
      <div className="p-4 bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg border border-blue-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-600">Total Budget</p>
            <p className="text-3xl font-bold text-slate-900">
              ${totalBudget.toLocaleString()}
            </p>
          </div>
          <DollarSign className="w-12 h-12 text-blue-600 opacity-20" />
        </div>
        
        {/* Category Summary */}
        {Object.keys(categoryTotals).length > 0 && (
          <div className="mt-4 pt-4 border-t border-blue-200">
            <p className="text-xs font-semibold text-slate-700 mb-2">By Category:</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(categoryTotals).map(([cat, amount]) => (
                <Badge key={cat} variant="outline" className="capitalize">
                  {cat}: ${amount.toLocaleString()}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Budget Items */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <Label className="text-base font-semibold">Budget Line Items</Label>
          <div className="flex gap-2">
            <Button 
              onClick={generateBudgetItems} 
              size="sm" 
              variant="outline"
              disabled={generatingItems}
            >
              {generatingItems ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  AI Suggestions
                </>
              )}
            </Button>
            <Button onClick={addBudgetItem} size="sm" variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              Add Line Item
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {budgetItems.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-300 rounded-lg">
              <p className="text-slate-500 mb-3">No budget items yet</p>
              <Button onClick={addBudgetItem} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add First Item
              </Button>
            </div>
          ) : (
            budgetItems.map((item, index) => (
              <div key={item.id || index} className="p-4 border border-slate-200 rounded-lg bg-white">
                <div className="grid gap-4">
                  {/* Row 1: Category and Description */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <Label className="text-xs">Category</Label>
                      <Select
                        value={item.category}
                        onValueChange={(value) => updateBudgetItem(index, 'category', value)}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map(cat => (
                            <SelectItem key={cat} value={cat} className="capitalize">
                              {cat.replace(/_/g, ' ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="col-span-2">
                      <Label className="text-xs">Description</Label>
                      <Input
                        value={item.line_item}
                        onChange={(e) => updateBudgetItem(index, 'line_item', e.target.value)}
                        placeholder="e.g., Project Manager (0.5 FTE)"
                        className="mt-1"
                      />
                    </div>
                  </div>

                  {/* Row 2: Quantity, Unit Cost, Total */}
                  <div className="grid grid-cols-4 gap-4">
                    <div>
                      <Label className="text-xs">Quantity</Label>
                      <Input
                        type="number"
                        value={item.quantity}
                        onChange={(e) => updateBudgetItem(index, 'quantity', e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Unit Cost</Label>
                      <Input
                        type="number"
                        value={item.unit_cost}
                        onChange={(e) => updateBudgetItem(index, 'unit_cost', e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Total</Label>
                      <div className="mt-1 px-3 py-2 bg-slate-100 rounded-md font-semibold text-sm">
                        ${(item.total || 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeBudgetItem(index)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Row 3: Justification */}
                  <div>
                    <Label className="text-xs">Justification</Label>
                    <Textarea
                      value={item.justification || ''}
                      onChange={(e) => updateBudgetItem(index, 'justification', e.target.value)}
                      placeholder="Explain why this expense is necessary..."
                      rows={2}
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Budget Narrative */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-base font-semibold">Budget Narrative</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={generateBudgetNarrative}
            disabled={generatingSection === 'budget_narrative' || budgetItems.length === 0}
          >
            {generatingSection === 'budget_narrative' ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                AI Assist
              </>
            )}
          </Button>
        </div>
        <p className="text-xs text-slate-500 mb-2">
          Overall explanation of your budget and cost allocation
        </p>
        <Textarea
          value={data.budget_narrative || ''}
          onChange={(e) => handleChange('budget_narrative', e.target.value)}
          placeholder="Provide an overview of your budget approach and key assumptions..."
          rows={6}
        />
      </div>

      {/* Indirect Costs */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Indirect Cost Rate (%)</Label>
          <Input
            type="number"
            value={data.indirect_rate || organization?.indirect_rate || ''}
            onChange={(e) => handleChange('indirect_rate', e.target.value)}
            placeholder="10"
          />
          <p className="text-xs text-slate-500 mt-1">
            Your organization's approved indirect rate
          </p>
        </div>
        <div>
          <Label>Match/Cost Share Required?</Label>
          <Select
            value={data.match_required || 'no'}
            onValueChange={(value) => handleChange('match_required', value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="no">No</SelectItem>
              <SelectItem value="yes">Yes</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {data.match_required === 'yes' && (
        <div>
          <Label>Match/Cost Share Amount</Label>
          <Input
            type="number"
            value={data.match_amount || ''}
            onChange={(e) => handleChange('match_amount', e.target.value)}
            placeholder="Amount of match or cost share"
          />
        </div>
      )}
    </div>
  );
}