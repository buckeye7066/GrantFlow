
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import client from '@/api/client';
import { Upload, FileText, Loader2, CheckCircle2, X } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger'

export default function UploadApplicationForm({ onSuccess, onCancel, existingOrganizationId = null }) {
  const [file, setFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('UploadApplicationForm'), [])

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      // Check file type - ONLY IMAGES
      const validTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/heic',
        'image/heif'
      ];
      const validExtensions = ['.jpg', '.jpeg', '.png', '.heic', '.heif'];
      const fileName = selectedFile.name.toLowerCase();
      const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));

      if (!validTypes.includes(selectedFile.type) && !hasValidExtension) {
        setFile(null);
        toast({
          variant: 'destructive',
          title: 'Invalid File Type',
          description: 'Please upload an image file (JPG, PNG, or HEIC). PDF files are not supported - please scan or photograph your form as an image instead.',
        });
        return;
      }

      // Check file size (max 50MB)
      if (selectedFile.size > 50 * 1024 * 1024) {
        setFile(null);
        toast({
          variant: 'destructive',
          title: 'File Too Large',
          description: 'File must be less than 50MB.',
        });
        return;
      }

      setFile(selectedFile);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!file) {
      toast({
        variant: 'destructive',
        title: 'No File Selected',
        description: 'Please select a file to upload.',
      });
      return;
    }

    setIsUploading(true);

    try {
      // Step 1: Upload file
      toast({
        title: '📄 Uploading File...',
        description: 'Uploading your completed application form.',
      });

      const uploadResult = await client.integrations.Core.UploadFile({ file });
      const file_url = uploadResult?.file_url;

      if (!file_url || typeof file_url !== 'string' || file_url.trim() === '') {
        throw new Error('Upload succeeded but no file URL was returned. Cannot proceed with processing.');
      }

      setIsUploading(false);
      setIsProcessing(true);

      // Step 2: Process with AI
      toast({
        title: '🤖 Processing Application...',
        description: 'AI is extracting information from your form. This may take 30-60 seconds.',
      });

      const response = await client.functions.invoke('processScannedApplication', {
        file_url,
        organization_id: existingOrganizationId,
      });

      log.debug('processScannedApplication response received');

      if (!response || !response.data) {
        throw new Error('No response received from processScannedApplication. The server may be unavailable.');
      }

      if (response.data.success) {
        toast({
          title: '✅ Application Processed!',
          description: response.data.message,
        });
        
        onSuccess(response.data.organization);
      } else {
        // Display the detailed error from the function
        const errorMsg = response.data.error || 'Failed to process application';
        const errorDetails = response.data.details || '';
        
        throw new Error(errorDetails ? `${errorMsg}: ${errorDetails}` : errorMsg);
      }

    } catch (error) {
      console.error('[UploadApplicationForm] Processing error:', error);
      
      // Extract detailed error message
      let errorMessage = 'Could not process the application. Please try again or enter information manually.';
      let errorDetails = '';
      
      if (error.response?.data) {
        const data = error.response.data;
        if (typeof data === 'string') {
          errorMessage = data;
        } else if (data.error) {
          errorMessage = data.error;
          errorDetails = data.details || '';
        } else if (data.message) {
          errorMessage = data.message;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      toast({
        variant: 'destructive',
        title: 'Processing Failed',
        description: errorDetails ? `${errorMessage}\n\n${errorDetails}` : errorMessage,
        duration: 10000, // Show for 10 seconds so user can read it
      });
    } finally {
      setIsUploading(false);
      setIsProcessing(false);
    }
  };

  const isLoading = isUploading || isProcessing;

  return (
    <Card className="shadow-xl border-0">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Upload Completed Application</CardTitle>
          <CardDescription>
            {existingOrganizationId 
              ? 'Upload a completed application form to update this profile'
              : 'Upload a completed application form to create a new profile'
            }
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onCancel} disabled={isLoading}>
          <X className="w-5 h-5" />
        </Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Alert className="bg-blue-50 border-blue-200">
            <FileText className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-800">
              <strong>Accepted formats:</strong> Image files only (JPG, PNG, HEIC)
              <br />
              <strong>Important:</strong> Please scan or photograph your completed paper form as an image. PDF files are not supported.
            </AlertDescription>
          </Alert>

          <div>
            <Label htmlFor="application-file">Select Completed Application Form</Label>
            <div className="mt-2">
              <label 
                htmlFor="application-file" 
                className="flex flex-col items-center justify-center w-full h-40 border-2 border-slate-300 border-dashed rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors"
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  {file ? (
                    <>
                      <CheckCircle2 className="w-10 h-10 mb-3 text-green-600" />
                      <p className="font-semibold text-green-700">{file.name}</p>
                      <p className="text-sm text-slate-500 mt-1">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </>
                  ) : (
                    <>
                      <Upload className="w-10 h-10 mb-3 text-slate-400" />
                      <p className="mb-2 text-sm text-slate-500">
                        <span className="font-semibold">Click to upload</span> or drag and drop
                      </p>
                      <p className="text-xs text-slate-500">
                        JPG, PNG, or HEIC (Max 50MB)
                      </p>
                    </>
                  )}
                </div>
                <Input
                  id="application-file"
                  type="file"
                  className="hidden"
                  onChange={handleFileChange}
                  accept="image/jpeg,image/jpg,image/png,image/heic,image/heif"
                  disabled={isLoading}
                />
              </label>
            </div>
          </div>

          {isProcessing && (
            <Alert className="bg-purple-50 border-purple-200">
              <Loader2 className="h-4 w-4 text-purple-600 animate-spin" />
              <AlertDescription className="text-purple-800">
                <strong>AI is processing your application...</strong>
                <br />
                This usually takes 30-60 seconds. Please wait while we extract all the information from your form.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!file || isLoading}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {isUploading ? 'Uploading...' : 'Processing...'}
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Process Application
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
