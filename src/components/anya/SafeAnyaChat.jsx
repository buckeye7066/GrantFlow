import React from 'react'

import AnyaChat from './AnyaChat.jsx'

class AnyaChatErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('[SafeAnyaChat] Anya panel render failed', error, info)
  }

  componentDidUpdate(previousProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false })
    }
  }

  handleRetry = () => {
    this.setState({ failed: false })
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="rounded-xl border border-slate-200 bg-white/90 p-4 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-300"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-purple-600 to-blue-600">
              <img src="/images/anya-avatar.svg" alt="Anya" className="h-full w-full object-cover" />
            </div>
            <div className="font-semibold text-slate-800 dark:text-slate-100">
              Anya is temporarily unavailable
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            The rest of GrantFlow is still working. Retry Anya without refreshing the whole page.
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Retry Anya
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default function SafeAnyaChat(props) {
  const resetKey = [
    props.profileId ?? 'no-profile',
    props.initialSessionOptions?.resumeSessionId ?? 'new-session',
  ].join(':')

  return (
    <AnyaChatErrorBoundary resetKey={resetKey}>
      <AnyaChat {...props} />
    </AnyaChatErrorBoundary>
  )
}

export { AnyaChatErrorBoundary }
