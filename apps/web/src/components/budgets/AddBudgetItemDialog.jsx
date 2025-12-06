import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';

const BUDGET_CATEGORIES = [
  { value: 'personnel', label: 'Personnel' },
  { value: 'fringe', label: 'Fringe Benefits' },
  { value: 'travel', label: 'Travel' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'supplies', label: 'Supplies' },
  { value: 'contractual', label: 'Contractual' },
  { value: 'construction', label: 'Construction' },
  { value: 'other_direct', label: 'Other Direct Costs' },
  { value: 'indirect', label: 'Indirect Costs' }
];

export default function AddBudgetItemDialog({ 
  open, 
  onClose, 
  onSave, 
  item = null,
  workflowStages = [],
  workflowTasks = [],
  isSaving = false
}) {
  const [formData, setFormData] = useState({
    category: 'supplies',
    line_item: '',
    quantity: '',
    unit_cost: '',
    total: '',
    justification: '',
    budget_year: 1,
    workflow_stage_id: '',
    workflow_task_id: '',
    is_committed: false,
    actual_spent: '',
    variance_notes: ''
  });

  // Load item data when editing
  useEffect(() => {
    if (item) {
      setFormData({
        category: item.category || 'supplies',
        line_item: item.line_item || '',
        quantity: item.quantity?.toString() || '',
        unit_cost: item.unit_cost?.toString() || '',
        total: item.total?.toString() || '',
        justification: item.justification || '',
        budget_year: item.budget_year || 1,
        workflow_stage_id: item.workflow_stage_id || '',
        workflow_task_id: item.workflow_task_id || '',
        is_committed: item.is_committed || false,
        actual_spent: item.actual_spent?.toString() || '',
        variance_notes: item.variance_notes || ''
      });
    } else {
      // Reset form when not editing
      setFormData({
        category: 'supplies',
        line_item: '',
        quantity: '',
        unit_cost: '',
        total: '',
        justification: '',
        budget_year: 1,
        workflow_stage_id: '',
        workflow_task_id: '',
        is_committed: false,
        actual_spent: '',
        variance_notes: ''
      });
    }
  }, [item, open]);

  // Auto-calculate total when quantity or unit_cost changes
  useEffect(() => {
    if (formData.quantity && formData.unit_cost) {
      const qty = parseFloat(formData.quantity);
      const cost = parseFloat(formData.unit_cost);
      if (!isNaN(qty) && !isNaN(cost)) {
        setFormData(prev => ({ ...prev, total: (qty * cost).toFixed(2) }));
      }
    }
  }, [formData.quantity, formData.unit_cost]);

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Prepare data for submission
    const submitData = {
      category: formData.category,
      line_item: formData.line_item.trim(),
      quantity: formData.quantity ? parseFloat(formData.quantity) : undefined,
      unit_cost: formData.unit_cost ? parseFloat(formData.unit_cost) : undefined,
      total: parseFloat(formData.total),
      justification: formData.justification.trim() || undefined,
      budget_year: parseInt(formData.budget_year),
      workflow_stage_id: formData.workflow_stage_id || undefined,
      workflow_task_id: formData.workflow_task_id || undefined,
      is_committed: formData.is_committed,
      actual_spent: formData.actual_spent ? parseFloat(formData.actual_spent) : 0,
      variance_notes: formData.variance_notes.trim() || undefined
    };
    
    onSave(submitData);
  };

  // Filter tasks by selected stage
  const filteredTasks = formData.workflow_stage_id
    ? workflowTasks.filter(t => t.stage_id === formData.workflow_stage_id)
    : workflowTasks;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit Budget Item' : 'Add Budget Item'}</DialogTitle>
          <DialogDescription>
            Create a detailed budget line item with optional workflow linking
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {/* Category */}
            <div>
              <Label htmlFor="category">Category *</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUDGET_CATEGORIES.map(cat => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Budget Year */}
            <div>
              <Label htmlFor="budget_year">Budget Year</Label>
              <Input
                id="budget_year"
                type="number"
                min="1"
                value={formData.budget_year}
                onChange={(e) => setFormData({ ...formData, budget_year: e.target.value })}
              />
            </div>
          </div>

          {/* Line Item */}
          <div>
            <Label htmlFor="line_item">Line Item Description *</Label>
            <Input
              id="line_item"
              value={formData.line_item}
              onChange={(e) => setFormData({ ...formData, line_item: e.target.value })}
              placeholder="e.g., Project Manager Salary"
              required
            />
          </div>

          {/* Cost Breakdown */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="quantity">Quantity</Label>
              <Input
                id="quantity"
                type="number"
                step="0.01"
                min="0"
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                placeholder="e.g., 12"
              />
            </div>

            <div>
              <Label htmlFor="unit_cost">Unit Cost ($)</Label>
              <Input
                id="unit_cost"
                type="number"
                step="0.01"
                min="0"
                value={formData.unit_cost}
                onChange={(e) => setFormData({ ...formData, unit_cost: e.target.value })}
                placeholder="e.g., 5000"
              />
            </div>

            <div>
              <Label htmlFor="total">Total Cost ($) *</Label>
              <Input
                id="total"
                type="number"
                step="0.01"
                min="0"
                value={formData.total}
                onChange={(e) => setFormData({ ...formData, total: e.target.value })}
                placeholder="Auto-calculated"
                required
              />
            </div>
          </div>

          {/* Justification */}
          <div>
            <Label htmlFor="justification">Justification</Label>
            <Textarea
              id="justification"
              value={formData.justification}
              onChange={(e) => setFormData({ ...formData, justification: e.target.value })}
              placeholder="Explain why this expense is necessary..."
              className="h-20"
            />
          </div>

          {/* Workflow Linking */}
          <div className="border-t pt-4">
            <h4 className="font-semibold text-sm text-slate-900 mb-3">
              Link to Workflow (Optional)
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="workflow_stage_id">Workflow Stage</Label>
                <Select
                  value={formData.workflow_stage_id}
                  onValueChange={(value) => setFormData({ 
                    ...formData, 
                    workflow_stage_id: value,
                    workflow_task_id: '' // Reset task when stage changes
                  })}
                >
                  <SelectTrigger id="workflow_stage_id">
                    <SelectValue placeholder="Select stage" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>None</SelectItem>
                    {workflowStages.map(stage => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {stage.stage_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="workflow_task_id">Workflow Task</Label>
                <Select
                  value={formData.workflow_task_id}
                  onValueChange={(value) => setFormData({ ...formData, workflow_task_id: value })}
                  disabled={!formData.workflow_stage_id}
                >
                  <SelectTrigger id="workflow_task_id">
                    <SelectValue placeholder="Select task" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>None</SelectItem>
                    {filteredTasks.map(task => (
                      <SelectItem key={task.id} value={task.id}>
                        {task.task_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Tracking */}
          <div className="border-t pt-4">
            <h4 className="font-semibold text-sm text-slate-900 mb-3">
              Expense Tracking
            </h4>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="is_committed"
                  checked={formData.is_committed}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_committed: checked })}
                />
                <Label htmlFor="is_committed" className="cursor-pointer">
                  This is a committed/contracted expense
                </Label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="actual_spent">Actual Spent ($)</Label>
                  <Input
                    id="actual_spent"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.actual_spent}
                    onChange={(e) => setFormData({ ...formData, actual_spent: e.target.value })}
                    placeholder="0.00"
                  />
                </div>

                <div>
                  <Label>Variance</Label>
                  <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-slate-50">
                    {formData.total && formData.actual_spent ? (
                      <span className={`font-semibold ${
                        parseFloat(formData.total) - parseFloat(formData.actual_spent) < 0
                          ? 'text-red-600'
                          : 'text-emerald-600'
                      }`}>
                        ${Math.abs(parseFloat(formData.total) - parseFloat(formData.actual_spent)).toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-slate-400">$0.00</span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <Label htmlFor="variance_notes">Variance Notes</Label>
                <Textarea
                  id="variance_notes"
                  value={formData.variance_notes}
                  onChange={(e) => setFormData({ ...formData, variance_notes: e.target.value })}
                  placeholder="Explain any significant variance..."
                  className="h-16"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                item ? 'Update Item' : 'Add Item'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}