import { useState } from 'react'
import { Download, Printer, Save } from 'lucide-react'
import { useExperience } from '../contexts/ExperienceContext'

export default function Organizations() {
  const { markSaved, lastSavedLabel } = useExperience()
  const [notes, setNotes] = useState('')

  const handleSave = () => {
    markSaved()
  }

  const handlePrint = () => {
    window.print()
  }

  const handleExport = () => {
    window.print()
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <section className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Organizations</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Maintain organization profiles, notes, and funding eligibility details.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">Last saved: {lastSavedLabel}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            <Save className="h-4 w-4" aria-hidden />
            Save Profile (Ctrl+S)
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" aria-hidden />
            Print Profile
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Download className="h-4 w-4" aria-hidden />
            Export Profile PDF
          </button>
        </div>
      </section>

      <section className="space-y-6 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Profile Notes</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Jot quick notes about conversations, eligibility, and next steps. Everything you save here will be included when
          you print or export the profile.
        </p>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add notes about this organization..."
          className="h-40 w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/40"
        />
        <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
          <span>{notes.length} characters</span>
          <span>Autosave available via Ctrl+S</span>
        </div>
      </section>
    </main>
  )
}
