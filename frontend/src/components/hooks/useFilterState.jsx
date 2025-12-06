import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Hook to manage filter state with URL persistence
 * @param {Object} defaultFilters - Default filter values
 * @param {boolean} persistToUrl - Whether to persist filters to URL
 * @returns {Object} Filter state and handlers
 */
export function useFilterState(defaultFilters, persistToUrl = false) {
  const location = useLocation();
  const navigate = useNavigate();
  
  // Initialize from URL if persistence is enabled
  const getInitialFilters = useCallback(() => {
    if (!persistToUrl) return defaultFilters;
    
    const params = new URLSearchParams(location.search);
    const urlFilters = { ...defaultFilters };
    
    // Parse URL parameters
    Object.keys(defaultFilters).forEach(key => {
      const value = params.get(key);
      if (value !== null) {
        // Handle different data types
        if (Array.isArray(defaultFilters[key])) {
          urlFilters[key] = value.split(',').filter(v => v.length > 0);
        } else if (typeof defaultFilters[key] === 'boolean') {
          urlFilters[key] = value === 'true';
        } else if (typeof defaultFilters[key] === 'number') {
          urlFilters[key] = parseFloat(value);
        } else {
          urlFilters[key] = value;
        }
      }
    });
    
    return urlFilters;
  }, [defaultFilters, location.search, persistToUrl]);

  const [filters, setFilters] = useState(getInitialFilters);

  // Update URL when filters change
  useEffect(() => {
    if (!persistToUrl) return;
    
    const params = new URLSearchParams();
    
    Object.entries(filters).forEach(([key, value]) => {
      // Skip empty values
      if (value === '' || value === null || value === undefined) return;
      if (Array.isArray(value) && value.length === 0) return;
      if (typeof value === 'boolean' && !value) return;
      if (typeof value === 'number' && value === 0 && key !== 'matchScoreMin') return;
      
      // Serialize value
      if (Array.isArray(value)) {
        params.set(key, value.join(','));
      } else {
        params.set(key, String(value));
      }
    });
    
    const newSearch = params.toString();
    const currentSearch = location.search.slice(1); // Remove leading '?'
    
    if (newSearch !== currentSearch) {
      navigate(`${location.pathname}?${newSearch}`, { replace: true });
    }
  }, [filters, location.pathname, navigate, persistToUrl]);

  return { filters, setFilters };
}