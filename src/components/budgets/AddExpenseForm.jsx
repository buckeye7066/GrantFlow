
import React, { useState, useEffect } from "react";
import client from '@/api/client';
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Calendar as CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";

const BUDGET_CATEGORIES = ["personnel", "fringe", "travel", "equipment", "supplies", "contractual", "construction", "other_direct", "indirect"];
const PAYMENT_METHODS = ["check", "credit_card", "ach", "wire", "cash"];

export default function AddExpenseForm({ grantId, onSuccess }) {
  const [formData, setFormData] = useState({
    grant_id: grantId,
    organization_id: "", // This needs to be set from the grant
    date: new Date(),
    vendor: "",
    description: "",
    category: "",
    amount: 0,
    payment_method: "",
  });
  const queryClient = useQueryClient();
  
  const { data: grant } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: async () => {
      const grants = await client.entities.Grant.list();
      const foundGrant = grants.find(g => g.id === grantId);
      return foundGrant ?? null;
    },
    enabled: !!grantId,
  });

  // Populate organization_id from the grant once it loads. Without this the
  // submit button stayed permanently disabled (organization_id never left "").
  useEffect(() => {
    if (grant?.organization_id) {
      setFormData((prev) => ({ ...prev, organization_id: grant.organization_id }));
    }
  }, [grant]);

  const mutation = useMutation({
    mutationFn: (data) => {
      // Ensure date is properly formatted as ISO string (YYYY-MM-DD)
      const submitData = {
        ...data,
        date: data.date instanceof Date ? data.date.toISOString().split('T')[0] : data.date
      };
      return client.entities.Expense.create(submitData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', grantId] });
      if (onSuccess) onSuccess(); 
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    mutation.mutate(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>Date</Label>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-start font-normal">
              <CalendarIcon className="mr-2 h-4 w-4" />
              {formData.date ? format(formData.date, "PPP") : <span>Pick a date</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar mode="single" selected={formData.date} onSelect={(date) => setFormData({...formData, date})} initialFocus />
          </PopoverContent>
        </Popover>
      </div>
      <div className="space-y-2">
        <Label>Vendor</Label>
        <Input value={formData.vendor} onChange={(e) => setFormData({...formData, vendor: e.target.value})} placeholder="e.g., Staples, Delta Airlines" required />
      </div>
      <div className="space-y-2">
        <Label>Description</Label>
        <Textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} placeholder="Brief description of the expense" />
      </div>
      <div className="space-y-2">
        <Label>Category</Label>
        <Select value={formData.category} onValueChange={(value) => setFormData({...formData, category: value})} required>
          <SelectTrigger><SelectValue placeholder="Select a category" /></SelectTrigger>
          <SelectContent>
            {BUDGET_CATEGORIES.map(cat => (
              <SelectItem key={cat} value={cat} className="capitalize">{cat.replace(/_/g, ' ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Amount</Label>
        <Input type="number" min="0" step="0.01" value={formData.amount} onChange={(e) => setFormData({...formData, amount: parseFloat(e.target.value) || 0})} required />
      </div>
       <div className="space-y-2">
        <Label>Payment Method</Label>
        <Select value={formData.payment_method} onValueChange={(value) => setFormData({...formData, payment_method: value})}>
          <SelectTrigger><SelectValue placeholder="Select a payment method" /></SelectTrigger>
          <SelectContent>
            {PAYMENT_METHODS.map(method => (
              <SelectItem key={method} value={method} className="capitalize">{method.replace(/_/g, ' ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={mutation.isPending || !formData.grant_id || !formData.vendor || !formData.category || !(formData.amount > 0)}>
          {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Add Expense
        </Button>
      </div>
    </form>
  );
}
