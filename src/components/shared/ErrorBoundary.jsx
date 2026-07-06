import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
import { captureFrontendException } from '@/utils/observability.js';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    captureFrontendException(error, {
      area: 'component_boundary',
      componentStack: errorInfo?.componentStack,
    });
    if (import.meta.env.DEV) {
      console.error("Uncaught error:", error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      // An explicit fallback (including null) wins — overlays like the guided
      // tour must vanish on error rather than replace themselves with an
      // error card in the middle of the app.
      if ('fallback' in this.props) {
        return this.props.fallback
      }
      return (
        <Card className="border-red-500 bg-red-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="w-5 h-5" />
              Component Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-600">Something went wrong while loading this section.</p>
            {this.state.error && (
                <pre className="text-xs text-red-500 mt-2 bg-red-100 p-2 rounded">
                    {this.state.error.toString()}
                </pre>
            )}
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
