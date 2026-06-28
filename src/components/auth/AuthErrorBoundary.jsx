import { Component } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { captureFrontendException } from '@/utils/observability.js'

/**
 * Error boundary component for catching authentication-related errors
 * Displays user-friendly error messages and provides recovery actions
 */
class AuthErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { 
      hasError: false, 
      error: null,
      errorInfo: null 
    }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    // Log the error to console for debugging
    console.error('[AuthErrorBoundary] Caught error:', error, errorInfo)
    captureFrontendException(error, {
      area: 'auth_boundary',
      componentStack: errorInfo?.componentStack,
    })
    
    this.setState({
      error,
      errorInfo
    })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    // Optionally reload the page to fully reset state
    if (this.props.onReset) {
      this.props.onReset()
    }
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[400px] items-center justify-center p-6">
          <div className="w-full max-w-md space-y-6">
            <div className="flex flex-col items-center space-y-4 text-center">
              <div className="rounded-full bg-rose-100 p-3">
                <AlertCircle className="h-8 w-8 text-rose-600" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-slate-900">
                  Authentication Error
                </h3>
                <p className="text-sm text-slate-600">
                  {this.getErrorMessage()}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <Button 
                onClick={this.handleReset} 
                className="w-full"
                variant="default"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Try Again
              </Button>
              
              <Button 
                onClick={this.handleReload} 
                className="w-full"
                variant="outline"
              >
                Reload Page
              </Button>
            </div>

            {import.meta.env.DEV && this.state.error && (
              <details className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs">
                <summary className="cursor-pointer font-semibold text-slate-700">
                  Technical Details
                </summary>
                <pre className="mt-2 overflow-auto text-slate-600">
                  {this.state.error.toString()}
                  {this.state.errorInfo && '\n' + this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }

  getErrorMessage() {
    const error = this.state.error
    
    // Check for specific error types
    if (error?.message?.includes('502') || error?.message?.includes('Bad Gateway')) {
      return 'The authentication server is temporarily unavailable. Please check that the backend is running and try again in a moment.'
    }
    
    if (error?.message?.includes('Network') || error?.message?.includes('Failed to fetch')) {
      return 'Unable to connect to the authentication server. Please check your internet connection and that the backend server is running.'
    }
    
    if (error?.message?.includes('provider not configured')) {
      return 'The authentication provider is not properly configured. Please contact your administrator.'
    }
    
    // Default error message
    return 'An unexpected error occurred during authentication. Please try again or contact support if the problem persists.'
  }
}

export default AuthErrorBoundary
