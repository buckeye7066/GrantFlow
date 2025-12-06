import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Plus, AlertTriangle } from "lucide-react";
import { sumBy, groupBy } from "lodash";
import { format } from "date-fns";
import AddBudgetItemForm from "./AddBudgetItemForm";
import AddExpenseForm from "./AddExpenseForm";

const formatCategory = (category) => {
    if (!category) return '';
    return category.replace(/_/g, ' ');
};

export default function BudgetTab({ grant }) {
    const grantId = grant.id;
    const queryClient = useQueryClient();

    const [showAddItem, setShowAddItem] = useState(false);
    const [showAddExpense, setShowAddExpense] = useState(false);

    const { data: budgetItems = [], isLoading: isLoadingBudget } = useQuery({
        queryKey: ['budgets', grantId],
        queryFn: () => base44.entities.Budget.filter({ grant_id: grantId }),
        enabled: !!grantId,
    });

    const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
        queryKey: ['expenses', grantId],
        queryFn: () => base44.entities.Expense.filter({ grant_id: grantId }),
        enabled: !!grantId,
    });

    const budgetByCategory = useMemo(() => groupBy(budgetItems, 'category'), [budgetItems]);
    
    const totalBudget = useMemo(() => sumBy(budgetItems, 'total'), [budgetItems]);
    
    const totalExpenses = useMemo(() => sumBy(expenses, 'amount'), [expenses]);
    
    const remainingBudget = useMemo(() => totalBudget - totalExpenses, [totalBudget, totalExpenses]);

    const categories = useMemo(() => Object.keys(budgetByCategory).sort(), [budgetByCategory]);

    const handleBudgetItemSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['budgets', grantId] });
        setShowAddItem(false);
    };

    const handleExpenseSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['expenses', grantId] });
        setShowAddExpense(false);
    };

    const isLoading = isLoadingBudget || isLoadingExpenses;

    if (isLoading) {
        return (
            <div className="flex justify-center items-center p-8" role="status" aria-label="Loading budget data">
                <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
            </div>
        );
    }

    if (grant.status !== 'awarded') {
        return (
            <Card className="border-amber-500 bg-amber-50 shadow-none" role="alert">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-amber-800">
                        <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                        Budgeting Not Activated
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-amber-700">
                        Budgeting and expense tracking are available once a grant is "Awarded".
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6" role="region" aria-label="Budget summary">
                <Card>
                    <CardHeader><CardTitle>Total Budget</CardTitle></CardHeader>
                    <CardContent><p className="text-3xl font-bold">${totalBudget.toLocaleString()}</p></CardContent>
                </Card>
                <Card>
                    <CardHeader><CardTitle>Total Spent</CardTitle></CardHeader>
                    <CardContent><p className="text-3xl font-bold">${totalExpenses.toLocaleString()}</p></CardContent>
                </Card>
                <Card>
                    <CardHeader><CardTitle>Remaining</CardTitle></CardHeader>
                    <CardContent><p className="text-3xl font-bold text-emerald-600">${remainingBudget.toLocaleString()}</p></CardContent>
                </Card>
            </div>

            <Tabs defaultValue="budget">
                <TabsList className="mb-4" role="tablist" aria-label="Budget and expenses tabs">
                    <TabsTrigger value="budget" role="tab" aria-controls="budget-panel">Budget</TabsTrigger>
                    <TabsTrigger value="expenses" role="tab" aria-controls="expenses-panel">Expenses</TabsTrigger>
                </TabsList>

                <TabsContent value="budget" role="tabpanel" id="budget-panel" aria-labelledby="budget-tab">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Budget Breakdown</CardTitle>
                                <CardDescription>Line items for the grant budget.</CardDescription>
                            </div>
                            <Dialog open={showAddItem} onOpenChange={setShowAddItem}>
                                <DialogTrigger asChild>
                                    <Button aria-label="Add new budget line item">
                                        <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                                        Add Line Item
                                    </Button>
                                </DialogTrigger>
                                <DialogContent role="dialog" aria-labelledby="add-budget-dialog-title">
                                    <DialogHeader>
                                        <DialogTitle id="add-budget-dialog-title">New Budget Line Item</DialogTitle>
                                    </DialogHeader>
                                    <AddBudgetItemForm 
                                        grantId={grantId} 
                                        onSuccess={handleBudgetItemSuccess} 
                                        onCancel={() => setShowAddItem(false)} 
                                    />
                                </DialogContent>
                            </Dialog>
                        </CardHeader>
                        <CardContent>
                            {budgetItems.length === 0 ? (
                                <div className="text-center py-8 text-slate-500" role="status">
                                    <p>No budget line items yet.</p>
                                </div>
                            ) : (
                                <Table role="table" aria-label="Budget breakdown by category">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[60%]">Line Item</TableHead>
                                            <TableHead className="text-right">Total</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {categories.map(category => (
                                            <React.Fragment key={category}>
                                                <TableRow className="bg-slate-50 font-semibold">
                                                    <TableCell colSpan="2" className="capitalize">
                                                        {formatCategory(category)}
                                                    </TableCell>
                                                </TableRow>
                                                {budgetByCategory[category].map(item => (
                                                    <TableRow key={item.id}>
                                                        <TableCell>{item.line_item}</TableCell>
                                                        <TableCell className="text-right">${item.total.toLocaleString()}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </React.Fragment>
                                        ))}
                                    </TableBody>
                                    <TableFooter>
                                        <TableRow>
                                            <TableCell className="font-bold text-lg">Total</TableCell>
                                            <TableCell className="text-right font-bold text-lg">${totalBudget.toLocaleString()}</TableCell>
                                        </TableRow>
                                    </TableFooter>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="expenses" role="tabpanel" id="expenses-panel" aria-labelledby="expenses-tab">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Expenses</CardTitle>
                                <CardDescription>Track spending against the budget.</CardDescription>
                            </div>
                            <Dialog open={showAddExpense} onOpenChange={setShowAddExpense}>
                                <DialogTrigger asChild>
                                    <Button aria-label="Add new expense">
                                        <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                                        Add Expense
                                    </Button>
                                </DialogTrigger>
                                <DialogContent role="dialog" aria-labelledby="add-expense-dialog-title">
                                    <DialogHeader>
                                        <DialogTitle id="add-expense-dialog-title">New Expense</DialogTitle>
                                    </DialogHeader>
                                    <AddExpenseForm 
                                        grantId={grantId} 
                                        onSuccess={handleExpenseSuccess}
                                    />
                                </DialogContent>
                            </Dialog>
                        </CardHeader>
                        <CardContent>
                            {expenses.length === 0 ? (
                                <div className="text-center py-8 text-slate-500" role="status">
                                    <p>No expenses recorded yet.</p>
                                </div>
                            ) : (
                                <Table role="table" aria-label="Expenses list">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Date</TableHead>
                                            <TableHead>Description</TableHead>
                                            <TableHead>Category</TableHead>
                                            <TableHead className="text-right">Amount</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {expenses.map(expense => (
                                            <TableRow key={expense.id}>
                                                <TableCell>{format(new Date(expense.date), 'MMM d, yyyy')}</TableCell>
                                                <TableCell>{expense.description}</TableCell>
                                                <TableCell className="capitalize">{formatCategory(expense.category)}</TableCell>
                                                <TableCell className="text-right">${expense.amount.toLocaleString()}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                    <TableFooter>
                                        <TableRow>
                                            <TableCell colSpan="3" className="font-bold text-lg">Total Spent</TableCell>
                                            <TableCell className="text-right font-bold text-lg">${totalExpenses.toLocaleString()}</TableCell>
                                        </TableRow>
                                    </TableFooter>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}