import React, { useState, useEffect } from 'react';

/**
 * Dashboard - Main dashboard page with defensive error handling
 * 
 * Features:
 * - Defer backend app ID fetch via requestIdleCallback
 * - Surface inline errors gracefully instead of console noise
 */

const Dashboard = () => {
  const [appConfig, setAppConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    /**
     * Fetch backend app configuration
     */
    const fetchBackendConfig = async () => {
      try {
        // This would be the actual API call
        // For now, we'll simulate it
        const response = await fetch('/api/config/app', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch app config: ${response.status} ${response.statusText}`);
        }

        const config = await response.json();
        setAppConfig(config);
        setConfigError(null);
      } catch (error) {
        console.error('[Dashboard] Backend config fetch failed:', error);
        setConfigError(error.message || 'Failed to load application configuration');
      } finally {
        setIsLoading(false);
      }
    };

    // Defer backend config fetch using requestIdleCallback or setTimeout
    const deferredFetch = () => {
      if (typeof window !== 'undefined') {
        if (window.requestIdleCallback) {
          window.requestIdleCallback(() => {
            fetchBackendConfig();
          }, { timeout: 2000 });
        } else {
          setTimeout(() => {
            fetchBackendConfig();
          }, 100);
        }
      }
    };

    deferredFetch();
  }, []);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Dashboard</h1>
      </div>

      <div className="dashboard-content">
        {configError && (
          <div className="dashboard-config-error" style={{
            padding: '12px',
            marginBottom: '16px',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px',
            color: '#856404'
          }}>
            <strong>Configuration Error:</strong> {configError}
            <div style={{ marginTop: '8px', fontSize: '0.9em' }}>
              Some features may not be available. Please try refreshing the page.
            </div>
          </div>
        )}

        {isLoading && !configError && (
          <div className="dashboard-loading" style={{
            padding: '12px',
            marginBottom: '16px',
            color: '#666'
          }}>
            Loading configuration...
          </div>
        )}

        {appConfig && (
          <div className="dashboard-info" style={{
            padding: '12px',
            marginBottom: '16px',
            backgroundColor: '#e7f3ff',
            border: '1px solid '#b3d9ff',
            borderRadius: '4px',
            color: '#004085'
          }}>
            <strong>App ID:</strong> {appConfig.appId || 'Not configured'}
          </div>
        )}

        <div className="dashboard-main">
          <p>Welcome to GrantFlow Dashboard</p>
          {/* Add more dashboard content here */}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
