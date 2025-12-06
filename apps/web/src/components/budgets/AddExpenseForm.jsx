import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Calendar as CalendarIcon, Loader2, AlertCircle } from "lucide-react";
import { format } from "date-fns";

const BUDGET_CATEGORIES = ["personnel", "fringe", "travel", "equipment", "supplies", "contractual", "construction", "other_direct", "indirect"];
const PAYMENT_METHODS = ["check", "credit_card", "ach", "wire", "cash"];

export default function AddExpenseForm({ grantId, onSuccess }) {
  const [formData, setFormData] = useState({
    grant_id: grantId,
    organization_id: "",
    date: new Date(),
    vendor: "",
    description: "",
    category: "",
    amount: "",
    payment_method: "",
  });
  const [validationError, setValidationError] = useState(null);
  const queryClient = useQueryClient();
  
  const { data: grant, isLoading: isLoadingGrant, error: grantError } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: async () => {
      const grants = await base44.entities.Grant.list();
      return grants.find(g => g.id === grantId);
    },
    enabled: !!grantId,
  });

  useEffect(() => {
    if (grant?.organization_id) {
      setFormData(prev => ({...prev, organization_id: grant.organization_id}));
    }
  }, [grant]);

  const mutation = useMutation({
    mutationFn: (data) => {
      const submitData = {
        ...data,
        amount: parseFloat(data.amount),
        date: data.date instanceof Date ? data.date.toISOString().split('T')[0] : data.date
      };
      return base44.entities.Expense.create(submitData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', grantId] });
      if (onSuccess) onSuccess(); 
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    setValidationError(null);

    const amount = parseFloat(formData.amount);
    
    if (!formData.vendor.trim()) {
      setValidationError("Vendor is required");
      return;
    }

    if (!formData.category) {
      setValidationError("Category is required");
      return;
    }

    if (!formData.amount || isNaN(amount) || amount <= 0) {
      setValidationError("Amount must be greater than zero");
      return;
    }

    if (!formData.payment_method) {
      setValidationError("Payment method is required");
      return;
    }

    mutation.mutate(formData);
  };

  if (grantError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load grant information. Please try again.
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoadingGrant) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {validationError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to create expense. Please try again.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="expense-date">Date</Label>
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              id="expense-date"
              variant="outline" 
              className="w-full justify-start font-normal"
              type="button"
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {formData.date ? format(formData.date, "PPP") : <span>Pick a date</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar 
              mode="single" 
              selected={formData.date} 
              onSelect={(date) => setFormData({...formData, date: date || new Date()})} 
              initialFocus 
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="space-y-2">
        <Label htmlFor="expense-vendor">Vendor *</Label>
        <Input 
          id="expense-vendor"
          value={formData.vendor} 
          onChange={(e) => setFormData({...formData, vendor: e.target.value})} 
          placeholder="e.g., Staples, Delta Airlines" 
          required 
          aria-required="true"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="expense-description">Description</Label>
        <Textarea 
          id="expense-description"
          value={formData.description} 
          onChange={(e) => setFormData({...formData, description: e.target.value})} 
          placeholder="Brief description of the expense" 
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="expense-category">Category *</Label>
        <Select 
          value={formData.category} 
          onValueChange={(value) => setFormData({...formData, category: value})} 
          required
        >
          <SelectTrigger id="expense-category" aria-required="true">
            <SelectValue placeholder="Select a category" />
          </SelectTrigger>
          <SelectContent>
            {BUDGET_CATEGORIES.map(cat => (
              <SelectItem key={cat} value={cat} className="capitalize">
                {cat.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="expense-amount">Amount *</Label>
        <Input 
          id="expense-amount"
          type="number" 
          step="0.01"
          min="0.01"
          value={formData.amount} 
          onChange={(e) => setFormData({...formData, amount: e.target.value})} 
          placeholder="0.00"
          required 
          aria-required="true"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="expense-payment-method">Payment Method *</Label>
        <Select 
          value={formData.payment_method} 
          onValueChange={(value) => setFormData({...formData, payment_method: value})}
          required
        >
          <SelectTrigger id="expense-payment-method" aria-required="true">
            <SelectValue placeholder="Select a payment method" />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHODS.map(method => (
              <SelectItem key={method} value={method} className="capitalize">
                {method.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-3">
        <Button 
          type="submit" 
          disabled={mutation.isPending || !formData.organization_id || isLoadingGrant}
        >
          {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Add Expense
        </Button>
      </div>
    </form>
  );
}