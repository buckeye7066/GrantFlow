import React from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Sparkles, Star, Edit, Trash2, Loader2, Zap, FileText, Send } from 'lucide-react';

/**
 * Header component for grant detail page
 */
export default function GrantHeader({ 
  grant, 
  isAnalyzing, 
  onApplyWithAI, 
  onStarToggle, 
  onEdit, 
  onDelete,
  onWriteProposal,
  onStartWizard,
  onSubmit
}) {
  const navigate = useNavigate();

  const pipelineUrl = grant.organization_id 
    ? createPageUrl(`Pipeline?organization_id=${grant.organization_id}`)
    : createPageUrl('Pipeline');

  // getApplyButtonText and showApplyButton are removed as per new logic

  // Define bgClass based on original background and shadow, and new z-index
  const bgClass = "bg-white shadow-sm"; 

  return (
    <div className={`border-b border-slate-200 sticky top-16 z-10 ${bgClass}`}>
      <div className="max-w-7xl mx-auto p-4 md:p-6">
        <div> {/* This div wraps the back button, title, and funder */}
          <Button 
            variant="ghost" 
            onClick={() => navigate(pipelineUrl)} 
            className="flex items-center gap-2 mb-2 -ml-3"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Pipeline
          </Button>
          <h1 className="text-2xl font-bold text-slate-900 truncate" title={grant.title}>
            {grant.title}
          </h1>
          <p className="text-slate-600">from {grant.funder}</p>
        </div>
        
        <div className="flex flex-wrap gap-3 mt-4"> {/* This div wraps all action buttons */}
          {grant.status === 'discovered' && (
            <Button 
              onClick={onApplyWithAI} 
              disabled={isAnalyzing}
              className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  Apply with AI
                </>
              )}
            </Button>
          )}

          {['interested', 'drafting', 'application_prep'].includes(grant.status) && onWriteProposal && (
            <Button 
              onClick={onWriteProposal}
              className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              AI Grant Writer
            </Button>
          )}

          {/* Application Wizard Button */}
          {!['awarded', 'declined', 'closed', 'submitted'].includes(grant.status) && (
            <Button
              onClick={onStartWizard}
              variant="default"
              className="bg-purple-600 hover:bg-purple-700"
            >
              <FileText className="w-4 h-4 mr-2" />
              Application Wizard
            </Button>
          )}

          {/* Submit Button */}
          {!['awarded', 'declined', 'closed', 'submitted'].includes(grant.status) && onSubmit && (
            <Button
              onClick={onSubmit}
              className="bg-green-600 hover:bg-green-700"
            >
              <Send className="w-4 h-4 mr-2" />
              Submit
            </Button>
          )}

          {/* Existing buttons */}
          <Button 
            variant={grant.starred ? 'default' : 'outline'} 
            onClick={onStarToggle} 
            className="gap-2"
          >
            <Star className={`w-4 h-4 ${grant.starred ? 'text-yellow-400 fill-yellow-400' : ''}`} />
            {grant.starred ? 'Starred' : 'Star'}
          </Button>
          
          <Button variant="outline" onClick={onEdit}>
            <Edit className="w-4 h-4 mr-2" /> Edit
          </Button>
          
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 className="w-4 h-4 mr-2" /> Delete
          </Button>
        </div>
      </div>
    </div>
  );
}