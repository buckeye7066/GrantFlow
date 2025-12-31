import React from "react"
import { Sparkles } from "lucide-react"

export default function PageStub({ title, description, icon: Icon = Sparkles, children }) {
  return (
    <section className="p-6 md:p-10">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-3">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 tracking-tight">
            {title}
          </h1>
          <p className="text-slate-600 leading-relaxed max-w-2xl">
            {description}
          </p>
        </header>

        <div className="rounded-3xl border border-dashed border-slate-300/80 bg-white/70 shadow-sm backdrop-blur-sm p-8">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-blue-50 p-3 shadow-inner">
              <Icon className="w-8 h-8 text-blue-600" strokeWidth={1.75} />
            </div>
            <div className="space-y-4 text-slate-700">
              {children ?? (
                <p className="text-slate-600">
                  This workspace is being rebuilt to match the latest GrantFlow experience.
                  Track progress in the project board and let us know if you need a specific workflow prioritised.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
