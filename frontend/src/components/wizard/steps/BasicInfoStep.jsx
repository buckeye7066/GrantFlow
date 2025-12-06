import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Calendar, DollarSign, FileText, AlertCircle, Sparkles, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';

/**
 * Basic Information Step
 * Grant title, deadlines, requested amount, and project overview
 */
export default function BasicInfoStep({ data, onChange, grant, organization, errors }) {
  const [aiLoading, setAiLoading] = useState(false);

  // Auto-populate fields from grant and organization on mount
  useEffect(() => {
    const updates = {};
    
    // Auto-populate requested amount from grant's award ceiling
    if (!data.requested_amount && grant?.award_ceiling) {
      updates.requested_amount = grant.award_ceiling;
    }
    
    // Auto-populate contact name from organization
    if (!data.contact_name) {
      if (organization?.name && organization?.applicant_type !== 'organization') {
        // For individuals, use their name
        updates.contact_name = organization.name;
      }
    }
    
    // Auto-populate contact email from organization
    if (!data.contact_email && organization?.email) {
      updates.contact_email = organization.email;
    }
    
    if (Object.keys(updates).length > 0) {
      onChange(updates);
    }
  }, [grant?.award_ceiling, organization?.name, organization?.email, organization?.applicant_type]);

  const handleChange = (field, value) => {
    onChange({ [field]: value });
  };

  const handleAIAssist = async () => {
    setAiLoading(true);
    try {
      const prompt = `Write a concise executive summary (2-3 sentences, max 100 words) for a grant application with the following details:
      
Project Title: ${data.project_title || 'Not specified'}
Grant Opportunity: ${grant?.title || 'Not specified'}
Funder: ${grant?.funder || 'Not specified'}
Organization: ${organization?.name || 'Not specified'}
${organization?.mission ? `Organization Mission: ${organization.mission}` : ''}
Requested Amount: $${data.requested_amount || 'Not specified'}

Write a compelling summary that explains what this project will do and its impact. Be specific and professional.`;

      const response = await base44.integrations.Core.InvokeLLM({ prompt });
      handleChange('executive_summary', response);
    } catch (err) {
      console.error('AI assist error:', err);
    } finally {
      setAiLoading(false);
    }
  };

  // Calculate days until deadline
  const getDaysUntilDeadline = () => {
    if (!grant?.deadline) return null;
    if (grant.deadline.toLowerCase() === 'rolling') return 'Rolling';
    
    const deadline = new Date(grant.deadline);
    const today = new Date();
    const diffTime = deadline - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
  };

  const daysLeft = getDaysUntilDeadline();

  return (
    <div className="space-y-6">
      {/* Deadline Alert */}
      {typeof daysLeft === 'number' && (
        <Alert className={
          daysLeft <= 7 ? 'bg-red-50 border-red-300' :
          daysLeft <= 14 ? 'bg-amber-50 border-amber-300' :
          'bg-blue-50 border-blue-300'
        }>
          <Calendar className={`h-4 w-4 ${
            daysLeft <= 7 ? 'text-red-600' :
            daysLeft <= 14 ? 'text-amber-600' :
            'text-blue-600'
          }`} />
          <AlertDescription className={
            daysLeft <= 7 ? 'text-red-900' :
            daysLeft <= 14 ? 'text-amber-900' :
            'text-blue-900'
          }>
            <strong>Deadline:</strong> {daysLeft} days remaining
            {daysLeft <= 7 && ' - Please prioritize this application!'}
          </AlertDescription>
        </Alert>
      )}

      {/* Grant Information (Read-only) */}
      <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
        <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Grant Details
        </h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-slate-600">Funder</p>
            <p className="font-medium text-slate-900">{grant?.funder || 'N/A'}</p>
          </div>
          <div>
            <p className="text-slate-600">Deadline</p>
            <p className="font-medium text-slate-900">
              {grant?.deadline || 'Not specified'}
            </p>
          </div>
          {grant?.award_floor && (
            <div>
              <p className="text-slate-600">Award Range</p>
              <p className="font-medium text-slate-900">
                ${grant.award_floor.toLocaleString()} - ${grant.award_ceiling?.toLocaleString()}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Project Title */}
      <div>
        <Label>
          Project Title <span className="text-red-500">*</span>
        </Label>
        <p className="text-xs text-slate-500 mb-2">
          A clear, concise title that describes your project
        </p>
        <Input
          value={data.project_title || ''}
          onChange={(e) => handleChange('project_title', e.target.value)}
          placeholder={
            grant?.title?.toLowerCase().includes('music') || grant?.title?.toLowerCase().includes('concerto')
              ? "e.g., Concerto Competition Entry and Professional Development"
              : grant?.title?.toLowerCase().includes('scholarship')
              ? "e.g., Academic Year 2025-26 Educational Expenses"
              : "e.g., Community Health Outreach Program"
          }
          className={errors?.project_title ? 'border-red-500' : ''}
        />
        {errors?.project_title && (
          <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errors.project_title}
          </p>
        )}
      </div>

      {/* Requested Amount */}
      <div>
        <Label>
          Requested Amount <span className="text-red-500">*</span>
        </Label>
        <p className="text-xs text-slate-500 mb-2">
          Total funding requested (must be within grant's award range)
        </p>
        <div className="relative">
          <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            type="number"
            value={data.requested_amount || ''}
            onChange={(e) => handleChange('requested_amount', e.target.value)}
            placeholder="50000"
            className={`pl-10 ${errors?.requested_amount ? 'border-red-500' : ''}`}
          />
        </div>
        {errors?.requested_amount && (
          <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errors.requested_amount}
          </p>
        )}
        {grant?.award_ceiling && data.requested_amount && (
          <p className={`text-xs mt-1 ${
            parseFloat(data.requested_amount) > grant.award_ceiling
              ? 'text-red-600'
              : 'text-green-600'
          }`}>
            {parseFloat(data.requested_amount) > grant.award_ceiling
              ? '⚠️ Amount exceeds maximum award'
              : '✓ Amount within range'}
          </p>
        )}
      </div>

      {/* Project Period */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Project Start Date</Label>
          <Input
            type="date"
            value={data.project_start_date || ''}
            onChange={(e) => handleChange('project_start_date', e.target.value)}
          />
        </div>
        <div>
          <Label>Project End Date</Label>
          <Input
            type="date"
            value={data.project_end_date || ''}
            onChange={(e) => handleChange('project_end_date', e.target.value)}
          />
        </div>
      </div>

      {/* Executive Summary */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label>Executive Summary</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAIAssist}
            disabled={aiLoading || !data.project_title}
            className="gap-2"
          >
            {aiLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                AI Assist
              </>
            )}
          </Button>
        </div>
        <p className="text-xs text-slate-500 mb-2">
          A brief overview of your project (2-3 sentences)
        </p>
        <Textarea
          value={data.executive_summary || ''}
          onChange={(e) => handleChange('executive_summary', e.target.value)}
          placeholder="Provide a concise summary of what you're proposing..."
          rows={4}
        />
      </div>

      {/* Contact Person */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Contact Name</Label>
          <Input
            value={data.contact_name || ''}
            onChange={(e) => handleChange('contact_name', e.target.value)}
            placeholder="John Doe"
          />
        </div>
        <div>
          <Label>Contact Email</Label>
          <Input
            type="email"
            value={data.contact_email || ''}
            onChange={(e) => handleChange('contact_email', e.target.value)}
            placeholder="john@example.com"
          />
        </div>
      </div>
    </div>
  );
}