import React, { useState } from 'react';

/**
 * SmartMatcher - Smart matching component with robust error handling
 * 
 * Features:
 * - Robust error handling with detailed logging
 * - Retry logic for transient 5xx errors
 * - User-friendly error messages
 * - Disabled UI during requests
 */

const SmartMatcher = ({ baseUrl, organizationId, onMatchComplete, onError }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  /**
   * Call the tsForOrganization API endpoint
   * @param {string} orgId - Organization ID
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<Object>} - API response
   */
  const callTsForOrganization = async (orgId, retryCount = 0) => {
    const url = `${baseUrl}/api/apps/tsForOrganization`;
    
    console.log(`[SmartMatcher] Calling tsForOrganization for org: ${orgId} (attempt ${retryCount + 1})`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: orgId
        })
      });

      // Handle non-OK responses
      if (!response.ok) {
        const statusCode = response.status;
        let errorBody = '';
        let errorJson = null;

        try {
          // Try to get response body as text
          errorBody = await response.text();
          
          // Try to parse as JSON if possible
          try {
            errorJson = JSON.parse(errorBody);
          } catch (jsonError) {
            // Not JSON, use text body
          }
        } catch (bodyError) {
          console.error('[SmartMatcher] Could not read error response body:', bodyError);
        }

        // Log detailed error information for debugging
        console.error('[SmartMatcher] API Error:', {
          status: statusCode,
          statusText: response.statusText,
          body: errorBody,
          json: errorJson
        });

        // Retry once for 5xx errors (server errors)
        if (statusCode >= 500 && statusCode < 600 && retryCount === 0) {
          console.log('[SmartMatcher] Server error detected, retrying once...');
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          return callTsForOrganization(orgId, retryCount + 1);
        }

        // Create user-friendly error message
        let userMessage = 'An error occurred while matching.';
        if (statusCode >= 500) {
          userMessage = 'Server error occurred. Please try again later.';
        } else if (statusCode === 404) {
          userMessage = 'Organization not found.';
        } else if (statusCode === 400) {
          userMessage = errorJson?.message || 'Invalid request. Please check your data.';
        } else if (statusCode === 401 || statusCode === 403) {
          userMessage = 'You do not have permission to perform this action.';
        }

        throw new Error(userMessage);
      }

      // Parse successful response
      const data = await response.json();
      console.log('[SmartMatcher] API call successful:', data);
      
      return data;

    } catch (error) {
      // If it's our thrown error, re-throw it
      if (error.message && (
        error.message.includes('occurred') || 
        error.message.includes('not found') ||
        error.message.includes('permission')
      )) {
        throw error;
      }

      // Network or other errors
      console.error('[SmartMatcher] Request failed:', error);
      throw new Error('Network error. Please check your connection and try again.');
    }
  };

  /**
   * Handle run button click
   */
  const handleRun = async () => {
    if (!organizationId) {
      setError('Organization ID is required');
      return;
    }

    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const data = await callTsForOrganization(organizationId);
      setResult(data);
      
      if (onMatchComplete && typeof onMatchComplete === 'function') {
        onMatchComplete(data);
      }
    } catch (err) {
      const errorMessage = err.message || 'An unexpected error occurred';
      setError(errorMessage);
      
      if (onError && typeof onError === 'function') {
        onError(err);
      }
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="smart-matcher">
      <div className="smart-matcher-controls">
        <button
          onClick={handleRun}
          disabled={isRunning || !organizationId}
          className="smart-matcher-run-button"
          style={{
            padding: '8px 16px',
            backgroundColor: isRunning ? '#ccc' : '#007bff',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: isRunning ? 'not-allowed' : 'pointer'
          }}
        >
          {isRunning ? 'Running...' : 'Run Smart Matcher'}
        </button>
      </div>

      {error && (
        <div className="smart-matcher-error" style={{
          padding: '12px',
          marginTop: '12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          borderRadius: '4px',
          color: '#c33'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className="smart-matcher-result" style={{
          padding: '12px',
          marginTop: '12px',
          backgroundColor: '#efe',
          border: '1px solid #cfc',
          borderRadius: '4px',
          color: '#363'
        }}>
          <strong>Success!</strong> Match completed.
          {result.matches && (
            <div style={{ marginTop: '8px' }}>
              Found {result.matches.length} matches
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SmartMatcher;
