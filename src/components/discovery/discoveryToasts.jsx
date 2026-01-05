/**
 * Toast helper functions for discovery operations
 * All toasts auto-dismiss after 3 seconds
 */

const AUTO_DISMISS_DELAY = 3000;

export function showNoProfileToast(toast) {
  const toastInstance = toast({
    variant: 'destructive',
    title: 'No Profile Selected',
    description: 'Please select a profile to discover opportunities for.',
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
}

export function showECFErrorToast(toast) {
  const toastInstance = toast({
    variant: 'destructive',
    title: 'Not an ECF CHOICES Profile',
    description: 'This search template is only for ECF CHOICES participants. Please select an ECF CHOICES profile or choose a different search template.',
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
}

export function toastSearchStart(toast, isComprehensive) {
  let toastInstance;
  
  if (isComprehensive) {
    toastInstance = toast({
      title: '🔍 Deep Search in Progress...',
      description: 'AI is analyzing your profile and searching across 1000+ funding sources. This may take 30-60 seconds...',
    });
  } else {
    toastInstance = toast({
      title: '🔍 Searching...',
      description: 'Looking for matching opportunities...',
    });
  }
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
  
  return toastInstance;
}

export function toastECFStart(toast) {
  const toastInstance = toast({
    title: '🔍 Discovering ECF Services...',
    description: 'Searching for local benefits and services for ECF CHOICES participants...',
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
  
  return toastInstance;
}

export function toastSuccess(toast, count, searchName) {
  const toastInstance = toast({
    title: searchName === 'comprehensive' ? '✅ Deep Search Complete' : '✨ Discovery Complete',
    description: count > 0 
      ? `Found ${count} matching opportunities.`
      : 'No opportunities found matching your criteria.',
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
}

export function toastECFSuccess(toast, count) {
  const toastInstance = toast({
    title: '✅ ECF Services Discovered',
    description: `Found ${count} services and benefits available in your area.`,
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
}

export function toastError(toast, errorMessage) {
  const message = errorMessage instanceof Error ? errorMessage.message : String(errorMessage);
  
  const toastInstance = toast({
    variant: 'destructive',
    title: 'Discovery Failed',
    description: message || 'An error occurred while searching for opportunities.',
  });
  
  // Auto-dismiss after delay
  setTimeout(() => {
    if (toastInstance && toastInstance.dismiss) {
      toastInstance.dismiss();
    }
  }, AUTO_DISMISS_DELAY);
}