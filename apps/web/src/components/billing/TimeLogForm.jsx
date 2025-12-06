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
import { useDebounce } from '../hooks/useDebounce';
import { getDefaultHourlyRate, validateTimeLogForm } from './timeLogHelpers';

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

  const { data: projects = [], isLoading: isLoadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => base44.entities.Project.list(),
  });

  const { data: billingSettings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => base44.entities.BillingSettings.list().then(res => res[0]),
  });

  const selectedProject = projects.find(p => p.id === formData.project_id);
  const [hourlyRate, setHourlyRate] = useState(timeLog?.hourly_rate || 0);
  const [validationErrors, setValidationErrors] = useState([]);

  const debouncedHours = useDebounce(formData.hours, 500);

  useEffect(() => {
    const defaultRate = getDefaultHourlyRate(timeLog, selectedProject, billingSettings);
    if (defaultRate !== hourlyRate) {
      setHourlyRate(defaultRate);
    }
  }, [timeLog, selectedProject, billingSettings]);

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
    
    const validation = validateTimeLogForm(formData, hourlyRate);
    if (!validation.isValid) {
      setValidationErrors(validation.errors);
      return;
    }
    
    setValidationErrors([]);
    
    const increment = billingSettings?.time_increment_minutes || 6;
    const rawMinutes = (parseFloat(formData.hours) || 0) * 60;
    const roundedMinutes = Math.ceil(rawMinutes / increment) * increment;
    const roundedHours = roundedMinutes / 60;
    const finalTotalAmount = roundedHours * (parseFloat(hourlyRate) || 0);

    mutation.mutate({
      ...formData,
      date: format(formData.date, 'yyyy-MM-dd'),
      hours: roundedHours,
      hourly_rate: hourlyRate,
      total_amount: finalTotalAmount,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {validationErrors.length > 0 && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          <ul className="list-disc list-inside">
            {validationErrors.map((error, idx) => (
              <li key={idx}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="project">Project *</Label>
        <Select
          value={formData.project_id}
          onValueChange={(value) => setFormData({ ...formData, project_id: value })}
          required
          disabled={isLoadingProjects}
        >
          <SelectTrigger id="project" data-testid="project-select">
            <SelectValue placeholder={isLoadingProjects ? "Loading projects..." : "Select a project"} />
          </SelectTrigger>
          <SelectContent>
            {isLoadingProjects ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
              </div>
            ) : projects.length === 0 ? (
              <div className="py-4 text-center text-sm text-slate-500">No projects found</div>
            ) : (
              projects.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.project_name}</SelectItem>
              ))
            )}
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
            data-testid="hours-input"
            type="number"
            step="0.01"
            min="0.01"
            value={formData.hours}
            onChange={(e) => setFormData({ ...formData, hours: parseFloat(e.target.value) || 0 })}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="hourlyRate">Hourly Rate</Label>
          <Input
            id="hourlyRate"
            data-testid="hourly-rate-input"
            type="number"
            step="0.01"
            min="0"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(parseFloat(e.target.value) || 0)}
            disabled={mutation.isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="totalAmount">Total Amount</Label>
          <div className="flex items-center h-10 px-3 py-2 border border-slate-200 bg-slate-50 rounded-md text-sm font-medium text-slate-700">
            ${displayTotalAmount.toFixed(2)}
          </div>
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