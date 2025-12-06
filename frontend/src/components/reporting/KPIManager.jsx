import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Plus, Target, TrendingUp, TrendingDown, Edit, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function KPIManager({ grant }) {
  const [showForm, setShowForm] = useState(false);
  const [editingKPI, setEditingKPI] = useState(null);
  const queryClient = useQueryClient();

  const { data: kpis } = useQuery({
    queryKey: ['kpis', grant.id],
    queryFn: () => base44.entities.GrantKPI.filter({ grant_id: grant.id })
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editingKPI) {
        return await base44.entities.GrantKPI.update(editingKPI.id, data);
      }
      return await base44.entities.GrantKPI.create({ ...data, grant_id: grant.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kpis'] });
      queryClient.invalidateQueries({ queryKey: ['allKPIs'] });
      setShowForm(false);
      setEditingKPI(null);
      toast.success(editingKPI ? 'KPI updated' : 'KPI created');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.GrantKPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kpis'] });
      queryClient.invalidateQueries({ queryKey: ['allKPIs'] });
      toast.success('KPI deleted');
    }
  });

  const getStatusColor = (status) => {
    const colors = {
      on_track: 'bg-green-100 text-green-800',
      at_risk: 'bg-yellow-100 text-yellow-800',
      behind: 'bg-red-100 text-red-800',
      exceeded: 'bg-blue-100 text-blue-800',
      not_started: 'bg-slate-100 text-slate-800'
    };
    return colors[status] || colors.not_started;
  };

  const calculateProgress = (kpi) => {
    if (kpi.kpi_type !== 'numeric' && kpi.kpi_type !== 'percentage') return null;
    const current = parseFloat(kpi.current_value) || 0;
    const target = parseFloat(kpi.target_value) || 1;
    return Math.min(Math.round((current / target) * 100), 100);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-600" />
              Key Performance Indicators
            </CardTitle>
            <Dialog open={showForm} onOpenChange={setShowForm}>
              <DialogTrigger asChild>
                <Button onClick={() => setEditingKPI(null)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add KPI
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{editingKPI ? 'Edit' : 'Add'} KPI</DialogTitle>
                </DialogHeader>
                <KPIForm
                  kpi={editingKPI}
                  onSave={(data) => saveMutation.mutate(data)}
                  onCancel={() => {
                    setShowForm(false);
                    setEditingKPI(null);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {kpis && kpis.length > 0 ? (
              kpis.map((kpi) => {
                const progress = calculateProgress(kpi);
                return (
                  <div key={kpi.id} className="p-4 border border-slate-200 rounded-lg bg-white">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <h4 className="font-semibold text-slate-900">{kpi.kpi_name}</h4>
                        <p className="text-xs text-slate-600 capitalize">{kpi.category} • {kpi.measurement_frequency}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={getStatusColor(kpi.status)}>
                          {kpi.status.replace(/_/g, ' ')}
                        </Badge>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setEditingKPI(kpi);
                            setShowForm(true);
                          }}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteMutation.mutate(kpi.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-3 gap-4 mb-2">
                      <div>
                        <p className="text-xs text-slate-600">Target</p>
                        <p className="text-sm font-semibold">{kpi.target_value} {kpi.unit}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-600">Current</p>
                        <p className="text-sm font-semibold">{kpi.current_value || '0'} {kpi.unit}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-600">Last Updated</p>
                        <p className="text-sm">{kpi.last_updated ? new Date(kpi.last_updated).toLocaleDateString() : 'N/A'}</p>
                      </div>
                    </div>

                    {progress !== null && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-slate-600">Progress</span>
                          <span className="text-xs font-semibold">{progress}%</span>
                        </div>
                        <Progress value={progress} className="h-2" />
                      </div>
                    )}

                    {kpi.notes && (
                      <p className="text-xs text-slate-600 mt-2 italic">{kpi.notes}</p>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="text-center py-8 text-slate-500">
                <Target className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p>No KPIs defined yet</p>
                <Button onClick={() => setShowForm(true)} className="mt-3" variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  Add First KPI
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KPIForm({ kpi, onSave, onCancel }) {
  const [formData, setFormData] = useState(kpi || {
    kpi_name: '',
    kpi_type: 'numeric',
    category: 'output',
    target_value: '',
    current_value: '',
    unit: '',
    measurement_frequency: 'monthly',
    status: 'not_started',
    notes: ''
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(formData); }} className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="col-span-2">
          <Label>KPI Name *</Label>
          <Input
            value={formData.kpi_name}
            onChange={(e) => setFormData({...formData, kpi_name: e.target.value})}
            placeholder="e.g., Students Served"
            required
          />
        </div>

        <div>
          <Label>Type</Label>
          <Select value={formData.kpi_type} onValueChange={(value) => setFormData({...formData, kpi_type: value})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="numeric">Numeric</SelectItem>
              <SelectItem value="percentage">Percentage</SelectItem>
              <SelectItem value="yes_no">Yes/No</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="date">Date</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Category</Label>
          <Select value={formData.category} onValueChange={(value) => setFormData({...formData, category: value})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="output">Output</SelectItem>
              <SelectItem value="outcome">Outcome</SelectItem>
              <SelectItem value="impact">Impact</SelectItem>
              <SelectItem value="participant">Participant</SelectItem>
              <SelectItem value="financial">Financial</SelectItem>
              <SelectItem value="timeline">Timeline</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Target Value</Label>
          <Input
            value={formData.target_value}
            onChange={(e) => setFormData({...formData, target_value: e.target.value})}
            placeholder="100"
          />
        </div>

        <div>
          <Label>Current Value</Label>
          <Input
            value={formData.current_value}
            onChange={(e) => setFormData({...formData, current_value: e.target.value})}
            placeholder="50"
          />
        </div>

        <div>
          <Label>Unit</Label>
          <Input
            value={formData.unit}
            onChange={(e) => setFormData({...formData, unit: e.target.value})}
            placeholder="students, hours, dollars"
          />
        </div>

        <div>
          <Label>Measurement Frequency</Label>
          <Select value={formData.measurement_frequency} onValueChange={(value) => setFormData({...formData, measurement_frequency: value})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="annually">Annually</SelectItem>
              <SelectItem value="one-time">One-time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Status</Label>
          <Select value={formData.status} onValueChange={(value) => setFormData({...formData, status: value})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="not_started">Not Started</SelectItem>
              <SelectItem value="on_track">On Track</SelectItem>
              <SelectItem value="at_risk">At Risk</SelectItem>
              <SelectItem value="behind">Behind</SelectItem>
              <SelectItem value="exceeded">Exceeded</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2">
          <Label>Notes</Label>
          <Textarea
            value={formData.notes}
            onChange={(e) => setFormData({...formData, notes: e.target.value})}
            rows={3}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">Save KPI</Button>
      </div>
    </form>
  );
}