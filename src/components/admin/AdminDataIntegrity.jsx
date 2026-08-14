import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Database, AlertTriangle, CheckCircle2, RefreshCw, Wrench, ShieldAlert, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function AdminDataIntegrity() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const fetchData = async () => {
    try {
      setRefreshing(true);
      const res = await apiFetch('/api/admin/data-integrity');
      setData(res);
    } catch (err) {
      console.error('Failed to fetch data integrity', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRepairAll = async () => {
    setRepairing(true);
    try {
      const res = await apiFetch('/api/admin/repair-all-profiles', { method: 'POST' });
      toast({ title: 'Repair complete', description: res.message });
      fetchData();
    } catch (err) {
      toast({ title: 'Repair failed', description: err.message, variant: 'destructive' });
    } finally {
      setRepairing(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center p-12"><Loader2 className="animate-spin h-8 w-8 text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">Data Integrity</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRepairAll} disabled={repairing}>
            {repairing ? <Loader2 className="animate-spin h-4 w-4 mr-2" /> : <Wrench className="w-4 h-4 mr-2" />}
            Repair All Profiles
          </Button>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-blue-600" /> Profiles Integrity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b border-slate-100">
              <span className="text-sm text-slate-600">Total Profiles</span>
              <span className="font-semibold">{data?.profiles?.total || 0}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-slate-100">
              <span className="text-sm text-slate-600">Missing Section Entries</span>
              <span className={`font-semibold ${data?.profiles?.missing_sections_count > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {data?.profiles?.missing_sections_count || 0}
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-slate-600">Profiles with Zero Data</span>
              <span className={`font-semibold ${data?.profiles?.profiles_with_no_sections > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                {data?.profiles?.profiles_with_no_sections || 0}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-600" /> Opportunities Integrity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b border-slate-100">
              <span className="text-sm text-slate-600">Total Opportunities</span>
              <span className="font-semibold">{data?.opportunities?.total || 0}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-slate-100">
              <span className="text-sm text-slate-600">Duplicate URLs</span>
              <span className={`font-semibold ${data?.opportunities?.duplicate_urls > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {data?.opportunities?.duplicate_urls || 0}
              </span>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-500 uppercase">Missing Critical Fields</p>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="bg-slate-50 p-2 rounded text-center">
                  <p className="text-[10px] text-slate-500">Titles</p>
                  <p className="font-bold">{data?.opportunities?.missing_fields?.missing_title || 0}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded text-center">
                  <p className="text-[10px] text-slate-500">Descriptions</p>
                  <p className="font-bold">{data?.opportunities?.missing_fields?.missing_description || 0}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded text-center">
                  <p className="text-[10px] text-slate-500">Agencies</p>
                  <p className="font-bold">{data?.opportunities?.missing_fields?.missing_agency || 0}</p>
                </div>
                <div className={`p-2 rounded text-center ${
                  (data?.opportunities?.missing_fields?.missing_application_url || 0) > 0
                    ? 'bg-red-50'
                    : 'bg-slate-50'
                }`}>
                  <p className={`text-[10px] font-semibold ${
                    (data?.opportunities?.missing_fields?.missing_application_url || 0) > 0
                      ? 'text-red-600'
                      : 'text-slate-500'
                  }`}>App URLs </p>
                  <p className={`font-bold ${
                    (data?.opportunities?.missing_fields?.missing_application_url || 0) > 0
                      ? 'text-red-700'
                      : ''
                  }`}>{data?.opportunities?.missing_fields?.missing_application_url || 0}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Loader2 is now imported from lucide-react above — local definition removed.
