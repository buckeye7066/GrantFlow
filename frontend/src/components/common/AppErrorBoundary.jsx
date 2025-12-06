import React from 'react';
import { AlertTriangle, RefreshCw, FileText } from 'lucide-react';

/**
 * Top-level error boundary for the entire application
 * Catches any unhandled errors and displays a user-friendly fallback UI
 */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0
    };
    
    // GLOBAL GUARD: Suppress browser extension errors
    if (typeof window !== 'undefined') {
      window.addEventListener('error', this.handleGlobalError);
      window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
    }
  }
  
  componentWillUnmount() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this.handleGlobalError);
      window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    }
  }
  
  // Filter out browser extension errors
  handleGlobalError = (event) => {
    const msg = event?.message || '';
    const src = event?.filename || '';
    
    // Ignore browser extension errors
    if (
      msg.includes('disconnected port') ||
      msg.includes('Extension context') ||
      msg.includes('chrome-extension://') ||
      msg.includes('moz-extension://') ||
      src.includes('chrome-extension://') ||
      src.includes('moz-extension://') ||
      src.includes('proxy.js') ||
      msg.includes('Script error') ||
      msg.includes('ResizeObserver loop')
    ) {
      event.preventDefault();
      console.debug('[AppErrorBoundary] Suppressed extension/proxy error:', msg.substring(0, 100));
      return;
    }
  };
  
  handleUnhandledRejection = (event) => {
    const reason = event?.reason?.message || String(event?.reason) || '';
    
    // Ignore browser extension promise rejections
    if (
      reason.includes('disconnected port') ||
      reason.includes('Extension context') ||
      reason.includes('chrome-extension://') ||
      reason.includes('moz-extension://')
    ) {
      event.preventDefault();
      console.debug('[AppErrorBoundary] Suppressed extension rejection:', reason.substring(0, 100));
      return;
    }
  };

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log the error to console for debugging
    console.error('🚨 [AppErrorBoundary] Uncaught error:', error);
    console.error('📍 Error message:', error?.message);
    console.error('📍 Error stack:', error?.stack);
    console.error('📚 Component stack:', errorInfo?.componentStack);
    
    this.setState(prevState => ({
      error,
      errorInfo,
      errorCount: prevState.errorCount + 1
    }));

    // Send error to monitoring service if available
    if (window.gtag) {
      try {
        window.gtag('event', 'exception', {
          description: error?.toString() || 'Unknown error',
          fatal: true
        });
      } catch (e) {
        console.error('[AppErrorBoundary] Failed to send error to gtag:', e);
      }
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      const isDevelopment = window.location.hostname === 'localhost' || 
                           window.location.hostname.includes('127.0.0.1') ||
                           window.location.hostname.includes('modal.host');

      const errorMessage = this.state.error?.message || 'An unexpected error occurred';
      const errorType = this.state.error?.name || 'Error';

      return (
        <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full bg-white rounded-xl shadow-2xl border-2 border-red-200 p-8">
            {/* Header */}
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 bg-red-100 rounded-full">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">
                  Application Error
                </h1>
                <p className="text-slate-600 mt-1">
                  GrantFlow encountered an unexpected error
                </p>
              </div>
            </div>

            {/* Error message */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <p className="text-red-800 font-medium mb-2">
                    {errorType}: {errorMessage}
                  </p>
                  {isDevelopment && this.state.error && (
                    <details className="mt-3">
                      <summary className="text-sm text-red-700 cursor-pointer hover:text-red-900 font-medium">
                        Show technical details (Development Mode)
                      </summary>
                      <div className="mt-3 space-y-2">
                        <div>
                          <p className="text-xs text-red-600 font-semibold mb-1">Error Stack:</p>
                          <pre className="text-xs bg-red-900 text-red-50 p-3 rounded overflow-auto max-h-64">
                            {this.state.error.stack}
                          </pre>
                        </div>
                        {this.state.errorInfo?.componentStack && (
                          <div>
                            <p className="text-xs text-red-600 font-semibold mb-1">Component Stack:</p>
                            <pre className="text-xs bg-red-900 text-red-50 p-3 rounded overflow-auto max-h-64">
                              {this.state.errorInfo.componentStack}
                            </pre>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </div>

            {/* Helpful suggestions */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-blue-900 mb-2">What you can try:</h3>
              <ul className="text-sm text-blue-800 space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-blue-600">•</span>
                  <span>Reload the page - this often fixes temporary issues</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-600">•</span>
                  <span>Clear your browser cache and cookies</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-600">•</span>
                  <span>Try accessing GrantFlow in a private/incognito window</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-600">•</span>
                  <span>Check your internet connection</span>
                </li>
              </ul>
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={this.handleReload}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                <RefreshCw className="w-5 h-5" />
                Reload Page
              </button>
              <button
                onClick={this.handleGoHome}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-medium transition-colors"
              >
                <FileText className="w-5 h-5" />
                Go to Dashboard
              </button>
              {isDevelopment && (
                <button
                  onClick={this.handleReset}
                  className="flex-1 px-6 py-3 bg-yellow-200 hover:bg-yellow-300 text-yellow-900 rounded-lg font-medium transition-colors"
                >
                  Try to Recover
                </button>
              )}
            </div>

            {/* Support info */}
            <div className="mt-6 pt-6 border-t border-slate-200">
              <p className="text-sm text-slate-600 text-center">
                If this problem persists, please contact support with the error details above.
              </p>
              {this.state.errorCount > 1 && (
                <p className="text-xs text-red-600 text-center mt-2 font-medium">
                  ⚠️ This error has occurred {this.state.errorCount} times
                </p>
              )}
              <p className="text-xs text-slate-500 text-center mt-2">
                Error ID: {new Date().toISOString()}
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default AppErrorBoundary;