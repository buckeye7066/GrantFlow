
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar as CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useDebounce } from '../hooks/useDebounce'; // Added import for useDebounce

export default function TimeLogForm({ timeLog, onSuccess, onCancel }) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    project_id: timeLog?.project_id || "",
    date: timeLog?.date ? new Date(timeLog.date) : new Date(),
    hours: timeLog?.hours || 0,
    description: timeLog?.description || "",
    billable: timeLog?.billable ?? true,
    is_grant_chargeable: timeLog?.is_grant_chargeable || false,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => base44.entities.Project.list(),
  });

  // Fetch BillingSettings for default rate and rounding increment
  const { data: billingSettings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => base44.entities.BillingSettings.list().then(res => res[0]),
  });

  const selectedProject = projects.find(p => p.id === formData.project_id);

  // State for hourly rate. It can be initialized from an existing timeLog or will be set by useEffect.
  // User can also override it.
  const [hourlyRate, setHourlyRate] = useState(timeLog?.hourly_rate || 0);

  // Debounce hours for total amount display, ensuring calculations aren't too frequent during typing.
  const debouncedHours = useDebounce(formData.hours, 500);

  // Effect to set the hourlyRate.
  // Priority: existing timeLog's rate > selected project's rate > global default rate > hardcoded fallback.
  // This effect will run when the component mounts or its dependencies change.
  // It handles initial setup for new entries and updates for existing entries.
  useEffect(() => {
    if (timeLog && timeLog.hourly_rate !== undefined) {
      // If editing an existing time log and it has a stored hourly_rate, use that.
      // Only update if the current state value is different from timeLog's rate.
      if (hourlyRate !== timeLog.hourly_rate) {
        setHourlyRate(timeLog.hourly_rate);
      }
    } else {
      // If creating a new time log, or an existing time log doesn't have an hourly_rate stored,
      // derive the rate from project settings or global billing settings.
      const defaultRate = selectedProject?.hourly_rate || billingSettings?.default_hourly_rate || 225;
      // Only update if the derived default rate is different from the current hourlyRate state,
      // to avoid unnecessary re-renders or overriding a user's manual input (for new entries).
      if (defaultRate !== hourlyRate) {
        setHourlyRate(defaultRate);
      }
    }
  }, [timeLog, selectedProject, billingSettings]); // Dependencies are timeLog, selectedProject, and billingSettings.
                                                  // hourlyRate is intentionally excluded to allow user overrides without immediate effect reset.

  // Calculate total amount for display using debounced hours and current hourlyRate
  const displayTotalAmount = (parseFloat(debouncedHours) || 0) * (parseFloat(hourlyRate) || 0);

  const mutation = useMutation({
    mutationFn: (data) => 
      timeLog 
        ? base44.entities.TimeLog.update(timeLog.id, data)
        : base44.entities.TimeLog.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeLogs'] });
      onSuccess();
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Determine rounding increment from billing settings or default to 6 minutes
    const increment = billingSettings?.time_increment_minutes || 6;

    // Calculate raw minutes from the current hours in formData
    const rawMinutes = (parseFloat(formData.hours) || 0) * 60;
    
    // Round minutes up to the nearest increment
    const roundedMinutes = Math.ceil(rawMinutes / increment) * increment;
    const roundedHours = roundedMinutes / 60;

    // Recalculate total amount with the rounded hours and current hourlyRate
    const finalTotalAmount = roundedHours * (parseFloat(hourlyRate) || 0);

    mutation.mutate({
      ...formData,
      date: format(formData.date, 'yyyy-MM-dd'),
      hours: roundedHours, // Use the rounded hours for submission
      hourly_rate: hourlyRate, // Use the current (potentially user-edited) hourly rate
      total_amount: finalTotalAmount, // Use the final calculated total amount
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="project">Project *</Label>
        <Select
          value={formData.project_id}
          onValueChange={(value) => setFormData({ ...formData, project_id: value })}
          required
        >
          <SelectTrigger id="project"><SelectValue placeholder="Select a project" /></SelectTrigger>
          <SelectContent>
            {projects.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.project_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="date">Date *</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full justify-start font-normal" id="date">
                <CalendarIcon className="mr-2 h-4 w-4" />
                {formData.date ? format(formData.date, "PPP") : <span>Pick a date</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar mode="single" selected={formData.date} onSelect={(date) => setFormData({ ...formData, date })} initialFocus />
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-2">
          <Label htmlFor="hours">Hours *</Label>
          <Input
            id="hours"
            type="number"
            step="0.01"
            value={formData.hours}
            onChange={(e) => setFormData({ ...formData, hours: parseFloat(e.target.value) || 0 })}
            required
          />
        </div>
      </div>

      {/* Display calculated hourly rate and total amount */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="hourlyRate">Hourly Rate</Label>
          <Input
            id="hourlyRate"
            type="number"
            step="0.01"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(parseFloat(e.target.value) || 0)}
            disabled={mutation.isPending} // Disable editing during submission
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="totalAmount">Total Amount</Label>
          <Input
            id="totalAmount"
            type="number"
            step="0.01"
            value={displayTotalAmount.toFixed(2)} // Display formatted total amount
            disabled // This field is derived, not editable
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="What did you work on?"
        />
      </div>
      
      <div className="flex items-center space-x-2">
        <Checkbox
          id="billable"
          checked={formData.billable}
          onCheckedChange={(checked) => setFormData({ ...formData, billable: checked })}
        />
        <Label htmlFor="billable">This time is billable</Label>
      </div>
      
      {selectedProject?.payment_option === 'bill_to_grant' && (
        <div className="flex items-center space-x-2">
          <Checkbox
            id="grant_chargeable"
            checked={formData.is_grant_chargeable}
            onCheckedChange={(checked) => setFormData({ ...formData, is_grant_chargeable: checked })}
          />
          <Label htmlFor="grant_chargeable">This time is grant-chargeable</Label>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {timeLog ? 'Update' : 'Save'} Entry
        </Button>
      </div>
    </form>
  );
}
