import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * ProfileGapInterview — renders Anya's opening interview / gap-fill questions from
 * a gap-plan (GET /api/profiles/:id/gap-plan) and collects the answers.
 *
 * The questions are mostly dichotomous (yes/no): each answer writes the exact
 * profile field the matcher reads to derive the profile's TYPE and eligibility, so
 * the user never picks a type — their answers determine it. Value questions
 * (location, needs, amount) fill the matching-critical gaps.
 *
 * Presentational + self-contained (no data fetching), so it is unit-testable in
 * jsdom. On submit it maps answers → section updates ({ sectionKey: { field: value } })
 * via each question's `writes` descriptor and hands them to onSubmit for persistence.
 */
export default function ProfileGapInterview({ plan, onSubmit, onSkip, submitting = false }) {
  const questions = useMemo(() => (Array.isArray(plan?.questions) ? plan.questions : []), [plan])
  const [answers, setAnswers] = useState({})

  const setAnswer = (id, value) => setAnswers((prev) => ({ ...prev, [id]: value }))

  // Map the collected answers to profile section updates using each question's
  // `writes` descriptor. yes/no → writes.yes / writes.no (a null side is skipped,
  // e.g. "are you a senior?" → No writes nothing). value questions write as-is.
  const buildSectionUpdates = () => {
    const updates = {}
    for (const q of questions) {
      const ans = answers[q.id]
      if (ans === undefined || ans === '' || ans === null) continue
      const w = q.writes || {}
      if (!w.section || !w.field) continue
      let value
      if (q.type === 'yes_no') {
        value = ans === true ? w.yes : w.no
        if (value === null || value === undefined) continue
      } else if (q.type === 'number') {
        const n = Number(ans)
        if (!Number.isFinite(n)) continue
        value = n
      } else {
        value = ans
      }
      updates[w.section] = { ...(updates[w.section] || {}), [w.field]: value }
    }
    return updates
  }

  const answeredCount = questions.filter((q) => answers[q.id] !== undefined && answers[q.id] !== '').length
  const canSubmit = answeredCount > 0 && !submitting

  if (!questions.length) return null

  return (
    <div className="space-y-6" data-testid="profile-gap-interview">
      <div>
        <h2 className="text-lg font-semibold">A few quick questions</h2>
        <p className="text-sm text-slate-500">
          Answering these lets me find funding that actually fits you. Most are just yes or no,
          and you never have to pick a “profile type” — your answers tell me everything.
        </p>
      </div>

      <ol className="space-y-5">
        {questions.map((q) => (
          <li key={q.id} className="space-y-2">
            <Label htmlFor={`q-${q.id}`} className="block text-sm font-medium">{q.prompt}</Label>
            {q.type === 'yes_no' ? (
              <div className="flex gap-2" role="group" aria-label={q.prompt}>
                <Button
                  type="button"
                  variant={answers[q.id] === true ? 'default' : 'outline'}
                  aria-pressed={answers[q.id] === true}
                  onClick={() => setAnswer(q.id, true)}
                >
                  Yes
                </Button>
                <Button
                  type="button"
                  variant={answers[q.id] === false ? 'default' : 'outline'}
                  aria-pressed={answers[q.id] === false}
                  onClick={() => setAnswer(q.id, false)}
                >
                  No
                </Button>
              </div>
            ) : (
              <Input
                id={`q-${q.id}`}
                type={q.type === 'number' ? 'number' : 'text'}
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswer(q.id, e.target.value)}
              />
            )}
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-3">
        <Button type="button" disabled={!canSubmit} onClick={() => onSubmit?.(buildSectionUpdates(), answers)}>
          {submitting ? 'Saving…' : 'Save & continue'}
        </Button>
        {onSkip && (
          <Button type="button" variant="ghost" onClick={onSkip} disabled={submitting}>
            Skip for now
          </Button>
        )}
      </div>
    </div>
  )
}
