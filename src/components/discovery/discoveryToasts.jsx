/**
 * Toast helper functions for discovery operations
 * All toasts auto-dismiss after 3 seconds
 */

const AUTO_DISMISS_DELAY = 3000;

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
      title: 'Deep Search in Progress',
      description: 'AI is analyzing your profile and searching across 1000+ funding sources. This may take 30-60 seconds.',
    });
  } else {
    toast({
      title: 'Searching...',
      description: 'Looking for matching opportunities...',
    });
  }
}

export function toastECFStart(toast) {
  toast({
    title: 'Discovering ECF Services',
    description: 'Searching for local benefits and services for ECF CHOICES participants...',
  });
}

/**
 * Build a profile-aware zero-result description.
 * profileGaps is an object with optional booleans: missingLocation, missingEntityType, missingKeywords.
 */
export function buildZeroResultDescription(profileGaps = {}) {
  const { missingLocation, missingEntityType, missingKeywords } = profileGaps;
  if (missingLocation) {
    return 'No results found. Add your location (state or ZIP) to find state and local programs.';
  }
  if (missingEntityType) {
    return 'No results found. Tell us who you are (individual, nonprofit, business) to see relevant grants.';
  }
  if (missingKeywords) {
    return 'No results found in this view. If this profile is thin, add focus areas; otherwise rerun discovery or open the profile funding sources already saved by Crawler OS.';
  }
  return 'No results found in this view. Try rerunning profile discovery, opening saved profile sources, or asking Anya for alternate search language.';
}

export function toastSuccess(toast, count, searchName, profileGaps) {
  toast({
    title: searchName === 'comprehensive' ? 'Deep Search Complete' : 'Discovery Complete',
    description: count > 0
      ? `Found ${count} matching opportunities.`
      : buildZeroResultDescription(profileGaps),
  });
}

export function toastECFSuccess(toast, count) {
  toast({
    title: 'ECF Services Discovered',
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
