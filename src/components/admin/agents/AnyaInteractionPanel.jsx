import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Bot } from 'lucide-react'

/**
 * Anya panel — metadata only by default.
 *
 * Per the dashboard privacy rule, we never render full message content
 * here. Admins see counts, mode breakdown, top tools, and the list of
 * users who interacted with Anya in the selected range.
 */
export default function AnyaInteractionPanel({ data }) {
  const installed = data?.summary?.installed || data?.panel?.installed
  const panel = data?.panel || {}

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-slate-500" />
          Anya — interactions
          {!installed ? <span className="ml-2 text-xs font-normal text-slate-500">Not installed</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            Anya hasn't recorded any interactions in this window.
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Sessions" value={panel.sessions_count} />
              <Stat label="Interactions" value={panel.interactions} />
              <Stat label="Tool calls" value={panel.tool_invocations} />
              <Stat label="Unique users" value={panel.unique_users} />
            </dl>
            {panel.modes && Object.keys(panel.modes).length ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Modes:</span>
                {Object.entries(panel.modes).map(([m, n]) => (
                  <span key={m} className="rounded border bg-slate-50 px-2 py-0.5 dark:bg-slate-900/40">
                    {m}: <span className="font-mono">{n}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {Array.isArray(panel.most_used_tools) && panel.most_used_tools.length ? (
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-500">Top tools</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {panel.most_used_tools.slice(0, 8).map((t) => (
                    <li key={t.tool} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-0.5 dark:bg-slate-900/40">
                      <span className="truncate">{t.tool}</span>
                      <span className="font-mono">{t.uses}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {Array.isArray(panel.recent_users) && panel.recent_users.length ? (
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-500">Recent users (metadata only)</div>
                <table className="mt-1 w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 font-medium">User</th>
                      <th className="py-1 font-medium">Profile</th>
                      <th className="py-1 font-medium text-right">Sessions</th>
                      <th className="py-1 font-medium text-right">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panel.recent_users.slice(0, 12).map((u) => (
                      <tr key={u.user_id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="truncate py-1 font-mono">{u.user_id}</td>
                        <td className="truncate py-1 font-mono">{u.profile_id || '—'}</td>
                        <td className="py-1 text-right font-mono">{u.sessions}</td>
                        <td className="py-1 text-right text-slate-500">
                          {u.last_at ? new Date(u.last_at).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded border bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value ?? 0}</div>
    </div>
  )
}
