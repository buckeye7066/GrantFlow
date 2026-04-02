import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function BurnRateCard({ budgetItems = [], expenses = [] }) {
    const totalBudget = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
    const totalSpent = expenses.reduce((sum, item) => sum + (item.amount || 0), 0);
    const fundsRemaining = totalBudget - totalSpent;
    const burnRatePercentage = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

    const dataByCategory = budgetItems.reduce((acc, item) => {
        if (!acc[item.category]) {
            acc[item.category] = { name: item.category, budget: 0, actual: 0 };
        }
        acc[item.category].budget += item.total || 0;
        return acc;
    }, {});

    expenses.forEach(expense => {
        const cat = expense.category || 'Uncategorised';
        if (!dataByCategory[cat]) {
            dataByCategory[cat] = { name: cat, budget: 0, actual: 0 };
        }
        dataByCategory[cat].actual += expense.amount || 0;
    });

    const chartData = Object.values(dataByCategory);

    return (
        <Card className="shadow-lg border-0 h-full">
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
                    <Progress value={burnRatePercentage} />
                </div>
                <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 30, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" />
                            <YAxis dataKey="name" type="category" width={80} tick={{ fontSize: 12 }} />
                            <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
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