import React from 'react';
import OpenPrintPreviewButton from '@/components/shared/OpenPrintPreviewButton';

/**
 * PrintPipelineButton - Opens print preview for organization's grant pipeline
 * 
 * This is a specialized wrapper around OpenPrintPreviewButton for the pipeline use case.
 * 
 * @param {Object} props
 * @param {string} props.organizationId - ID of the organization
 * @param {string} props.organizationName - Name of the organization (for validation)
 * @param {string} props.label - Button label (default: "Print Pipeline")
 * @param {string} props.variant - Button variant
 * @param {string} props.size - Button size
 * @param {string} props.className - Additional CSS classes
 */
export default function PrintPipelineButton({
  organizationId,
  organizationName,
  label = 'Print Pipeline',
  variant = 'outline',
  size = 'default',
  className = ''
}) {
  /**
   * Validation before opening print preview
   */
  const handleBeforeOpen = () => {
    if (!organizationId) {
      console.error('[PrintPipelineButton] No organization ID provided');
      return false;
    }
    return true;
  };

  // Non-blocking sanitation for logging param
  const orgNameParam =
    typeof organizationName === 'string'
      ? organizationName.trim().slice(0, 200)
      : undefined;

  return (
    <OpenPrintPreviewButton
      path="PrintPipeline"
      // FIX: PrintPipeline expects "organizationId" (camelCase), not "organization_id"
      queryParams={{
        organizationId,
        ...(orgNameParam && { org_name: orgNameParam })
      }}
      label={label}
      variant={variant}
      size={size}
      className={className}
      onBeforeOpen={handleBeforeOpen}
    />
  );
}