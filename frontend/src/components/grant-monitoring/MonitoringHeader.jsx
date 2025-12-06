import React from 'react';
import { Bell, Play, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

/**
 * Grant monitoring page header with controls
 */
export default function MonitoringHeader({
  selectedOrgId,
  onSelectOrg,
  organizations,
  onCheckAlerts,
  isCheckingAlerts,
  onOpenSettings,
}) {
  return (
    <div className="mb-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-8 h-8 text-blue-600" />
            Grant Monitoring
          </h1>
          <p className="text-slate-600 mt-2">
            Automated tracking and alerts for your grant applications
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={selectedOrgId} onValueChange={onSelectOrg}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Organizations</SelectItem>
              {organizations.map(org => (
                <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            onClick={onCheckAlerts}
            disabled={isCheckingAlerts}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isCheckingAlerts ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking...</>
            ) : (
              <><Play className="w-4 h-4 mr-2" /> Check Alerts Now</>
            )}
          </Button>

          <Button
            variant="outline"
            onClick={onOpenSettings}
          >
            <Bell className="w-4 h-4 mr-2" />
            Alert Settings
          </Button>
        </div>
      </div>
    </div>
  );
}