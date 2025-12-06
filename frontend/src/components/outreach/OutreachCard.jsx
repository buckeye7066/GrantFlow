import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Mail,
  Phone,
  Calendar,
  CheckCircle2,
  Clock,
  AlertTriangle,
  TrendingUp,
  MessageSquare,
  ExternalLink,
  Copy,
  Send,
  Edit,
  Trash2
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/use-toast';

export default function OutreachCard({ outreach, onEdit, onDelete, onSend, onCopy }) {
  const { toast } = useToast();

  const statusConfig = {
    draft: { icon: Edit, color: 'bg-slate-100 text-slate-700', text: 'Draft' },
    ready_to_send: { icon: Send, color: 'bg-blue-100 text-blue-700', text: 'Ready' },
    sent: { icon: Mail, color: 'bg-purple-100 text-purple-700', text: 'Sent' },
    opened: { icon: Mail, color: 'bg-indigo-100 text-indigo-700', text: 'Opened' },
    replied: { icon: MessageSquare, color: 'bg-green-100 text-green-700', text: 'Replied' },
    follow_up_needed: { icon: Clock, color: 'bg-amber-100 text-amber-700', text: 'Follow Up' },
    closed_won: { icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-700', text: 'Won' },
    closed_lost: { icon: AlertTriangle, color: 'bg-red-100 text-red-700', text: 'Lost' }
  };

  const priorityColors = {
    low: 'bg-slate-100 text-slate-600',
    medium: 'bg-blue-100 text-blue-700',
    high: 'bg-amber-100 text-amber-700',
    urgent: 'bg-red-100 text-red-700'
  };

  const typeConfig = {
    inquiry: { label: 'Inquiry', icon: MessageSquare },
    letter_of_inquiry: { label: 'LOI', icon: Mail },
    pre_proposal: { label: 'Pre-Proposal', icon: Mail },
    application_notification: { label: 'Notification', icon: Send },
    thank_you: { label: 'Thank You', icon: Mail },
    progress_update: { label: 'Update', icon: TrendingUp },
    follow_up: { label: 'Follow-Up', icon: Clock },
    relationship_building: { label: 'Relationship', icon: MessageSquare }
  };

  const status = statusConfig[outreach.status] || statusConfig.draft;
  const StatusIcon = status.icon;
  const typeInfo = typeConfig[outreach.outreach_type] || typeConfig.inquiry;
  const TypeIcon = typeInfo.icon;

  const handleCopyMessage = () => {
    const fullMessage = `Subject: ${outreach.subject_line}\n\n${outreach.message_body}`;
    navigator.clipboard.writeText(fullMessage);
    
    toast({
      title: '📋 Copied to Clipboard',
      description: 'Message copied. Ready to paste into your email client.',
    });
    
    if (onCopy) onCopy(outreach);
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg mb-2 flex items-center gap-2">
              <TypeIcon className="w-5 h-5 text-blue-600 shrink-0" />
              <span className="truncate">{outreach.funder_name}</span>
            </CardTitle>
            
            <div className="flex flex-wrap gap-2 mb-2">
              <Badge className={status.color}>
                <StatusIcon className="w-3 h-3 mr-1" />
                {status.text}
              </Badge>
              
              <Badge variant="outline">{typeInfo.label}</Badge>
              
              <Badge className={priorityColors[outreach.priority]}>
                {outreach.priority}
              </Badge>
              
              {outreach.ai_generated && (
                <Badge variant="outline" className="bg-purple-50 text-purple-700">
                  ✨ AI-Generated
                </Badge>
              )}
              
              {outreach.success_probability >= 70 && (
                <Badge className="bg-green-100 text-green-700">
                  {outreach.success_probability}% Success
                </Badge>
              )}
            </div>
            
            {outreach.funder_contact_name && (
              <p className="text-sm text-slate-600">
                Contact: {outreach.funder_contact_name}
              </p>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-3">
        {outreach.subject_line && (
          <div className="p-3 bg-slate-50 rounded-lg">
            <p className="text-xs text-slate-500 font-semibold mb-1">Subject:</p>
            <p className="text-sm font-medium text-slate-900">{outreach.subject_line}</p>
          </div>
        )}
        
        {outreach.message_body && (
          <div className="p-3 bg-white border rounded-lg max-h-32 overflow-y-auto">
            <p className="text-sm text-slate-700 whitespace-pre-wrap">
              {outreach.message_body.substring(0, 200)}
              {outreach.message_body.length > 200 && '...'}
            </p>
          </div>
        )}
        
        <div className="flex items-center gap-4 text-xs text-slate-500">
          {outreach.sent_date && (
            <div className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Sent {(() => {
                try {
                  const date = new Date(outreach.sent_date);
                  return isNaN(date.getTime()) ? 'Invalid date' : format(date, 'MMM d, yyyy');
                } catch {
                  return 'Invalid date';
                }
              })()}
            </div>
          )}
          
          {outreach.follow_up_date && outreach.status === 'follow_up_needed' && (
            <div className="flex items-center gap-1 text-amber-600 font-semibold">
              <Clock className="w-3 h-3" />
              Follow up {(() => {
                try {
                  const date = new Date(outreach.follow_up_date);
                  return isNaN(date.getTime()) ? 'Invalid date' : format(date, 'MMM d');
                } catch {
                  return 'Invalid date';
                }
              })()}
            </div>
          )}
          
          {outreach.communication_method && (
            <div className="flex items-center gap-1">
              {outreach.communication_method === 'email' && <Mail className="w-3 h-3" />}
              {outreach.communication_method === 'phone' && <Phone className="w-3 h-3" />}
              {outreach.communication_method}
            </div>
          )}
        </div>
        
        {outreach.response_summary && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
            <p className="text-xs text-emerald-700 font-semibold mb-1">Response Received:</p>
            <p className="text-sm text-emerald-900">{outreach.response_summary}</p>
          </div>
        )}
        
        <div className="flex gap-2 pt-2">
          <Button
            onClick={handleCopyMessage}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            <Copy className="w-4 h-4 mr-1" />
            Copy
          </Button>
          
          <Button
            onClick={() => onEdit(outreach)}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            <Edit className="w-4 h-4 mr-1" />
            Edit
          </Button>
          
          {outreach.status === 'ready_to_send' && onSend && (
            <Button
              onClick={() => onSend(outreach)}
              size="sm"
              className="flex-1 bg-blue-600 hover:bg-blue-700"
            >
              <Send className="w-4 h-4 mr-1" />
              Send
            </Button>
          )}
          
          <Button
            onClick={() => onDelete(outreach)}
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}