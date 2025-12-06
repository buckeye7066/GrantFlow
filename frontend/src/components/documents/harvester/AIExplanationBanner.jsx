import React, { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sparkles, Shield, Info, ChevronDown, ChevronUp } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * AIExplanationBanner - Explains what AI does and data security
 */
export default function AIExplanationBanner() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      <Alert className="bg-purple-50 border-purple-200">
        <Sparkles className="h-4 w-4 text-purple-600" />
        <AlertDescription className="flex items-start justify-between">
          <div className="flex-1">
            <strong className="text-purple-900">How AI Helps:</strong>
            <p className="text-sm text-purple-800 mt-1">
              AI will extract all text from your document and append it to your profile's background data. 
              This helps improve future grant matching and application assistance.
            </p>
            
            {expanded && (
              <div className="mt-3 space-y-2 text-xs text-purple-700">
                <p><strong>What happens step-by-step:</strong></p>
                <ol className="list-decimal list-inside space-y-1 ml-2">
                  <li>Your file is securely uploaded to private storage</li>
                  <li>AI reads the document and extracts all text content</li>
                  <li>The extracted text is added to your profile under "Additional Data"</li>
                  <li>This enriched profile is used for better grant matching</li>
                </ol>
                
                <p className="mt-2"><strong>What AI extracts:</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>Full text content from PDFs and documents</li>
                  <li>Text recognized in images using OCR</li>
                  <li>Formatted paragraphs and sections</li>
                </ul>
              </div>
            )}
          </div>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="ml-2 text-purple-700 hover:text-purple-900"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </AlertDescription>
      </Alert>

      <Alert className="bg-green-50 border-green-200">
        <Shield className="h-4 w-4 text-green-600" />
        <AlertDescription className="text-sm text-green-800">
          <strong className="text-green-900">Your files are secure:</strong> Documents are stored in private, 
          encrypted storage and never shared with third parties. Only you can access your files.
        </AlertDescription>
      </Alert>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="link" size="sm" className="text-xs text-blue-600 hover:text-blue-700 p-0 h-auto">
            <Info className="w-3 h-3 mr-1" />
            Learn more about AI document processing
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI Document Processing Explained</DialogTitle>
            <DialogDescription>
              Understanding how AI helps with your grant applications
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-semibold text-slate-900 mb-2">How It Works</h4>
              <p className="text-slate-600">
                When you upload a document, our AI reads through the entire file and extracts all text content. 
                This includes text from PDFs, Word documents, and even text recognized in images.
              </p>
            </div>

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Why This Helps</h4>
              <ul className="list-disc list-inside space-y-1 text-slate-600">
                <li>Enriches your profile with comprehensive background information</li>
                <li>Enables better matching with relevant grant opportunities</li>
                <li>Provides context for AI-powered application assistance</li>
                <li>Saves you from manual data entry</li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Data Security</h4>
              <p className="text-slate-600">
                All files are stored in encrypted private storage with access restricted to your account only. 
                Files are never shared, sold, or used for any purpose outside of improving your grant search experience.
              </p>
            </div>

            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Best Documents to Upload</h4>
              <ul className="list-disc list-inside space-y-1 text-slate-600">
                <li>Resumes and CVs</li>
                <li>IRS determination letters (for nonprofits)</li>
                <li>Financial statements and audit reports</li>
                <li>Mission statements and program descriptions</li>
                <li>Letters of support or recommendation</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}