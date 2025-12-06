import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';

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

export default function BudgetComparison({ budgetItems = [], expenses = [], categories = {} }) {
  if (budgetItems.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <p className="text-lg font-medium mb-2">No budget data to compare</p>
        <p className="text-sm">Add budget items to see planned vs actual comparison</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Overall Summary */}
      <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">
            Budget Performance Overview
          </h3>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <p className="text-sm text-slate-600 mb-1">Total Planned</p>
              <p className="text-2xl font-bold text-slate-900">
                ${budgetItems.reduce((sum, item) => sum + (item.total || 0), 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600 mb-1">Total Spent</p>
              <p className="text-2xl font-bold text-slate-900">
                ${expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600 mb-1">Variance</p>
              <p className={`text-2xl font-bold ${
                (budgetItems.reduce((sum, item) => sum + (item.total || 0), 0) - 
                 expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0)) < 0
                  ? 'text-red-600'
                  : 'text-emerald-600'
              }`}>
                ${Math.abs(
                  budgetItems.reduce((sum, item) => sum + (item.total || 0), 0) - 
                  expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0)
                ).toLocaleString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Category Breakdown */}
      <div className="space-y-4">
        {Object.entries(categories).map(([category, data]) => {
          const planned = data.planned || 0;
          const spent = data.spent || 0;
          const variance = planned - spent;
          const variancePercent = planned > 0 ? Math.abs((variance / planned) * 100) : 0;
          const spentPercent = planned > 0 ? (spent / planned) * 100 : 0;
          const isOverBudget = variance < 0;
          
          return (
            <Card key={category} className={isOverBudget ? 'border-red-200' : ''}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h4 className="font-semibold text-slate-900 text-lg">
                      {CATEGORY_LABELS[category] || category}
                    </h4>
                    <p className="text-sm text-slate-500 mt-1">
                      {data.items?.length || 0} line item{data.items?.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  
                  {isOverBudget && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Over Budget
                    </Badge>
                  )}
                </div>

                {/* Budget vs Actual Bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-slate-600">Progress</span>
                    <span className="font-semibold text-slate-900">
                      {spentPercent.toFixed(1)}% of budget
                    </span>
                  </div>
                  <Progress 
                    value={Math.min(spentPercent, 100)} 
                    className={`h-3 ${isOverBudget ? '[&>div]:bg-red-500' : ''}`}
                  />
                  {spentPercent > 100 && (
                    <p className="text-xs text-red-600 mt-1">
                      Exceeded budget by {(spentPercent - 100).toFixed(1)}%
                    </p>
                  )}
                </div>

                {/* Numbers Grid */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Planned</p>
                    <p className="text-lg font-bold text-slate-900">
                      ${planned.toLocaleString()}
                    </p>
                  </div>
                  
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Spent</p>
                    <p className="text-lg font-bold text-slate-900">
                      ${spent.toLocaleString()}
                    </p>
                  </div>
                  
                  <div className={`rounded-lg p-3 ${
                    isOverBudget ? 'bg-red-50' : 'bg-emerald-50'
                  }`}>
                    <div className="flex items-center gap-1 mb-1">
                      {isOverBudget ? (
                        <TrendingUp className="w-3 h-3 text-red-600" />
                      ) : (
                        <TrendingDown className="w-3 h-3 text-emerald-600" />
                      )}
                      <p className={`text-xs ${
                        isOverBudget ? 'text-red-600' : 'text-emerald-600'
                      }`}>
                        {isOverBudget ? 'Over' : 'Under'}
                      </p>
                    </div>
                    <p className={`text-lg font-bold ${
                      isOverBudget ? 'text-red-700' : 'text-emerald-700'
                    }`}>
                      ${Math.abs(variance).toLocaleString()}
                    </p>
                    <p className={`text-xs ${
                      isOverBudget ? 'text-red-600' : 'text-emerald-600'
                    }`}>
                      {variancePercent.toFixed(1)}%
                    </p>
                  </div>
                </div>

                {/* Line Items Details */}
                {data.items && data.items.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-200">
                    <p className="text-sm font-medium text-slate-700 mb-2">Line Items:</p>
                    <div className="space-y-1">
                      {data.items.map(item => (
                        <div key={item.id} className="flex justify-between text-sm">
                          <span className="text-slate-600 truncate mr-2">
                            {item.line_item}
                          </span>
                          <span className="font-medium text-slate-900 whitespace-nowrap">
                            ${item.total.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}