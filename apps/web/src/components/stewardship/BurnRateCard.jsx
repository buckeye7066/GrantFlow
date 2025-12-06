import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function BurnRateCard({ budgetItems, expenses }) {
    const { totalBudget, totalSpent, fundsRemaining, burnRatePercentage } = useMemo(() => {
        const budget = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
        const spent = expenses.reduce((sum, item) => sum + (item.amount || 0), 0);
        const remaining = budget - spent;
        const percentage = budget > 0 ? (spent / budget) * 100 : 0;
        
        return {
            totalBudget: budget,
            totalSpent: spent,
            fundsRemaining: remaining,
            burnRatePercentage: percentage
        };
    }, [budgetItems, expenses]);

    const chartData = useMemo(() => {
        const dataByCategory = budgetItems.reduce((acc, item) => {
            if (!acc[item.category]) {
                acc[item.category] = { name: item.category, budget: 0, actual: 0 };
            }
            acc[item.category].budget += item.total || 0;
            return acc;
        }, {});

        expenses.forEach(expense => {
            if (!dataByCategory[expense.category]) {
                dataByCategory[expense.category] = { name: expense.category, budget: 0, actual: 0 };
            }
            dataByCategory[expense.category].actual += expense.amount || 0;
        });

        return Object.values(dataByCategory);
    }, [budgetItems, expenses]);

    const formatCurrency = (value) => `$${value.toLocaleString()}`;

    return (
        <Card className="shadow-lg border-0 h-full" data-testid="burn-rate-card">
            <CardHeader>
                <CardTitle>Budget vs. Actuals</CardTitle>
                <CardDescription>
                    Total Spent: ${totalSpent.toLocaleString()} of ${totalBudget.toLocaleString()}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div>
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-sm font-medium text-slate-600">Funds Remaining: ${fundsRemaining.toLocaleString()}</span>
                        <span className="text-sm font-semibold">{burnRatePercentage.toFixed(1)}%</span>
                    </div>
                    <Progress value={burnRatePercentage} data-testid="burn-rate-progress" />
                </div>
                <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%" aria-label="Budget versus actual expenses chart by category">
                        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 30, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" tickFormatter={formatCurrency} />
                            <YAxis dataKey="name" type="category" width={80} tick={{ fontSize: 12 }} />
                            <Tooltip formatter={formatCurrency} />
                            <Legend />
                            <Bar dataKey="budget" fill="#a0aec0" name="Budgeted" />
                            <Bar dataKey="actual" fill="#4299e1" name="Actual Spent" />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}