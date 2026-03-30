import React, { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Link } from 'react-router-dom'
import { X, CheckCircle, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { NAV_GROUPS } from '@/nav/navConfig'
import { getHelpForRoute } from '@/config/helpRegistry'

function getDescription(item) {
  const entry = getHelpForRoute(item.routeName)
  return entry?.description ?? `Opens the ${item.title} page.`
}

function matchesSearch(item, group, query) {
  if (!query.trim()) return true
  const q = query.trim().toLowerCase()
  const title = (item.title ?? '').toLowerCase()
  const desc = (getDescription(item) ?? '').toLowerCase()
  const groupLabel = (group?.label ?? '').toLowerCase()
  return title.includes(q) || desc.includes(q) || groupLabel.includes(q)
}

export default function OnboardingManual({ open, onComplete, onSkip }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState(() => new Set(NAV_GROUPS.map((g) => g.groupId)))

  const handleComplete = () => {
    onComplete?.()
  }

  const handleSkip = () => {
    onSkip?.()
  }

  const toggleGroup = (groupId) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const filteredGroups = useMemo(() => {
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesSearch(item, group, searchQuery)),
    })).filter((g) => g.items.length > 0)
  }, [searchQuery])

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleSkip()
      }}
    >
      <DialogContent className="sm:max-w-[900px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>GrantFlow User&apos;s Manual</DialogTitle>
          <DialogDescription>
            This guide mirrors the left sidebar. Use it to learn what each section does and jump
            directly to a page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by title or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="overflow-auto max-h-[65vh] space-y-2 pr-1">
            {filteredGroups.map((group) => {
              const GroupIcon = group.icon
              const isExpanded = expandedIds.has(group.groupId)
              return (
                <Collapsible
                  key={group.groupId}
                  open={isExpanded}
                  onOpenChange={() => toggleGroup(group.groupId)}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg border px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    >
                      <span className="flex items-center gap-2 font-medium">
                        {GroupIcon && <GroupIcon className="h-4 w-4" />}
                        {group.label}
                      </span>
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 ml-4 space-y-3 border-l-2 border-muted pl-4">
                      {group.items.map((item) => {
                        const ItemIcon = item.icon
                        const showAdmin = item.isAdminOnly
                        const showAdvanced = item.isAdvanced
                        const showPrivacy =
                          item.routeName === 'Incognito' || item.title === 'Incognito'
                        const entry = getHelpForRoute(item.routeName)
                        return (
                          <div key={item.routeName} className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <ItemIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="font-medium">{item.title}</span>
                              {showAdmin && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                  Admin
                                </span>
                              )}
                              {showAdvanced && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                                  Advanced
                                </span>
                              )}
                              {showPrivacy && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">
                                  Privacy
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{getDescription(item)}</p>
                            {entry?.purpose && entry.purpose !== entry.description && (
                              <p className="text-xs text-muted-foreground/75 italic">{entry.purpose}</p>
                            )}
                            <Link
                              to={item.url}
                              className="inline-flex text-sm text-primary hover:underline"
                              onClick={handleSkip}
                            >
                              Open →
                            </Link>
                          </div>
                        )
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
            {filteredGroups.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No items match your search.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleSkip}
            className="flex items-center gap-2"
          >
            <X className="h-4 w-4" />
            Skip for now
          </Button>
          <Button
            type="button"
            onClick={handleComplete}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700"
          >
            <CheckCircle className="h-4 w-4" />
            Mark as Complete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
