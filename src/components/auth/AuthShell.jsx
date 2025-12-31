import { cn } from '@/lib/utils'

export default function AuthShell({ title, subtitle, children, className }) {
  return (
    <div className={cn('min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4 py-12', className)}>
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">{children}</div>
      </div>
    </div>
  )
}
