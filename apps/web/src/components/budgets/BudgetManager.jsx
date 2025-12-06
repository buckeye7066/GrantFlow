import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Plus,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  Download,
  Loader2,
  BarChart3,
  Link2
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import AddBudgetItemDialog from './AddBudgetItemDialog';
import BudgetItemsList from './BudgetItemsList';
import BudgetComparison from './BudgetComparison';
import BudgetReportDialog from './BudgetReportDialog';

/**
 * BudgetManager - Comprehensive budget management for grants
 * Features:
 * - Create and track detailed budget items
 * - Link items to workflow stages/tasks
 * - Compare planned vs actual spending
 * - Generate budget reports
 */
export default function BudgetManager({ grant, workflowStages = [], workflowTasks = [] }) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch budget items for this grant
  const { data: budgetItems = [], isLoading } = useQuery({
    queryKey: ['budgetItems', grant.id],
    queryFn: () => base44.entities.Budget.filter({ grant_id: grant.id }),
  });

  // Fetch expenses for actual spending
  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', grant.id],
    queryFn: () => base44.entities.Expense.filter({ grant_id: grant.id }),
  });

  // Mutations
  const createBudgetMutation = useMutation({
    mutationFn: (data) => base44.entities.Budget.create({ ...data, grant_id: grant.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgetItems', grant.id] });
      setShowAddDialog(false);
      setEditingItem(null);
      toast({
        title: '✅ Budget Item Added',
        description: 'Budget item has been created successfully',
      });
    },
  });

  const updateBudgetMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Budget.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgetItems', grant.id] });
      setShowAddDialog(false);
      setEditingItem(null);
      toast({
        title: '✅ Budget Item Updated',
        description: 'Budget item has been updated successfully',
      });
    },
  });

  const deleteBudgetMutation = useMutation({
    mutationFn: (id) => base44.entities.Budget.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgetItems', grant.id] });
      toast({
        title: '🗑️ Budget Item Deleted',
        description: 'Budget item has been removed',
      });
    },
  });

  // Calculate budget summary
  const budgetSummary = useMemo(() => {
    const totalPlanned = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
    const totalSpent = expenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);
    const totalCommitted = budgetItems
      .filter(item => item.is_committed)
      .reduce((sum, item) => sum + (item.total || 0), 0);
    
    const variance = totalPlanned - totalSpent;
    const variancePercent = totalPlanned > 0 ? (variance / totalPlanned) * 100 : 0;
    const spentPercent = totalPlanned > 0 ? (totalSpent / totalPlanned) * 100 : 0;

    // Category breakdown
    const categories = budgetItems.reduce((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = { planned: 0, spent: 0, items: [] };
      }
      acc[item.category].planned += item.total || 0;
      acc[item.category].items.push(item);
      return acc;
    }, {});

    // Add expenses to categories
    expenses.forEach(expense => {
      if (expense.category && categories[expense.category]) {
        categories[expense.category].spent += expense.amount || 0;
      }
    });

    return {
      totalPlanned,
      totalSpent,
      totalCommitted,
      variance,
      variancePercent,
      spentPercent,
      categories,
      itemsLinkedToWorkflow: budgetItems.filter(
        item => item.workflow_stage_id || item.workflow_task_id
      ).length,
    };
  }, [budgetItems, expenses]);

  const handleEdit = (item) => {
    setEditingItem(item);
    setShowAddDialog(true);
  };

  const handleDelete = (item) => {
    if (window.confirm(`Delete budget item "${item.line_item}"?`)) {
      deleteBudgetMutation.mutate(item.id);
    }
  };

  const handleSave = (data) => {
    if (editingItem) {
      updateBudgetMutation.mutate({ id: editingItem.id, data });
    } else {
      createBudgetMutation.mutate(data);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Budget Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-600">Total Planned</span>
              <DollarSign className="w-4 h-4 text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              ${budgetSummary.totalPlanned.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {budgetItems.length} line items
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-600">Total Spent</span>
              <TrendingUp className="w-4 h-4 text-emerald-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              ${budgetSummary.totalSpent.toLocaleString()}
            </p>
            <div className="mt-2">
              <Progress value={budgetSummary.spentPercent} className="h-2" />
              <p className="text-xs text-slate-500 mt-1">
                {budgetSummary.spentPercent.toFixed(1)}% of budget
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-600">Remaining</span>
              <BarChart3 className="w-4 h-4 text-purple-600" />
            </div>
            <p className={`text-2xl font-bold ${
              budgetSummary.variance < 0 ? 'text-red-600' : 'text-emerald-600'
            }`}>
              ${Math.abs(budgetSummary.variance).toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {budgetSummary.variance < 0 ? 'Over budget' : 'Under budget'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-600">Workflow Linked</span>
              <Link2 className="w-4 h-4 text-amber-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {budgetSummary.itemsLinkedToWorkflow}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              items linked to stages/tasks
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Budget Alerts */}
      {budgetSummary.variance < 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
              <div>
                <h4 className="font-semibold text-red-900">Budget Overrun Alert</h4>
                <p className="text-sm text-red-700 mt-1">
                  Current spending exceeds planned budget by ${Math.abs(budgetSummary.variance).toLocaleString()} 
                  ({Math.abs(budgetSummary.variancePercent).toFixed(1)}%)
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content Tabs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Grant Budget Management</CardTitle>
              <CardDescription>
                Track planned vs actual spending across all budget categories
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowReportDialog(true)}
              >
                <Download className="w-4 h-4 mr-2" />
                Generate Report
              </Button>
              <Button onClick={() => {
                setEditingItem(null);
                setShowAddDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-2" />
                Add Budget Item
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="items" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="items">Budget Items</TabsTrigger>
              <TabsTrigger value="comparison">Budget vs Actual</TabsTrigger>
            </TabsList>

            <TabsContent value="items" className="mt-6">
              <BudgetItemsList
                items={budgetItems}
                workflowStages={workflowStages}
                workflowTasks={workflowTasks}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </TabsContent>

            <TabsContent value="comparison" className="mt-6">
              <BudgetComparison
                budgetItems={budgetItems}
                expenses={expenses}
                categories={budgetSummary.categories}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <AddBudgetItemDialog
        open={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setEditingItem(null);
        }}
        onSave={handleSave}
        item={editingItem}
        workflowStages={workflowStages}
        workflowTasks={workflowTasks}
        isSaving={createBudgetMutation.isPending || updateBudgetMutation.isPending}
      />

      <BudgetReportDialog
        open={showReportDialog}
        onClose={() => setShowReportDialog(false)}
        grant={grant}
        budgetItems={budgetItems}
        expenses={expenses}
        summary={budgetSummary}
      />
    </div>
  );
}