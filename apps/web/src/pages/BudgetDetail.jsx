import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ArrowLeft, Loader2, DollarSign, Plus, Banknote, TrendingDown, AlertTriangle, ShieldAlert } from "lucide-react";
import { sumBy, groupBy } from "lodash";
import { format } from "date-fns";
import AddBudgetItemForm from "../components/budgets/AddBudgetItemForm";
import AddExpenseForm from "../components/budgets/AddExpenseForm";

const BUDGET_CATEGORIES = ["personnel", "fringe", "travel", "equipment", "supplies", "contractual", "construction", "other_direct", "indirect"];

export default function BudgetDetail({ grantId }) {
  const queryClient = useQueryClient();

  const [showAddItem, setShowAddItem] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Fetch grant with RLS-safe validation
  const { data: grant, isLoading: isLoadingGrant } = useQuery({
    queryKey: ['grant', grantId, user?.email, isAdmin],
    queryFn: async () => {
      if (!grantId) return null;

      if (isAdmin) {
        return base44.entities.Grant.get(grantId);
      }

      const results = await base44.entities.Grant.filter(
        { id: grantId, created_by: user.email },
        '-created_date'
      );
      return results?.[0] || null;
    },
    enabled: !!user?.email && !!grantId,
  });

  // Only fetch budgets/expenses if grant is validated
  const { data: budgetItems = [], isLoading: isLoadingBudget } = useQuery({
    queryKey: ['budgets', grantId, user?.email],
    queryFn: () => base44.entities.Budget.filter({ grant_id: grantId }),
    enabled: !!user?.email && !!grant,
  });

  const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
    queryKey: ['expenses', grantId, user?.email],
    queryFn: () => base44.entities.Expense.filter({ grant_id: grantId }),
    enabled: !!user?.email && !!grant,
  });

  const isLoading = isLoadingUser || isLoadingGrant || isLoadingBudget || isLoadingExpenses;

  const totalBudget = sumBy(budgetItems, 'total');
  const totalExpenses = sumBy(expenses, 'amount');
  const remainingBudget = totalBudget - totalExpenses;
  const budgetByCategory = groupBy(budgetItems, 'category');

  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!grant) {
    return (
      <div className="p-8 text-center">
        <ShieldAlert className="w-12 h-12 mx-auto text-red-500 mb-4" />
        <h2 className="text-xl font-semibold text-slate-900 mb-2">Access Denied or Grant Not Found</h2>
        <p className="text-slate-600">You don't have permission to view this grant, or it doesn't exist.</p>
        <Link to={createPageUrl("Budgets")} className="mt-4 inline-block">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Budgets
          </Button>
        </Link>
      </div>
    );
  }

  // FORTIFICATION: Provide clear, actionable feedback if the grant is not yet awarded.
  if (grant && grant.status !== 'awarded') {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-7xl mx-auto space-y-6">
          <Link to={createPageUrl("Budgets")}>
              <Button variant="ghost">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Budgets
              </Button>
          </Link>
          <Card className="border-amber-500 bg-amber-50 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-800">
                <AlertTriangle className="w-5 h-5" />
                Budgeting Not Activated
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-amber-700">
                Budgeting and expense tracking tools are available only for grants with a status of "awarded".
              </p>
              <p className="text-amber-700 mt-2">
                To activate budgeting, please update this grant's status to 'Awarded' in the pipeline view.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* The Link to Budgets is removed as this is now an embedded component */}

        {/* Grant title is also part of the parent page, so it's removed from here */}

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
                  <DialogTrigger asChild>
                    <Button><Plus className="w-4 h-4 mr-2" /> Add Line Item</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>New Budget Line Item</DialogTitle></DialogHeader>
                    <AddBudgetItemForm grantId={grantId} onSuccess={() => setShowAddItem(false)} onCancel={() => setShowAddItem(false)} />
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {budgetItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500">
                    <Banknote className="w-12 h-12 mb-4" />
                    <p className="text-lg font-medium mb-2">No budget line items yet.</p>
                    <p className="mb-4">Start by adding your first budget line item to track your grant's finances.</p>
                    <Dialog open={showAddItem} onOpenChange={setShowAddItem}>
                      <DialogTrigger asChild>
                        <Button><Plus className="w-4 h-4 mr-2" /> Add First Line Item</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>New Budget Line Item</DialogTitle></DialogHeader>
                        <AddBudgetItemForm grantId={grantId} onSuccess={() => setShowAddItem(false)} onCancel={() => setShowAddItem(false)} />
                      </DialogContent>
                    </Dialog>
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
                            <TableRow className="bg-slate-50 font-semibold">
                              <TableCell colSpan={2} className="capitalize">{category.replace(/_/g, ' ')}</TableCell>
                            </TableRow>
                            {budgetByCategory[category].map(item => (
                              <TableRow key={item.id}>
                                <TableCell>
                                  <p className="font-medium">{item.line_item}</p>
                                  <p className="text-sm text-slate-500">{item.justification}</p>
                                </TableCell>
                                <TableCell className="text-right">${item.total.toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </React.Fragment>
                        )
                      ))}
                    </TableBody>
                    <TableFooter>
                        <TableRow>
                            <TableCell className="font-bold text-lg">Total Budget</TableCell>
                            <TableCell className="text-right font-bold text-lg">${totalBudget.toLocaleString()}</TableCell>
                        </TableRow>
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
                  <DialogTrigger asChild>
                    <Button><Plus className="w-4 h-4 mr-2" /> Add Expense</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>New Expense</DialogTitle></DialogHeader>
                    <AddExpenseForm grantId={grantId} onSuccess={() => setShowAddExpense(false)} onCancel={() => setShowAddExpense(false)} />
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {expenses.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500">
                    <TrendingDown className="w-12 h-12 mb-4" />
                    <p className="text-lg font-medium mb-2">No expenses recorded yet.</p>
                    <p className="mb-4">Once you start incurring costs, add them here to track your spending.</p>
                    <Dialog open={showAddExpense} onOpenChange={setShowAddExpense}>
                      <DialogTrigger asChild>
                        <Button><Plus className="w-4 h-4 mr-2" /> Add First Expense</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>New Expense</DialogTitle></DialogHeader>
                        <AddExpenseForm grantId={grantId} onSuccess={() => setShowAddExpense(false)} onCancel={() => setShowAddExpense(false)} />
                      </DialogContent>
                    </Dialog>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Vendor / Description</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expenses.map(expense => (
                        <TableRow key={expense.id}>
                          <TableCell>{format(new Date(expense.date), 'MMM d, yyyy')}</TableCell>
                          <TableCell>
                            <p className="font-medium">{expense.vendor}</p>
                            <p className="text-sm text-slate-500">{expense.description}</p>
                          </TableCell>
                          <TableCell className="capitalize">{expense.category?.replace(/_/g, ' ')}</TableCell>
                          <TableCell className="text-right">${expense.amount.toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                        <TableRow>
                            <TableCell colSpan={3} className="font-bold text-lg">Total Spent</TableCell>
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
    </div>
  );
}