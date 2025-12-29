interface LoadingStateProps {
  label?: string
}

export function LoadingState({ label = "Loading…" }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-muted/60 bg-muted/20 px-6 py-12 text-center">
      <span className="h-10 w-10 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
    </div>
  )
}


