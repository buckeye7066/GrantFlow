import { cn } from '@/lib/utils'

export default function AuthShell({ title, subtitle, children, className }) {
  return (
    <div className={cn('min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-4 py-12', className)}>
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        <div className="rounded-2xl border border-border bg-card text-card-foreground shadow-sm p-6">
          {children}
        </div>
      </div>
    </div>
  )
}
