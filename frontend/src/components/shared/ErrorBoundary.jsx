import React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

const safeIsDev = () => {
  if (typeof window === 'undefined') return false;
  const host = window.location?.hostname || '';
  return host === 'localhost' || host.includes('127.0.0.1');
};
const isDevelopment = safeIsDev();

// Shallow equality for resetKeys
function areArraysShallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * ErrorBoundary - React error boundary with optional callbacks and auto-reset
 * @param {Object} props
 * @param {React.ReactNode} props.children - Child components
 * @param {Function} props.onError - Called when error is caught
 * @param {Function} props.onReport - Optional external reporting hook
 * @param {Function} props.onReset - Called when boundary resets
 * @param {Array} props.resetKeys - Auto-reset when any value changes
 * @param {React.ReactNode} props.fallback - Custom fallback UI
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      lastResetKeys: props.resetKeys,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Keep original console logging for dev ergonomics
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);

    this.setState({ errorInfo });

    // Notify callbacks if provided
    try {
      if (typeof this.props.onError === 'function') {
        this.props.onError(error, errorInfo);
      }
    } catch {}
    try {
      if (typeof this.props.onReport === 'function') {
        this.props.onReport(error, errorInfo);
      }
    } catch {}
  }

  componentDidUpdate(prevProps) {
    // Auto-reset behavior: if any value in resetKeys changes, clear error state
    if (
      this.state.hasError &&
      this.props.resetKeys &&
      !areArraysShallowEqual(this.props.resetKeys, prevProps.resetKeys)
    ) {
      this.resetBoundary();
    }
  }

  handleReset = () => {
    this.resetBoundary();
  };

  resetBoundary() {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      lastResetKeys: this.props.resetKeys,
    });
    try {
      if (typeof this.props.onReset === 'function') {
        this.props.onReset();
      }
    } catch {}
  }

  toggleDetails = () => {
    this.setState((prevState) => ({ showDetails: !prevState.showDetails }));
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback takes precedence if provided
      if (this.props.fallback) return <>{this.props.fallback}</>;

      return (
        <Card
          className="border-red-500 bg-red-50"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              Component Error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-red-600">
              {isDevelopment
                ? 'Something went wrong while loading this section.'
                : 'An unexpected error occurred. Please try refreshing the page.'}
            </p>

            {isDevelopment && this.state.error && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={this.toggleDetails}
                  className="text-red-700 hover:text-red-800 hover:bg-red-100 p-0 h-auto font-normal"
                  aria-expanded={this.state.showDetails}
                  aria-controls="error-details"
                >
                  {this.state.showDetails ? (
                    <>
                      <ChevronUp className="w-4 h-4 mr-1" aria-hidden="true" />
                      Hide error details
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-4 h-4 mr-1" aria-hidden="true" />
                      Show error details
                    </>
                  )}
                </Button>

                {this.state.showDetails && (
                  <pre
                    id="error-details"
                    className="text-xs text-red-500 bg-red-100 p-3 rounded border border-red-200 overflow-auto max-h-48"
                  >
                    {String(this.state.error)}
                    {this.state.error?.stack && `\n\n${this.state.error.stack}`}
                    {this.state.errorInfo?.componentStack &&
                      `\n\nComponent stack:\n${this.state.errorInfo.componentStack}`}
                  </pre>
                )}
              </>
            )}
          </CardContent>
          <CardFooter>
            <Button
              onClick={this.handleReset}
              variant="outline"
              size="sm"
              className="border-red-300 text-red-700 hover:bg-red-100 hover:text-red-800"
              aria-label="Try again to reload this section"
            >
              <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
              Try again
            </Button>
          </CardFooter>
        </Card>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;