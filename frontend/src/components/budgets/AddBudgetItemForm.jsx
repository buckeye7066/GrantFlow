
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";

const BUDGET_CATEGORIES = ["personnel", "fringe", "travel", "equipment", "supplies", "contractual", "construction", "other_direct", "indirect"];

export default function AddBudgetItemForm({ grantId, onSuccess, onCancel }) {
  const [item, setItem] = useState({
    grant_id: grantId,
    category: "",
    line_item: "",
    quantity: 1,
    unit_cost: 0,
    total: 0,
    justification: "",
  });
  const queryClient = useQueryClient();

  // FORTIFICATION: Automatically calculate total whenever quantity or unit_cost changes.
  useEffect(() => {
    const qty = parseFloat(item.quantity) || 0;
    const cost = parseFloat(item.unit_cost) || 0;
    setItem(prev => ({ ...prev, total: qty * cost }));
  }, [item.quantity, item.unit_cost]);

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    setItem(prev => ({
      ...prev,
      [name]: type === "number" ? parseFloat(value) || 0 : value
    }));
  };

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Budget.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets', grantId] });
      // FIX: The onSave function did not exist. It has been replaced with the correct onSuccess prop.
      if (onSuccess) onSuccess();
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    createMutation.mutate(item);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-slate-50 p-4 rounded-lg border space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="category">Category</Label>
          <Select value={item.category} onValueChange={(value) => setItem({...item, category: value})} required>
            <SelectTrigger id="category" name="category"><SelectValue placeholder="Select a category" /></SelectTrigger>
            <SelectContent>
              {BUDGET_CATEGORIES.map(cat => (
                <SelectItem key={cat} value={cat} className="capitalize">{cat.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="line_item">Line Item</Label>
          <Input id="line_item" name="line_item" value={item.line_item} onChange={handleChange} placeholder="e.g., Project Director" required />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-1">
          <Label htmlFor="quantity">Quantity</Label>
          <Input id="quantity" name="quantity" type="number" value={item.quantity} onChange={handleChange} placeholder="1" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="unit_cost">Unit Cost</Label>
          <Input id="unit_cost" name="unit_cost" type="number" value={item.unit_cost} onChange={handleChange} placeholder="100.00" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="total">Total</Label>
          {/* FORTIFICATION: Total is now read-only to guarantee data integrity. */}
          <Input id="total" name="total" type="number" value={item.total.toFixed(2)} readOnly className="bg-slate-200" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="justification">Justification</Label>
        <Textarea id="justification" name="justification" value={item.justification} onChange={handleChange} placeholder="Briefly explain this cost" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
        </Button>
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Add Item
        </Button>
      </div>
    </form>
  );
}
