import React from 'react'
import {
  MIN_SCORE_GUIDANCE_ZONES,
  MIN_SCORE_SLIDER_MAX,
  MIN_SCORE_SLIDER_HELP,
} from '@/lib/matchDisplayThresholds'

/**
 * Color-coded, NOTCHED guidance band rendered ABOVE the "Minimum match score"
 * slider. SINGLE shared implementation for DiscoverGrants + SmartMatcher (they
 * previously carried divergent copies with hardcoded old-scale 40/70/85 zones).
 *
 * Zones come from MIN_SCORE_GUIDANCE_ZONES (canonical data-point-scale bands:
 * Broad < 7 ≤ Good < 11 ≤ Strong < 14 ≤ Best) so a threshold recalibration
 * moves the band automatically. Data-driven from the matching endpoint's
 * `score_histogram` ([{ min, max, count, top_source }] bucketed on the SAME
 * band edges): greener = more results in that zone, gray = searched but empty.
 * Degrades gracefully — with no histogram it renders a static
 * "right = closer fit" gradient.
 *
 * @param {{ histogram?: Array<{min:number,max:number,count:number,top_source:string|null}>, max?: number, value?: number }} props
 */
export default function MatchScoreGuidanceBand({ histogram, max = MIN_SCORE_SLIDER_MAX, value }) {
  const buckets = Array.isArray(histogram) ? histogram : []
  const zones = MIN_SCORE_GUIDANCE_ZONES
  const maxCount = buckets.reduce((m, b) => Math.max(m, Number(b?.count) || 0), 0)
  const hasData = maxCount > 0

  // Count per zone: sum every histogram bucket whose START falls inside the
  // zone (buckets share the zone edges, so this is an exact partition; it also
  // tolerates older bucket layouts without dropping results on the floor).
  const zoneStats = zones.map((z, i) => {
    const isLast = i === zones.length - 1
    let count = 0
    const families = new Map()
    for (const b of buckets) {
      const bMin = Number(b?.min)
      if (!Number.isFinite(bMin)) continue
      if (bMin >= z.min && (isLast || bMin < z.max)) {
        count += Number(b?.count) || 0
        if (b?.top_source) {
          families.set(String(b.top_source), (families.get(String(b.top_source)) || 0) + (Number(b?.count) || 0))
        }
      }
    }
    let topSource = null
    let topN = -1
    for (const [family, n] of families) {
      if (n > topN) { topN = n; topSource = family }
    }
    return { count, topSource }
  })

  return (
    <div className="mt-3">
      <div className="flex w-full gap-1">
        {zones.map((z, i) => {
          const isLast = i === zones.length - 1
          const { count, topSource } = zoneStats[i]
          const isActiveZone =
            typeof value === 'number' && value >= z.min && (isLast ? true : value < z.max)
          // With live data: green by result density (gray when a zone has 0).
          // Without data: a static confidence gradient (higher zone = stronger
          // fit = deeper green) so the guide still reads as "right = closer fit".
          const ratio = hasData ? count / maxCount : 0
          const staticRatio = z.min / max
          const intensity = hasData ? 0.2 + 0.65 * ratio : 0.16 + 0.5 * staticRatio
          const bg = hasData && count === 0
            ? 'rgb(241 245 249)' // slate-100 — searched, nothing here
            : `rgba(34, 197, 94, ${intensity})`
          const sub = hasData
            ? (count > 0 ? `${count}${topSource ? ` · ${topSource.toLowerCase()}` : ''}` : z.hint)
            : z.hint
          const rangeText = isLast ? `score ${z.min}+` : `score ${z.min}–${z.max - 1}`
          return (
            <div
              key={`band-${z.min}`}
              className="flex flex-col"
              style={{ flexGrow: 1, flexBasis: 0 }}
              title={`${z.label} (${rangeText})${hasData ? ` · ${count} match${count === 1 ? '' : 'es'}` : ''}${topSource ? ` · mostly ${topSource.toLowerCase()}` : ` · ${z.hint}`}`}
            >
              <div
                className={`h-2.5 rounded-sm ${isActiveZone ? 'ring-2 ring-emerald-600' : ''}`}
                style={{ backgroundColor: bg }}
              />
              <div className="mt-1 text-[10px] leading-tight text-muted-foreground text-center">
                <div className="font-medium text-foreground/80">{z.label}</div>
                <div className="truncate">{sub}</div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-muted-foreground">
        <span>0</span>
        <span className="text-center">{MIN_SCORE_SLIDER_HELP}</span>
        <span>{max}+</span>
      </div>
    </div>
  )
}
