import React from "react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"
import { maybeReloadForStaleChunk } from "@/utils/lazyWithRetry"

const MAX_RETRIES = 3

// Errors that mean "the user is on an old deploy and asked for a chunk
// that no longer exists" — solved by reloading to pick up the new
// index.html. The lazyWithRetry helper already auto-reloads once;
// anything that bubbles up to the boundary means that auto-reload was
// already attempted and failed (or the error came from a non-lazy
// dynamic import). Either way, the right CTA is "Reload to get the
// latest version" rather than "Try Again", which would just refail.
function isStaleChunkError(error) {
  const msg = String(error?.message ?? error ?? '')
  const name = String(error?.name ?? '')
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /MIME type/i.test(msg) ||
    /ChunkLoadError/i.test(name)
  )
}

export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorCount: 0 }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    const newCount = (this.state.errorCount || 0) + 1
    this.setState({ errorCount: newCount })

    // Auto-recover from a stale-deploy chunk: try exactly one reload (shared
    // dedupe with lazyWithRetry, so we never loop). If we already reloaded
    // once, fall through to the manual "Reload to update" CTA below.
    if (isStaleChunkError(error)) {
      maybeReloadForStaleChunk(error)
    }

    // Keep this log — it's the primary breadcrumb when users report "blank screen".
    console.error("[RouteErrorBoundary] route crash", {
      route: this.props.routeName ?? null,
      message: error?.message,
      errorCount: newCount,
      stale_chunk: isStaleChunkError(error),
      requestId: error?.requestId ?? error?.request_id ?? null,
      stack: error?.stack,
      componentStack: info?.componentStack,
    })
  }

  handleRetry = () => {
    if (this.state.errorCount >= MAX_RETRIES) return
    this.setState({ hasError: false, error: null })
  }

  handleHardReload = () => {
    // Clear the lazyWithRetry dedupe stamp so the next reload is allowed
    // to retry any lazy chunks if they fail again.
    try { sessionStorage.removeItem('grantflow:lazy-reload-ts') } catch { /* ignore */ }
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const routeLabel = this.props.routeName ? ` on ${this.props.routeName}` : ""
    const requestId = this.state.error?.requestId ?? this.state.error?.request_id ?? null
    const exhaustedRetries = this.state.errorCount >= MAX_RETRIES
    const staleChunk = isStaleChunkError(this.state.error)

    if (staleChunk) {
      return (
        <div className="p-6 md:p-10">
          <Alert>
            <AlertDescription>
              GrantFlow updated while this page was open. Reload to pick up
              the latest version — your work in this tab is safe.
            </AlertDescription>
          </Alert>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={this.handleHardReload}>Reload to update</Button>
            <Button asChild variant="outline">
              <Link to={createPageUrl("Dashboard")}>Back to Dashboard</Link>
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div className="p-6 md:p-10">
        <Alert variant="destructive">
          <AlertDescription>
            Something went wrong{routeLabel}.
            {exhaustedRetries
              ? " This page crashed multiple times. Please try clearing your browser cache or contact support."
              : " You can reload the page or return to your dashboard."}
            {requestId ? (
              <span className="mt-2 block text-xs text-slate-100">
                Request ID: <span className="font-mono">{requestId}</span>
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
        <div className="mt-4 flex flex-wrap gap-3">
          {!exhaustedRetries && (
            <Button onClick={this.handleRetry}>Try Again</Button>
          )}
          <Button onClick={this.handleHardReload}>
            {exhaustedRetries ? "Force Reload" : "Reload"}
          </Button>
          <Button asChild variant="outline">
            <Link to={createPageUrl("Dashboard")}>Back to Dashboard</Link>
          </Button>
        </div>
      </div>
    )
  }
}
