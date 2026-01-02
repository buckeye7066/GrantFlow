import { Component } from "react"
import { Button } from "@/components/ui/button"

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    if (typeof this.props.onError === "function") {
      this.props.onError(error, info)
    }
  }

  handleReset = () => {
    if (typeof this.props.onReset === "function") {
      this.props.onReset()
    }
    this.setState({ hasError: false })
    if (typeof window !== "undefined") {
      window.location.href = this.props.fallbackHref ?? window.location.origin
    }
  }

  render() {
    if (this.state.hasError) {
      const message = this.props.fallbackMessage ?? "Something went wrong."
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">We hit a snag</h1>
          <p className="max-w-md text-slate-600">{message}</p>
          <Button onClick={this.handleReset}>Reload</Button>
        </div>
      )
    }

    return this.props.children
  }
}
