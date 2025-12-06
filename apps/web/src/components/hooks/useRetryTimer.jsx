import { useState, useEffect, useCallback } from 'react';

/**
 * A reusable hook for auto-retry logic with exponential backoff
 * 
 * @param {boolean} shouldRetry - Whether retries should be active
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} baseDelayMs - Base delay in milliseconds between retries (default: 500)
 * @returns {{ retryCount: number, reset: () => void, isRetrying: boolean }}
 */
export function useRetryTimer(shouldRetry = false, maxRetries = 3, baseDelayMs = 500) {
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!shouldRetry || retryCount >= maxRetries) {
      return;
    }

    // Faster exponential backoff: 500ms, 1s, 2s
    const delay = baseDelayMs * Math.pow(2, retryCount);
    
    const timer = setTimeout(() => {
      setRetryCount(prev => prev + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [shouldRetry, retryCount, maxRetries, baseDelayMs]);

  const reset = useCallback(() => {
    setRetryCount(0);
  }, []);

  const isRetrying = shouldRetry && retryCount > 0 && retryCount < maxRetries;

  return {
    retryCount,
    reset,
    isRetrying,
  };
}