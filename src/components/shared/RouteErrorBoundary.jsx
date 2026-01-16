import React from "react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"

export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Keep this log — it’s the primary breadcrumb when users report “blank screen”.
    // eslint-disable-next-line no-console
    console.error("[RouteErrorBoundary] route crash", {
      route: this.props.routeName ?? null,
      message: error?.message,
      requestId: error?.requestId ?? error?.request_id ?? null,
      stack: error?.stack,
      componentStack: info?.componentStack,
    })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const routeLabel = this.props.routeName ? ` on ${this.props.routeName}` : ""
    const requestId = this.state.error?.requestId ?? this.state.error?.request_id ?? null

    return (
      <div className="p-6 md:p-10">
        <Alert variant="destructive">
          <AlertDescription>
            Something went wrong{routeLabel}. You can reload the page or return to your dashboard.
            {requestId ? (
              <span className="mt-2 block text-xs text-slate-200/90">
                Request ID: <span className="font-mono">{requestId}</span>
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button asChild variant="outline">
            <Link to={createPageUrl("Dashboard")}>Back to Dashboard</Link>
          </Button>
        </div>
      </div>
    )
  }
}

