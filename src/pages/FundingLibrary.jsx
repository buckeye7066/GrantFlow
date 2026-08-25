import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Library, Sparkles } from 'lucide-react'
import fundingLibraryApi from '@/api/fundingLibrary'
import FundingLibraryFilters from '@/components/funding/FundingLibraryFilters'
import FundingLibraryTable from '@/components/funding/FundingLibraryTable'
import FundingLibraryDetail from '@/components/funding/FundingLibraryDetail'

const DEFAULT_FILTERS = {
  q: '',
  state: '',
  applicant_type: '',
  category: '',
  deadline: '',
  source_trust: '',
  kind: '',
  include_unverified: false,
  include_loans: false,
  sort: 'discovered_at',
  sort_dir: 'desc',
}

const PAGE_SIZE = 50

const FILTER_KEYS = [
  'q', 'state', 'applicant_type', 'category', 'deadline', 'source_trust', 'kind',
  'include_unverified', 'include_loans', 'sort', 'sort_dir',
]

/**
 * FundingLibrary — the GrantFlow general resources pool.
 *
 * Read-only browser of every verified funding opportunity GrantFlow has
 * ingested. This is *not* a profile pipeline. To work with profile-specific
 * recommendations, use the Robert recommendation toasts/pages.
 */
export default function FundingLibrary() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  // Keep a ref to the latest filters so a single stable fetchPage closure
  // always reads the current values without forcing the useEffect below to
  // depend on the whole filters object.
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const fetchPage = useCallback(async ({ append = false, fromOffset = 0 } = {}) => {
    setLoading(true)
    setError(null)
    try {
      const nextOffset = append ? fromOffset : 0
      const data = await fundingLibraryApi.list({
        ...filtersRef.current,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      if (data?.ok === false) throw new Error(data?.error || 'Library read failed')
      const newItems = Array.isArray(data?.items) ? data.items : []
      setItems((prev) => (append ? [...prev, ...newItems] : newItems))
      setTotal(Number(data?.total || 0))
      setOffset(nextOffset)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Refetch when filters change. We spread the filter values into the deps
  // array so the hook re-runs whenever any individual filter changes.
  useEffect(() => {
    fetchPage({ append: false })
  }, [fetchPage, ...FILTER_KEYS.map((k) => filters[k])])

  const hasMore = useMemo(() => items.length < total, [items.length, total])

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Library className="h-5 w-5 text-blue-600" />
            Funding Library
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            Every verified funding opportunity GrantFlow has discovered, across every applicant
            type and geography. Use the filters to find directories, scholarships, grants,
            benefits, and program funding. To save something to a profile, use the
            <Sparkles className="mx-1 inline h-3.5 w-3.5 text-blue-600" /> recommendation flow on
            the Profile page — Robert adds confirmed, profile-relevant matches to your pipeline.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Couldn't load the library: {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        <FundingLibraryFilters
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(DEFAULT_FILTERS)}
          onRefresh={() => fetchPage({ append: false })}
          loading={loading}
        />

        <FundingLibraryTable
          items={items}
          total={total}
          loading={loading}
          onSelect={(item) => setSelected(item)}
          onLoadMore={() => fetchPage({ append: true, fromOffset: offset + PAGE_SIZE })}
          hasMore={hasMore}
        />
      </div>

      <FundingLibraryDetail
        item={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
