import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Upload, Link as LinkIcon, Info, CheckCircle, FileWarning } from 'lucide-react';

/**
 * Input mode tabs for file upload or URL entry
 */
export default function InputModeTabs({ 
  inputMode, 
  onModeChange, 
  file, 
  onFileChange, 
  url, 
  onUrlChange,
  disabled,
  error,
  documentType = 'grant',
  onDocumentTypeChange
}) {
  return (
    <div>
      {onDocumentTypeChange && (
        <div className="mb-4">
          <Label className="text-base font-semibold mb-3 block">Document Type</Label>
          <Tabs value={documentType} onValueChange={onDocumentTypeChange} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="grant" disabled={disabled}>
                <Upload className="w-4 h-4 mr-2" />
                Grant / Scholarship
              </TabsTrigger>
              <TabsTrigger value="debt" disabled={disabled}>
                <FileWarning className="w-4 h-4 mr-2" />
                Debt Letter
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}
      
      <Label className="text-base font-semibold mb-3 block">Choose Input Method</Label>
      <Tabs value={inputMode} onValueChange={onModeChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="file" disabled={disabled} title="Upload a PDF file">
            <Upload className="w-4 h-4 mr-2" />
            Upload PDF
          </TabsTrigger>
          <TabsTrigger value="url" disabled={disabled} title="Enter a webpage URL">
            <LinkIcon className="w-4 h-4 mr-2" />
            Enter URL
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="file" className="mt-4">
          <Alert className="mb-4 border-blue-200 bg-blue-50">
            <Info className="h-4 w-4 text-blue-600" />
            <AlertTitle className="text-blue-900">PDF Files Only</AlertTitle>
            <AlertDescription className="text-blue-800">
              Currently, only PDF documents are supported. If you have a Word document (.docx), please convert it to PDF first.
            </AlertDescription>
          </Alert>
          
          <div className="border-2 border-dashed rounded-xl p-8 text-center hover:border-blue-300 transition-colors">
            <input
              type="file"
              id="file-upload"
              className="hidden"
              accept=".pdf,application/pdf"
              onChange={onFileChange}
              disabled={disabled}
              aria-label="Upload PDF file"
              required={inputMode === 'file'}
            />
            <label
              htmlFor="file-upload"
              className="cursor-pointer flex flex-col items-center"
            >
              {file ? (
                <>
                  <CheckCircle className="w-8 h-8 text-emerald-500 mb-2" />
                  <p className="text-slate-800 font-medium">{file.name}</p>
                  <p className="text-xs text-slate-400 mt-1">Click to change file</p>
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-slate-400 mb-2"/>
                  <p className="text-slate-500">Click to select a PDF file</p>
                  <p className="text-xs text-slate-400 mt-1">Only PDF format supported</p>
                </>
              )}
            </label>
          </div>

          {error && inputMode === 'file' && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </TabsContent>
        
        <TabsContent value="url" className="mt-4">
          <Alert className="mb-4 border-green-200 bg-green-50">
            <Info className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-900">URL Processing</AlertTitle>
            <AlertDescription className="text-green-800">
              Enter the direct URL to a grant opportunity webpage. The AI will fetch and extract information from the page.
            </AlertDescription>
          </Alert>
          
          <div className="space-y-2">
            <Label htmlFor="url-input">Grant Opportunity URL</Label>
            <Input
              id="url-input"
              type="url"
              placeholder="https://example.com/grant-opportunity"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              disabled={disabled}
              className="text-base h-12"
              aria-label="Enter grant opportunity URL"
              required={inputMode === 'url'}
            />
            <p className="text-xs text-slate-500">
              Enter a complete URL including http:// or https://
            </p>
          </div>

          {error && inputMode === 'url' && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}