import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, Area, AreaChart } from 'recharts';
import { DollarSign, TrendingUp, AlertCircle, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Financial Reporting - Grants received, allocated, and budget tracking
 */
export default function FinancialReporting({ grants, budgetItems = [], expenses = [] }) {
  const financialData = useMemo(() => {
    const awarded = grants.filter(g => g.status === 'awarded');
    
    // Total awarded amount
    const totalAwarded = awarded.reduce((sum, g) => {
      return sum + (g.award_ceiling || g.award_floor || 0);
    }, 0);

    // Total budgeted
    const totalBudgeted = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);

    // Total spent
    const totalSpent = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

    // Remaining funds
    const remainingBudget = totalBudgeted - totalSpent;
    const remainingGrants = totalAwarded - totalBudgeted;

    // Burn rate (monthly)
    const expensesByMonth = {};
    expenses.forEach(exp => {
      if (!exp.date) return;
      const date = new Date(exp.date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!expensesByMonth[monthKey]) {
        expensesByMonth[monthKey] = 0;
      }
      expensesByMonth[monthKey] += exp.amount || 0;
    });

    const monthlyBurn = Object.entries(expensesByMonth)
      .map(([month, amount]) => ({ month, amount }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    const avgMonthlyBurn = monthlyBurn.length > 0
      ? monthlyBurn.reduce((sum, m) => sum + m.amount, 0) / monthlyBurn.length
      : 0;

    // Category breakdown
    const categorySpending = {};
    expenses.forEach(exp => {
      const cat = exp.category || 'other';
      if (!categorySpending[cat]) {
        categorySpending[cat] = { category: cat, spent: 0, budgeted: 0 };
      }
      categorySpending[cat].spent += exp.amount || 0;
    });

    budgetItems.forEach(item => {
      const cat = item.category || 'other';
      if (!categorySpending[cat]) {
        categorySpending[cat] = { category: cat, spent: 0, budgeted: 0 };
      }
      categorySpending[cat].budgeted += item.total || 0;
    });

    const categoryData = Object.values(categorySpending).map(cat => ({
      ...cat,
      remaining: cat.budgeted - cat.spent,
      utilizationRate: cat.budgeted > 0 ? (cat.spent / cat.budgeted) * 100 : 0
    }));

    // Grants by funder with amounts
    const funderAmounts = {};
    awarded.forEach(grant => {
      const funder = grant.funder || 'Unknown';
      if (!funderAmounts[funder]) {
        funderAmounts[funder] = 0;
      }
      funderAmounts[funder] += (grant.award_ceiling || grant.award_floor || 0);
    });

    const topFunders = Object.entries(funderAmounts)
      .map(([funder, amount]) => ({ funder, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    // Forecast runway (months remaining based on burn rate)
    const runway = avgMonthlyBurn > 0 ? remainingBudget / avgMonthlyBurn : 0;

    // Budget utilization
    const utilizationRate = totalBudgeted > 0 ? (totalSpent / totalBudgeted) * 100 : 0;

    return {
      totalAwarded,
      totalBudgeted,
      totalSpent,
      remainingBudget,
      remainingGrants,
      avgMonthlyBurn,
      runway,
      utilizationRate,
      monthlyBurn,
      categoryData,
      topFunders,
      awardedCount: awarded.length
    };
  }, [grants, budgetItems, expenses]);

  const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#f43f5e'];

  const formatCurrency = (value) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
    return `$${value.toFixed(0)}`;
  };

  return (
    <div className="space-y-6">
      {/* Financial Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <DollarSign className="w-5 h-5 text-green-600" />
              <Badge variant="outline">{financialData.awardedCount} grants</Badge>
            </div>
            <p className="text-2xl font-bold text-green-600">
              {formatCurrency(financialData.totalAwarded)}
            </p>
            <p className="text-sm text-slate-600 mt-1">Total Awarded</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <DollarSign className="w-5 h-5 text-blue-600" />
              <Badge variant="outline">Allocated</Badge>
            </div>
            <p className="text-2xl font-bold text-blue-600">
              {formatCurrency(financialData.totalBudgeted)}
            </p>
            <p className="text-sm text-slate-600 mt-1">Total Budgeted</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <DollarSign className="w-5 h-5 text-amber-600" />
              <Badge 
                variant={financialData.utilizationRate > 90 ? 'destructive' : 'outline'}
              >
                {financialData.utilizationRate.toFixed(0)}%
              </Badge>
            </div>
            <p className="text-2xl font-bold text-amber-600">
              {formatCurrency(financialData.totalSpent)}
            </p>
            <p className="text-sm text-slate-600 mt-1">Total Spent</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <TrendingUp className="w-5 h-5 text-purple-600" />
              <Badge variant="outline">{financialData.runway.toFixed(1)} mo</Badge>
            </div>
            <p className="text-2xl font-bold text-purple-600">
              {formatCurrency(financialData.remainingBudget)}
            </p>
            <p className="text-sm text-slate-600 mt-1">Available Budget</p>
          </CardContent>
        </Card>
      </div>

      {/* Budget Health Alert */}
      {financialData.utilizationRate > 85 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
              <div>
                <h4 className="font-semibold text-amber-900">High Budget Utilization</h4>
                <p className="text-sm text-amber-800 mt-1">
                  {financialData.utilizationRate.toFixed(1)}% of allocated budget has been spent. 
                  Approximately {financialData.runway.toFixed(1)} months remaining at current burn rate.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Monthly Burn Rate */}
      {financialData.monthlyBurn.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Monthly Spending Trend</CardTitle>
            <CardDescription>
              Average burn rate: {formatCurrency(financialData.avgMonthlyBurn)}/month
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={financialData.monthlyBurn}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(value) => formatCurrency(value)} />
                <Tooltip 
                  formatter={(value) => formatCurrency(value)}
                  labelFormatter={(label) => `Month: ${label}`}
                />
                <Area 
                  type="monotone" 
                  dataKey="amount" 
                  stroke="#f59e0b" 
                  fill="#fef3c7" 
                  name="Spending"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Category Spending */}
        {financialData.categoryData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Budget by Category</CardTitle>
              <CardDescription>Spending vs. allocated budget</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={financialData.categoryData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="category" 
                    tick={{ fontSize: 11 }}
                    angle={-45}
                    textAnchor="end"
                    height={100}
                  />
                  <YAxis tickFormatter={(value) => formatCurrency(value)} />
                  <Tooltip formatter={(value) => formatCurrency(value)} />
                  <Legend />
                  <Bar dataKey="budgeted" fill="#3b82f6" name="Budgeted" />
                  <Bar dataKey="spent" fill="#f59e0b" name="Spent" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Top Funders */}
        {financialData.topFunders.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Funding by Source</CardTitle>
              <CardDescription>Top 10 funders by award amount</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={financialData.topFunders.slice(0, 8)}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry) => `${entry.funder.substring(0, 15)}...`}
                    outerRadius={80}
                    dataKey="amount"
                  >
                    {financialData.topFunders.slice(0, 8).map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(value)} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Detailed Category Table */}
      {financialData.categoryData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Category Utilization Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-900">Category</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-900">Budgeted</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-900">Spent</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-900">Remaining</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-900">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {financialData.categoryData.map((cat, idx) => (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="py-3 px-4 text-sm capitalize">{cat.category}</td>
                      <td className="py-3 px-4 text-sm text-right">{formatCurrency(cat.budgeted)}</td>
                      <td className="py-3 px-4 text-sm text-right">{formatCurrency(cat.spent)}</td>
                      <td className={`py-3 px-4 text-sm text-right font-semibold ${
                        cat.remaining < 0 ? 'text-red-600' : 'text-green-600'
                      }`}>
                        {formatCurrency(Math.abs(cat.remaining))}
                      </td>
                      <td className="py-3 px-4 text-sm text-right">
                        <Badge variant={cat.utilizationRate > 90 ? 'destructive' : 'outline'}>
                          {cat.utilizationRate.toFixed(1)}%
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}