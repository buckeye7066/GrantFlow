
import React, { useState } from "react";
import client from '@/api/client';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Plus, Banknote, TrendingDown, AlertTriangle } from "lucide-react";
import { sumBy, groupBy } from "@/utils/aggregate";
import { format } from "date-fns";
import AddBudgetItemForm from "./AddBudgetItemForm";
import AddExpenseForm from "./AddExpenseForm";

const BUDGET_CATEGORIES = ["personnel", "fringe", "travel", "equipment", "supplies", "contractual", "construction", "other_direct", "indirect"];

export default function BudgetTab({ grant }) {
    const grantId = grant.id;
    const queryClient = useQueryClient(); // FIX: Changed useQuery() to useQueryClient()

    const [showAddItem, setShowAddItem] = useState(false);
    const [showAddExpense, setShowAddExpense] = useState(false);

    const { data: budgetItems = [], isLoading: isLoadingBudget } = useQuery({
        queryKey: ['budgets', grantId],
        queryFn: () => client.entities.Budget.filter({ grant_id: grantId }),
        enabled: !!grantId,
    });

    const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
        queryKey: ['expenses', grantId],
        queryFn: () => client.entities.Expense.filter({ grant_id: grantId }),
        enabled: !!grantId,
    });

    const isLoading = isLoadingBudget || isLoadingExpenses;

    if (isLoading) {
        return (
            <div className="flex justify-center items-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
            </div>
        );
    }

    if (grant.status !== 'awarded') {
        return (
            <Card className="border-amber-500 bg-amber-50 shadow-none">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-amber-800">
                        <AlertTriangle className="w-5 h-5" />
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
    
    const totalBudget = sumBy(budgetItems, 'total');
    const totalExpenses = sumBy(expenses, 'amount');
    const remainingBudget = totalBudget - totalExpenses;
    const budgetByCategory = groupBy(budgetItems, 'category');

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card><CardHeader><CardTitle>Total Budget</CardTitle></CardHeader><CardContent><p className="text-3xl font-bold">${totalBudget.toLocaleString()}</p></CardContent></Card>
                <Card><CardHeader><CardTitle>Total Spent</CardTitle></CardHeader><CardContent><p className="text-3xl font-bold">${totalExpenses.toLocaleString()}</p></CardContent></Card>
                <Card><CardHeader><CardTitle>Remaining</CardTitle></CardHeader><CardContent><p className="text-3xl font-bold text-emerald-600">${remainingBudget.toLocaleString()}</p></CardContent></Card>
            </div>

            <Tabs defaultValue="budget">
                <TabsList className="mb-4">
                    <TabsTrigger value="budget">Budget</TabsTrigger>
                    <TabsTrigger value="expenses">Expenses</TabsTrigger>
                </TabsList>

                <TabsContent value="budget">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Budget Breakdown</CardTitle>
                                <CardDescription>Line items for the grant budget.</CardDescription>
                            </div>
                            <Dialog open={showAddItem} onOpenChange={setShowAddItem}>
                                <DialogTrigger asChild><Button><Plus className="w-4 h-4 mr-2" /> Add Line Item</Button></DialogTrigger>
                                <DialogContent>
                                    <DialogHeader><DialogTitle>New Budget Line Item</DialogTitle></DialogHeader>
                                    <AddBudgetItemForm grantId={grantId} onSuccess={() => setShowAddItem(false)} onCancel={() => setShowAddItem(false)} />
                                </DialogContent>
                            </Dialog>
                        </CardHeader>
                        <CardContent>
                            {budgetItems.length === 0 ? (
                                <div className="text-center py-8 text-slate-500">
                                    <p>No budget line items yet.</p>
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[60%]">Line Item</TableHead>
                                            <TableHead className="text-right">Total</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {BUDGET_CATEGORIES.map(category => (
                                            budgetByCategory[category] && (
                                                <React.Fragment key={category}>
                                                    <TableRow className="bg-slate-50 font-semibold"><TableCell colSpan="2" className="capitalize">{category.replace(/_/g, ' ')}</TableCell></TableRow>
                                                    {budgetByCategory[category].map(item => (
                                                        <TableRow key={item.id}><TableCell>{item.line_item}</TableCell><TableCell className="text-right">${item.total.toLocaleString()}</TableCell></TableRow>
                                                    ))}
                                                </React.Fragment>
                                            )
                                        ))}
                                    </TableBody>
                                    <TableFooter>
                                        <TableRow><TableCell className="font-bold text-lg">Total</TableCell><TableCell className="text-right font-bold text-lg">${totalBudget.toLocaleString()}</TableCell></TableRow>
                                    </TableFooter>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="expenses">
                    <Card>
                         <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Expenses</CardTitle>
                                <CardDescription>Track spending against the budget.</CardDescription>
                            </div>
                            <Dialog open={showAddExpense} onOpenChange={setShowAddExpense}>
                                <DialogTrigger asChild><Button><Plus className="w-4 h-4 mr-2" /> Add Expense</Button></DialogTrigger>
                                <DialogContent>
                                    <DialogHeader><DialogTitle>New Expense</DialogTitle></DialogHeader>
                                    <AddExpenseForm grantId={grantId} onSuccess={() => setShowAddExpense(false)} />
                                </DialogContent>
                            </Dialog>
                        </CardHeader>
                        <CardContent>
                           {expenses.length === 0 ? (
                                <div className="text-center py-8 text-slate-500">
                                    <p>No expenses recorded yet.</p>
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                                    <TableBody>
                                        {expenses.map(expense => (
                                            <TableRow key={expense.id}><TableCell>{format(new Date(expense.date), 'MMM d, yyyy')}</TableCell><TableCell>{expense.description}</TableCell><TableCell className="capitalize">{expense.category?.replace(/_/g, ' ')}</TableCell><TableCell className="text-right">${expense.amount.toLocaleString()}</TableCell></TableRow>
                                        ))}
                                    </TableBody>
                                     <TableFooter>
                                        <TableRow><TableCell colSpan="3" className="font-bold text-lg">Total Spent</TableCell><TableCell className="text-right font-bold text-lg">${totalExpenses.toLocaleString()}</TableCell></TableRow>
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
