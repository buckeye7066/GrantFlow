import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Edit2, Trash2, Link2, CheckCircle2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const CATEGORY_LABELS = {
  personnel: 'Personnel',
  fringe: 'Fringe Benefits',
  travel: 'Travel',
  equipment: 'Equipment',
  supplies: 'Supplies',
  contractual: 'Contractual',
  construction: 'Construction',
  other_direct: 'Other Direct Costs',
  indirect: 'Indirect Costs'
};

export default function BudgetItemsList({ 
  items = [], 
  workflowStages = [],
  workflowTasks = [],
  onEdit, 
  onDelete 
}) {
  // Group items by category
  const groupedItems = items.reduce((acc, item) => {
    if (!acc[item.category]) {
      acc[item.category] = [];
    }
    acc[item.category].push(item);
    return acc;
  }, {});

  // Get stage/task name by ID
  const getStageName = (stageId) => {
    const stage = workflowStages.find(s => s.id === stageId);
    return stage?.stage_name || '';
  };

  const getTaskName = (taskId) => {
    const task = workflowTasks.find(t => t.id === taskId);
    return task?.task_name || '';
  };

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <p className="text-lg font-medium mb-2">No budget items yet</p>
        <p className="text-sm">Click "Add Budget Item" to create your first line item</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Object.entries(groupedItems).map(([category, categoryItems]) => {
        const categoryTotal = categoryItems.reduce((sum, item) => sum + (item.total || 0), 0);
        const categorySpent = categoryItems.reduce((sum, item) => sum + (item.actual_spent || 0), 0);
        
        return (
          <div key={category} className="border rounded-lg overflow-hidden">
            {/* Category Header */}
            <div className="bg-slate-50 border-b px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-slate-900">
                  {CATEGORY_LABELS[category] || category}
                </h3>
                <p className="text-sm text-slate-600">
                  {categoryItems.length} item{categoryItems.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-slate-900">
                  ${categoryTotal.toLocaleString()}
                </p>
                <p className="text-xs text-slate-600">
                  Spent: ${categorySpent.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Category Items Table */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryItems.map(item => {
                  const variance = (item.total || 0) - (item.actual_spent || 0);
                  const hasWorkflowLink = item.workflow_stage_id || item.workflow_task_id;
                  
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-slate-900">{item.line_item}</p>
                          {item.justification && (
                            <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                              {item.justification}
                            </p>
                          )}
                          {item.is_committed && (
                            <Badge variant="outline" className="mt-1 text-xs">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Committed
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.quantity || '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.unit_cost ? `$${item.unit_cost.toLocaleString()}` : '-'}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        ${item.total.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div>
                          <p className="font-medium">
                            ${(item.actual_spent || 0).toLocaleString()}
                          </p>
                          {item.actual_spent > 0 && (
                            <p className={`text-xs ${
                              variance < 0 ? 'text-red-600' : 'text-emerald-600'
                            }`}>
                              {variance < 0 ? '+' : ''}{Math.abs(variance).toLocaleString()}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {hasWorkflowLink ? (
                          <div className="flex items-start gap-1">
                            <Link2 className="w-3 h-3 text-blue-600 mt-0.5 flex-shrink-0" />
                            <div className="text-xs">
                              {item.workflow_stage_id && (
                                <p className="text-slate-700">
                                  {getStageName(item.workflow_stage_id)}
                                </p>
                              )}
                              {item.workflow_task_id && (
                                <p className="text-slate-500">
                                  → {getTaskName(item.workflow_task_id)}
                                </p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => onEdit(item)}
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-500 hover:text-red-700"
                            onClick={() => onDelete(item)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        );
      })}
    </div>
  );
}