import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Download, FileText, FileSpreadsheet, Play, Plus, X } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Badge } from '@/components/ui/badge';

/**
 * Custom Report Builder - User-defined criteria and export
 */
export default function CustomReportBuilder({ grants, organizations }) {
  const [reportName, setReportName] = useState('');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [selectedOrgs, setSelectedOrgs] = useState([]);
  const [selectedFunderTypes, setSelectedFunderTypes] = useState([]);
  const [amountRange, setAmountRange] = useState({ min: '', max: '' });
  const [includeFields, setIncludeFields] = useState([
    'title', 'funder', 'status', 'deadline', 'award_ceiling', 'organization'
  ]);
  
  const { toast } = useToast();

  const statuses = [
    { value: 'discovered', label: 'Discovered' },
    { value: 'interested', label: 'Interested' },
    { value: 'drafting', label: 'Drafting' },
    { value: 'application_prep', label: 'Application Prep' },
    { value: 'submitted', label: 'Submitted' },
    { value: 'awarded', label: 'Awarded' },
    { value: 'declined', label: 'Declined' },
    { value: 'closed', label: 'Closed' }
  ];

  const funderTypes = [
    'federal', 'state', 'local', 'foundation', 'corporate', 
    'university', 'nonprofit', 'medical', 'community', 'other'
  ];

  const availableFields = [
    { value: 'title', label: 'Grant Title' },
    { value: 'funder', label: 'Funder Name' },
    { value: 'funder_type', label: 'Funder Type' },
    { value: 'status', label: 'Status' },
    { value: 'deadline', label: 'Deadline' },
    { value: 'award_floor', label: 'Award Minimum' },
    { value: 'award_ceiling', label: 'Award Maximum' },
    { value: 'match_score', label: 'Match Score' },
    { value: 'organization', label: 'Organization' },
    { value: 'created_date', label: 'Created Date' },
    { value: 'ai_status', label: 'AI Status' },
    { value: 'url', label: 'URL' }
  ];

  const filteredGrants = useMemo(() => {
    return grants.filter(grant => {
      // Date range filter
      if (dateRange.start) {
        const grantDate = new Date(grant.created_date);
        const startDate = new Date(dateRange.start);
        if (grantDate < startDate) return false;
      }
      if (dateRange.end) {
        const grantDate = new Date(grant.created_date);
        const endDate = new Date(dateRange.end);
        if (grantDate > endDate) return false;
      }

      // Status filter
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(grant.status)) {
        return false;
      }

      // Organization filter
      if (selectedOrgs.length > 0 && !selectedOrgs.includes(grant.organization_id)) {
        return false;
      }

      // Funder type filter
      if (selectedFunderTypes.length > 0 && !selectedFunderTypes.includes(grant.funder_type)) {
        return false;
      }

      // Amount range filter
      const amount = grant.award_ceiling || grant.award_floor || 0;
      if (amountRange.min && amount < parseInt(amountRange.min)) return false;
      if (amountRange.max && amount > parseInt(amountRange.max)) return false;

      return true;
    });
  }, [grants, dateRange, selectedStatuses, selectedOrgs, selectedFunderTypes, amountRange]);

  const generateCSV = () => {
    const headers = includeFields.map(field => 
      availableFields.find(f => f.value === field)?.label || field
    );

    const rows = filteredGrants.map(grant => {
      const org = organizations.find(o => o.id === grant.organization_id);
      return includeFields.map(field => {
        if (field === 'organization') return org?.name || '';
        if (field === 'award_floor' || field === 'award_ceiling') {
          return grant[field] ? `$${grant[field].toLocaleString()}` : '';
        }
        return grant[field] || '';
      });
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportName || 'grant-report'}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: '✅ Report Downloaded',
      description: `${filteredGrants.length} grants exported to CSV`,
    });
  };

  const generatePDF = () => {
    const reportHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${reportName || 'Grant Report'}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; }
          h1 { color: #1e293b; border-bottom: 3px solid #3b82f6; padding-bottom: 10px; }
          .meta { color: #64748b; margin-bottom: 30px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th { background: #f1f5f9; padding: 12px; text-align: left; border-bottom: 2px solid #cbd5e1; }
          td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
          tr:hover { background: #f8fafc; }
          .footer { margin-top: 40px; color: #94a3b8; font-size: 12px; }
        </style>
      </head>
      <body>
        <h1>${reportName || 'Grant Report'}</h1>
        <div class="meta">
          <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Total Grants:</strong> ${filteredGrants.length}</p>
        </div>
        <table>
          <thead>
            <tr>
              ${includeFields.map(field => {
                const fieldLabel = availableFields.find(f => f.value === field)?.label || field;
                return `<th>${fieldLabel}</th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${filteredGrants.map(grant => {
              const org = organizations.find(o => o.id === grant.organization_id);
              return `<tr>
                ${includeFields.map(field => {
                  let value = grant[field] || '';
                  if (field === 'organization') value = org?.name || '';
                  if (field === 'award_floor' || field === 'award_ceiling') {
                    value = grant[field] ? `$${grant[field].toLocaleString()}` : '';
                  }
                  return `<td>${value}</td>`;
                }).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="footer">
          <p>Generated by GrantFlow - Grant Management System</p>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(reportHTML);
    printWindow.document.close();
    printWindow.focus();
    
    setTimeout(() => {
      printWindow.print();
    }, 250);

    toast({
      title: '📄 Report Generated',
      description: 'Report opened in new window for printing/saving',
    });
  };

  const toggleStatus = (status) => {
    setSelectedStatuses(prev => 
      prev.includes(status) 
        ? prev.filter(s => s !== status)
        : [...prev, status]
    );
  };

  const toggleOrg = (orgId) => {
    setSelectedOrgs(prev => 
      prev.includes(orgId) 
        ? prev.filter(id => id !== orgId)
        : [...prev, orgId]
    );
  };

  const toggleFunderType = (type) => {
    setSelectedFunderTypes(prev => 
      prev.includes(type) 
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const toggleField = (field) => {
    setIncludeFields(prev => 
      prev.includes(field) 
        ? prev.filter(f => f !== field)
        : [...prev, field]
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom Report Builder</CardTitle>
          <CardDescription>
            Configure filters and generate custom reports
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Report Name */}
          <div>
            <Label>Report Name</Label>
            <Input
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              placeholder="e.g., Q4 2024 Federal Grants"
              className="mt-2"
            />
          </div>

          {/* Date Range */}
          <div>
            <Label>Date Range</Label>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <Input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                placeholder="Start date"
              />
              <Input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                placeholder="End date"
              />
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <Label>Status</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {statuses.map(status => (
                <Badge
                  key={status.value}
                  variant={selectedStatuses.includes(status.value) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => toggleStatus(status.value)}
                >
                  {status.label}
                </Badge>
              ))}
            </div>
          </div>

          {/* Organization Filter */}
          {organizations.length > 0 && (
            <div>
              <Label>Organizations</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {organizations.map(org => (
                  <Badge
                    key={org.id}
                    variant={selectedOrgs.includes(org.id) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleOrg(org.id)}
                  >
                    {org.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Funder Type Filter */}
          <div>
            <Label>Funder Types</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {funderTypes.map(type => (
                <Badge
                  key={type}
                  variant={selectedFunderTypes.includes(type) ? 'default' : 'outline'}
                  className="cursor-pointer capitalize"
                  onClick={() => toggleFunderType(type)}
                >
                  {type}
                </Badge>
              ))}
            </div>
          </div>

          {/* Amount Range */}
          <div>
            <Label>Award Amount Range</Label>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <Input
                type="number"
                value={amountRange.min}
                onChange={(e) => setAmountRange({ ...amountRange, min: e.target.value })}
                placeholder="Minimum"
              />
              <Input
                type="number"
                value={amountRange.max}
                onChange={(e) => setAmountRange({ ...amountRange, max: e.target.value })}
                placeholder="Maximum"
              />
            </div>
          </div>

          {/* Fields to Include */}
          <div>
            <Label>Include Fields</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-2">
              {availableFields.map(field => (
                <div key={field.value} className="flex items-center gap-2">
                  <Checkbox
                    checked={includeFields.includes(field.value)}
                    onCheckedChange={() => toggleField(field.value)}
                  />
                  <span className="text-sm">{field.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Results Preview */}
          <div className="pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Results: {filteredGrants.length} grants
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {includeFields.length} fields selected
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={generateCSV}
                  disabled={filteredGrants.length === 0}
                  variant="outline"
                >
                  <FileSpreadsheet className="w-4 h-4 mr-2" />
                  Export CSV
                </Button>
                <Button
                  onClick={generatePDF}
                  disabled={filteredGrants.length === 0}
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Generate PDF
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}