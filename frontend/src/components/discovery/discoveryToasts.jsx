/**
 * Toast helper functions for discovery operations
 */

export function showNoProfileToast(toast) {
  toast({
    variant: 'destructive',
    title: 'No Profile Selected',
    description: 'Please select a profile to discover opportunities for.',
  });
}

export function showECFErrorToast(toast) {
  toast({
    variant: 'destructive',
    title: 'Not an ECF CHOICES Profile',
    description: 'This search template is only for ECF CHOICES participants. Please select an ECF CHOICES profile or choose a different search template.',
  });
}

export function toastSearchStart(toast, isComprehensive) {
  if (isComprehensive) {
    toast({
      title: '🔍 Deep Search in Progress...',
      description: 'AI is analyzing your profile and searching across 1000+ funding sources. This may take 30-60 seconds...',
    });
  } else {
    toast({
      title: '🔍 Searching...',
      description: 'Looking for matching opportunities...',
    });
  }
}

export function toastECFStart(toast) {
  toast({
    title: '🔍 Discovering ECF Services...',
    description: 'Searching for local benefits and services for ECF CHOICES participants...',
  });
}

export function toastSuccess(toast, count, searchName) {
  toast({
    title: searchName === 'comprehensive' ? '✅ Deep Search Complete' : '✨ Discovery Complete',
    description: count > 0 
      ? `Found ${count} matching opportunities.`
      : 'No opportunities found matching your criteria.',
  });
}

export function toastECFSuccess(toast, count) {
  toast({
    title: '✅ ECF Services Discovered',
    description: `Found ${count} services and benefits available in your area.`,
  });
}

export function toastError(toast, errorMessage) {
  const message = errorMessage instanceof Error ? errorMessage.message : String(errorMessage);
  
  toast({
    variant: 'destructive',
    title: 'Discovery Failed',
    description: message || 'An error occurred while searching for opportunities.',
  });
}