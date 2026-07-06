import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * AnyaCoachmark — an anchored popup (Anya's avatar + tip) with a spotlight
 * cut into a dark backdrop around a real, already-mounted DOM element.
 *
 * Deliberately hand-rolled rather than built on Radix's Popover/Anchor:
 * Radix's Anchor requires the anchor and the content to render under the
 * same Popover.Root, but this coachmark's target lives in a page component
 * (DiscoverGrants, KanbanBoard, GrantOverview, ...) that the tour orchestrator
 * never renders directly — it only holds a ref those components register.
 * Positioning off a plain getBoundingClientRect(), recomputed via
 * ResizeObserver + scroll/resize listeners, avoids fighting that constraint.
 *
 * Pass `targetRef: null` for a centered, un-spotlighted card (used for the
 * trailing "other features" steps that aren't anchored to a specific
 * element on every screen size).
 */
export default function AnyaCoachmark({
  targetRef,
  title,
  body,
  stepIndex,
  stepCount,
  onNext,
  onBack,
  onSkip,
  isNextDisabled = false,
  nextHint,
  nextLabel = 'Next',
}) {
  const [rect, setRect] = useState(() => targetRef?.current?.getBoundingClientRect() ?? null)

  useLayoutEffect(() => {
    const el = targetRef?.current
    if (!el) {
      setRect(null)
      return undefined
    }
    const update = () => setRect(el.getBoundingClientRect())
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [targetRef?.current])

  if (typeof document === 'undefined') return null

  const centered = !targetRef || !rect

  let cardStyle
  if (!centered) {
    const spacing = 12
    const cardWidth = 340
    const vw = window.innerWidth
    const vh = window.innerHeight
    const estimatedCardHeight = 220
    const fitsBelow = rect.bottom + spacing + estimatedCardHeight <= vh
    let left = rect.left + rect.width / 2 - cardWidth / 2
    left = Math.max(12, Math.min(left, vw - cardWidth - 12))
    cardStyle = fitsBelow
      ? { position: 'fixed', top: rect.bottom + spacing, left, width: cardWidth }
      : { position: 'fixed', bottom: vh - rect.top + spacing, left, width: cardWidth }
  } else {
    cardStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 380,
    }
  }

  const content = (
    <>
      <div
        aria-hidden
        style={
          centered
            ? { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', zIndex: 9998 }
            : {
                position: 'fixed',
                top: rect.top - 6,
                left: rect.left - 6,
                width: rect.width + 12,
                height: rect.height + 12,
                borderRadius: 10,
                boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)',
                zIndex: 9998,
                pointerEvents: 'none',
                transition: 'top 150ms ease, left 150ms ease, width 150ms ease, height 150ms ease',
              }
        }
      />
      <div
        role="dialog"
        aria-label={typeof title === 'string' ? title : 'Guided tour step'}
        style={{ zIndex: 9999, ...cardStyle }}
        className="rounded-2xl border border-blue-200 bg-white p-4 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <img
            src="/images/anya-avatar.svg"
            alt="Anya"
            className="h-9 w-9 shrink-0 rounded-full shadow-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">Anya</span>
              {onSkip ? (
                <button
                  type="button"
                  onClick={onSkip}
                  className="text-slate-400 transition-colors hover:text-slate-600"
                  aria-label="Skip tour"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            {title ? <h3 className="mt-1 text-sm font-semibold text-slate-900">{title}</h3> : null}
            {body ? <div className="mt-1 text-sm leading-relaxed text-slate-700">{body}</div> : null}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">
            {typeof stepIndex === 'number' && typeof stepCount === 'number'
              ? `Step ${stepIndex + 1} of ${stepCount}`
              : null}
          </span>
          <div className="flex items-center gap-2">
            {onBack ? (
              <Button type="button" variant="outline" size="sm" onClick={onBack} className="gap-1">
                <ArrowLeft className="h-3 w-3" /> Back
              </Button>
            ) : null}
            {onNext ? (
              <Button type="button" size="sm" disabled={isNextDisabled} onClick={onNext} className="gap-1">
                {nextLabel} <ArrowRight className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        </div>
        {isNextDisabled && nextHint ? (
          <p className="mt-2 text-right text-[11px] text-slate-400">{nextHint}</p>
        ) : null}
      </div>
    </>
  )

  return createPortal(content, document.body)
}
