import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Printer, ExternalLink, Copy, Check } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * OpenPrintPreviewButton - Generic button to open print preview pages
 * 
 * Features:
 * - Opens print preview in new tab
 * - Handles popup blockers with fallback modal
 * - Shows loading state during operation
 * - Prevents double-clicks
 * - Provides copyable link as fallback
 * 
 * @param {Object} props
 * @param {string} props.path - Page path (e.g., 'PrintPipeline', 'PrintableApplication')
 * @param {Object} props.queryParams - Query parameters object (e.g., { orgId: "123" })
 * @param {string} props.label - Button label
 * @param {string} props.variant - Button variant from shadcn
 * @param {string} props.size - Button size
 * @param {string} props.className - Additional CSS classes
 * @param {Function} props.onBeforeOpen - Callback before opening (can return false to cancel)
 * @param {boolean} props.disabled - Whether button is disabled
 */
export default function OpenPrintPreviewButton({
  path,
  queryParams = {},
  label = 'Print Preview',
  variant = 'outline',
  size = 'default',
  className = '',
  onBeforeOpen,
  disabled = false
}) {
  const [isOpening, setIsOpening] = useState(false);
  const [showFallbackModal, setShowFallbackModal] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const { toast } = useToast();

  /**
   * Build the full URL with query parameters
   */
  const buildUrl = () => {
    // Convert query params object to query string
    const queryString = Object.entries(queryParams)
      .filter(([_, value]) => value != null) // Filter out null/undefined
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    
    const baseUrl = createPageUrl(path);
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  };

  /**
   * Handle opening the print preview
   */
  const handleOpen = async () => {
    // Prevent double-clicks
    if (isOpening || disabled) return;

    try {
      // Call onBeforeOpen callback if provided
      if (onBeforeOpen) {
        const shouldContinue = await onBeforeOpen();
        if (shouldContinue === false) return;
      }

      setIsOpening(true);
      
      // Build the URL
      const url = buildUrl();
      setPreviewUrl(url);

      // Track analytics event (optional - only if window.mixpanel exists)
      if (typeof window !== 'undefined' && window.mixpanel?.track) {
        window.mixpanel.track('Print Preview Opened', {
          page: path,
          params: queryParams
        });
      }

      // Attempt to open in new tab
      const newWindow = window.open(url, '_blank', 'noopener,noreferrer');

      // Check if popup was blocked
      if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
        console.warn('[OpenPrintPreviewButton] Popup blocked, showing fallback modal');
        setShowFallbackModal(true);
        
        toast({
          title: 'Popup Blocked',
          description: 'Please allow popups for this site, or use the link below.',
          variant: 'destructive'
        });
      } else {
        // Success - popup opened
        toast({
          title: '✓ Opening Print Preview',
          description: 'Print preview opened in new tab',
        });
      }
    } catch (error) {
      console.error('[OpenPrintPreviewButton] Error opening print preview:', error);
      
      // Show fallback modal on error
      setShowFallbackModal(true);
      
      toast({
        variant: 'destructive',
        title: 'Error Opening Preview',
        description: 'Could not open print preview. Please try the manual link below.',
      });
    } finally {
      // Reset loading state after a brief delay to show feedback
      setTimeout(() => {
        setIsOpening(false);
      }, 500);
    }
  };

  /**
   * Copy the preview URL to clipboard
   */
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(previewUrl);
      setLinkCopied(true);
      
      toast({
        title: '✓ Link Copied',
        description: 'Print preview link copied to clipboard',
      });

      // Reset copied state after 2 seconds
      setTimeout(() => {
        setLinkCopied(false);
      }, 2000);
    } catch (error) {
      console.error('[OpenPrintPreviewButton] Error copying link:', error);
      
      toast({
        variant: 'destructive',
        title: 'Copy Failed',
        description: 'Could not copy link. Please copy it manually.',
      });
    }
  };

  /**
   * Close fallback modal
   */
  const handleCloseFallback = () => {
    setShowFallbackModal(false);
    setLinkCopied(false);
  };

  return (
    <>
      <Button
        onClick={handleOpen}
        disabled={disabled || isOpening}
        variant={variant}
        size={size}
        className={className}
        title={`Open ${label} in new tab`}
        aria-label={`Open ${label}`}
      >
        {isOpening ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Opening...
          </>
        ) : (
          <>
            <Printer className="w-4 h-4 mr-2" />
            {label}
          </>
        )}
      </Button>

      {/* Fallback Modal for Popup Blockers */}
      <Dialog open={showFallbackModal} onOpenChange={handleCloseFallback}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Print Preview Link</DialogTitle>
            <DialogDescription>
              Your browser blocked the popup. You can copy the link below or open it manually.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* URL Display */}
            <div className="flex items-center gap-2">
              <div className="flex-1 p-3 bg-slate-50 rounded-lg border border-slate-200 overflow-x-auto">
                <code className="text-xs text-slate-700 break-all">
                  {previewUrl}
                </code>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button
                onClick={handleCopyLink}
                variant="outline"
                className="flex-1"
              >
                {linkCopied ? (
                  <>
                    <Check className="w-4 h-4 mr-2 text-green-600" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 mr-2" />
                    Copy Link
                  </>
                )}
              </Button>

              <Button
                onClick={() => {
                  window.location.href = previewUrl;
                }}
                className="flex-1"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open in This Tab
              </Button>
            </div>

            {/* Help Text */}
            <p className="text-xs text-slate-500 text-center">
              Tip: Allow popups for this site in your browser settings to avoid this step
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}