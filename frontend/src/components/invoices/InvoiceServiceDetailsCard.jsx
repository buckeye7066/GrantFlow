import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FileText } from 'lucide-react';

export default function InvoiceServiceDetailsCard({ 
  formData, 
  updateField,
  projects,
  selectedOrgId 
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Service Details
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="service_type">Service Type *</Label>
          <Select
            value={formData.service_type}
            onValueChange={(value) => updateField('service_type', value)}
            required
          >
            <SelectTrigger id="service_type">
              <SelectValue placeholder="Select service..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quick_scan">Quick Eligibility Scan</SelectItem>
              <SelectItem value="comprehensive_dossier">Comprehensive Funding Dossier</SelectItem>
              <SelectItem value="micro_grant">Micro/Assistance Grant Application</SelectItem>
              <SelectItem value="standard_foundation">Standard Foundation Application</SelectItem>
              <SelectItem value="complex_federal">Complex/Federal Application</SelectItem>
              <SelectItem value="scholarship_pack">Transfer Scholarship Pack</SelectItem>
              <SelectItem value="hourly_time">Hourly Time (from time log)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="service_description">Service Description</Label>
          <Textarea
            id="service_description"
            value={formData.service_description}
            onChange={(e) => updateField('service_description', e.target.value)}
            placeholder="Detailed description of services provided..."
            rows={3}
          />
        </div>

        <div>
          <Label htmlFor="project_id">Project (Optional)</Label>
          <Select
            value={formData.project_id}
            onValueChange={(value) => updateField('project_id', value)}
          >
            <SelectTrigger id="project_id">
              <SelectValue placeholder="Link to project..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={null}>No Project</SelectItem>
              {projects.filter(p => p.organization_id === selectedOrgId).map(project => (
                <SelectItem key={project.id} value={project.id}>{project.project_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="milestone_type">Milestone *</Label>
          <Select
            value={formData.milestone_type}
            onValueChange={(value) => updateField('milestone_type', value)}
            required
          >
            <SelectTrigger id="milestone_type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="kickoff">Kickoff - 40% (Scope Locked)</SelectItem>
              <SelectItem value="draft_delivery">Draft Delivery - 40%</SelectItem>
              <SelectItem value="final_submission">Final Submission - 20%</SelectItem>
              <SelectItem value="full_payment">Full Payment</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}