import React from "react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"
import { maybeReloadForStaleChunk, looksLikeStaleChunkError } from "@/utils/lazyWithRetry"
import { captureFrontendException } from "@/utils/observability.js"
import { reportClientError } from "@/utils/reportClientError.js"

const MAX_RETRIES = 3

// "The user is on an old deploy and asked for a chunk that no longer matches
// the current build" — solved by reloading to pick up the new index.html. This
// predicate is the single shared choke point in lazyWithRetry (a hand-kept copy
// here previously drifted and missed the `.default` shape, sending a recoverable
// stale-deploy crash straight to an owner-facing 500). When it matches, the
// right CTA is "Reload to get the latest version" rather than "Try Again".
const isStaleChunkError = looksLikeStaleChunkError

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
    // dedupe with lazyWithRetry, so we never loop). Returns true only when a
    // reload was actually triggered; false if we already reloaded once (chunk
    // is genuinely gone) or it's not a stale-chunk error at all.
    const staleChunk = isStaleChunkError(error)
    const reloadingForStaleChunk = staleChunk && maybeReloadForStaleChunk(error)

    // Keep this log — it's the primary breadcrumb when users report "blank screen".
    captureFrontendException(error, {
      area: 'route_boundary',
      route: this.props.routeName ?? null,
      errorCount: newCount,
      stale_chunk: staleChunk,
      auto_reloading: reloadingForStaleChunk,
      requestId: error?.requestId ?? error?.request_id ?? null,
      componentStack: info?.componentStack,
    })

    // Email the owner an analyzed report (non-admin users only; self-skips for
    // admins server-side) — but NOT when we're auto-recovering with a reload.
    // A stale-deploy crash that a single reload fixes is invisible to the user
    // and must not page the owner; we only alert if the reload didn't resolve
    // it (recentlyReloaded → reloadingForStaleChunk is false).
    if (!reloadingForStaleChunk) {
      reportClientError(error, { componentStack: info?.componentStack })
    }

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
