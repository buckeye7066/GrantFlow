import React, { useCallback, useEffect, useRef, useState } from 'react'
import { advertisementApi } from '@/api/advertisements.js'
import { useAuthStore } from '@/stores/authStore'

const fieldClass = 'w-full rounded border bg-background px-3 py-2 text-sm'
const actionClass = 'rounded border px-3 py-2 text-sm hover:bg-muted'
const utcInput = (date) => new Date(date).toISOString().slice(0, 16)
const blankAd = () => ({ advertiser: '', headline: '', body: '', target_url: '', duration_seconds: 15, starts_at: utcInput(Date.now()), ends_at: utcInput(Date.now() + 7 * 86400000), status: 'paused' })

export default function AdvertisementPanel() {
  const userId = useAuthStore(state => state.user?.id)
  const [feed, setFeed] = useState({ advertisements: [], canManage: false })
  const [index, setIndex] = useState(0)
  const [manage, setManage] = useState(false)
  const [image, setImage] = useState(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [visible, setVisible] = useState(false)
  const [foreground, setForeground] = useState(() => document.visibilityState === 'visible')
  const [now, setNow] = useState(Date.now())
  const [offset, setOffset] = useState(0)
  const element = useRef(null)
  const impression = useRef(false)
  const viewTicket = useRef(null)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const current = generation.current
    try {
      const result = await advertisementApi.list()
      if (current !== generation.current) return
      setFeed(result)
      setOffset(Date.parse(result.serverTime) - Date.now())
    } catch { if (current === generation.current) setFeed({ advertisements: [], canManage: false }) }
  }, [])

  useEffect(() => {
    generation.current += 1
    setFeed({ advertisements: [], canManage: false }); setManage(false)
    reload()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload() }, 30000)
    return () => { generation.current += 1; clearInterval(timer) }
  }, [reload, userId])

  useEffect(() => {
    const change = () => { setForeground(document.visibilityState === 'visible'); if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', change)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { document.removeEventListener('visibilitychange', change); clearInterval(timer) }
  }, [reload])

  const active = feed.advertisements.filter(ad => Date.parse(ad.starts_at) <= now + offset && Date.parse(ad.ends_at) > now + offset)
  const ad = active[index % Math.max(1, active.length)]

  useEffect(() => {
    setVisible(false)
    if (!element.current || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting && entries[0].intersectionRatio >= 0.5), { threshold: [0, 0.5, 1] })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [ad?.id])

  useEffect(() => {
    let cancelled = false
    let objectUrl
    setImage(null); setImageLoaded(false); impression.current = false
    if (ad?.id && foreground) advertisementApi.image(ad.id).then(blob => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob); setImage(objectUrl)
    }).catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [ad?.id, ad?.updated_at, userId, index, foreground])

  useEffect(() => {
    if (!ad || !imageLoaded || !visible || !foreground) return undefined
    let cancelled = false
    let count
    if (!feed.canManage && !impression.current) advertisementApi.ticket(ad.id).then(({ ticket }) => {
      if (cancelled || !ticket) return
      viewTicket.current = ticket
      count = setTimeout(() => {
        if (cancelled || document.visibilityState !== 'visible') return
        advertisementApi.event(ad.id, 'impression', ticket).then(result => { if (!cancelled) impression.current = result.accepted === true }).catch(() => {})
      }, 1100)
    }).catch(() => {})
    const rotate = setTimeout(() => { setIndex(value => value + 1) }, ad.duration_seconds * 1000)
    return () => { cancelled = true; clearTimeout(count); clearTimeout(rotate) }
  }, [ad?.id, ad?.duration_seconds, active.length, imageLoaded, visible, foreground, feed.canManage])

  if (!ad && !feed.canManage) return null
  return <section aria-label="Advertisements" className="m-3 rounded-lg border bg-card p-3 print:hidden" data-advertisement="true">
    {ad && <div ref={element} className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {image && <img src={image} alt={ad.advertiser} className="h-32 w-full rounded object-contain sm:w-48" onLoad={() => setImageLoaded(true)} onError={() => { setImage(null); setImageLoaded(false) }} />}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Advertisement · {ad.advertiser}</p>
        <p className="break-words font-semibold">{ad.headline}</p>
        <p className="break-words text-sm text-muted-foreground">{ad.body}</p>
        <a href={ad.target_url} target="_blank" rel="noopener noreferrer sponsored" referrerPolicy="no-referrer" className="mt-2 inline-block rounded border px-3 py-2 text-sm" onClick={() => { if (!feed.canManage && impression.current && visible && document.visibilityState === 'visible') advertisementApi.event(ad.id, 'click', viewTicket.current).catch(() => {}) }}>Visit advertiser <span aria-hidden="true">↗</span></a>
      </div>
      {active.length > 1 && <button type="button" className={actionClass} onClick={() => setIndex(value => value + 1)} aria-label="Next advertisement">Next</button>}
    </div>}
    {feed.canManage && <div className={ad ? 'mt-3 border-t pt-3' : ''}>
      <button type="button" className={actionClass} onClick={() => setManage(value => !value)} aria-expanded={manage}>{manage ? 'Close advertisement manager' : 'Manage advertisements'}</button>
      {manage && <AdvertisementManager onChange={reload} />}
    </div>}
  </section>
}

function CreativePreview({ id, updatedAt }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    let objectUrl
    advertisementApi.image(id).then(blob => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id, updatedAt])
  return url ? <img src={url} alt="Creative preview" className="h-20 max-w-full rounded object-contain" /> : null
}

function AdvertisementManager({ onChange }) {
  const [data, setData] = useState({ advertisements: [], totals: [], daily: [] })
  const [form, setForm] = useState(blankAd)
  const [files, setFiles] = useState([])
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const upload = useRef(null)
  const load = useCallback(async () => {
    try { setData(await advertisementApi.manage()) } catch (failure) { setError(failure.message) }
  }, [])
  useEffect(() => { load() }, [load])
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const reset = () => { setForm(blankAd()); setEditing(null); setFiles([]); if (upload.current) upload.current.value = '' }
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      if ((!editing && files.length < 1) || files.length > (editing ? 1 : 8)) throw new Error(editing ? 'Choose one replacement image.' : 'Choose one to eight distinct images.')
      const body = new FormData()
      Object.entries(form).forEach(([key, value]) => body.append(key, ['starts_at', 'ends_at'].includes(key) ? new Date(`${value}Z`).toISOString() : String(value)))
      files.forEach(file => body.append('images', file))
      await advertisementApi.save(body, editing)
      reset(); await load(); await onChange(); setMessage('Advertisements saved.')
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  const remove = async id => {
    if (!window.confirm('Remove this advertisement? It will stop displaying. Historical counts remain.')) return
    setBusy(true); setError('')
    try { await advertisementApi.remove(id); await load(); await onChange(); if (editing === id) reset() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <div className="mt-4 space-y-4">
    <h2 className="font-semibold">Owner advertisement manager</h2>
    <p className="text-sm text-muted-foreground">Each image becomes its own rotating creative. Dates use UTC. No grant or profile information is used for advertising.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Advertiser<input className={fieldClass} required maxLength={100} value={form.advertiser} onChange={event => update('advertiser', event.target.value)} /></label>
      <label className="text-sm">Headline<input className={fieldClass} required maxLength={160} value={form.headline} onChange={event => update('headline', event.target.value)} /></label>
      <label className="text-sm sm:col-span-2">Body<textarea className={fieldClass} maxLength={600} value={form.body} onChange={event => update('body', event.target.value)} /></label>
      <label className="text-sm">Destination (HTTPS)<input className={fieldClass} type="url" required maxLength={2000} value={form.target_url} onChange={event => update('target_url', event.target.value)} /></label>
      <label className="text-sm">{editing ? 'Replace image (optional)' : 'Images (one to eight)'}<input ref={upload} className={fieldClass} type="file" accept="image/png,image/jpeg,image/webp" multiple={!editing} required={!editing} onChange={event => setFiles(Array.from(event.target.files || []))} /><span className="text-xs text-muted-foreground">PNG, JPEG, or WebP. 512 KB each; 4096 pixels per side maximum.</span></label>
      <label className="text-sm">Slide duration<select className={fieldClass} value={[15, 30].includes(Number(form.duration_seconds)) ? String(form.duration_seconds) : 'custom'} onChange={event => update('duration_seconds', event.target.value === 'custom' ? 20 : Number(event.target.value))}><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="custom">Custom</option></select></label>
      <label className="text-sm">Seconds<input className={fieldClass} type="number" min={5} max={300} step={1} required value={form.duration_seconds} onChange={event => update('duration_seconds', Number(event.target.value))} /></label>
      <label className="text-sm">Run length<select className={fieldClass} defaultValue="custom" onChange={event => { const date = new Date(`${form.starts_at}Z`); if (event.target.value === 'month') date.setUTCMonth(date.getUTCMonth() + 1); else if (event.target.value !== 'custom') date.setUTCDate(date.getUTCDate() + Number(event.target.value)); else return; update('ends_at', utcInput(date)) }}><option value="7">One week</option><option value="14">Two weeks</option><option value="month">One month</option><option value="custom">Custom dates</option></select></label>
      <label className="text-sm">Publication<select className={fieldClass} value={form.status} onChange={event => update('status', event.target.value)}><option value="paused">Paused</option><option value="published">Published</option></select></label>
      <label className="text-sm">Starts (UTC)<input className={fieldClass} type="datetime-local" required value={form.starts_at} onChange={event => update('starts_at', event.target.value)} /></label>
      <label className="text-sm">Ends (UTC)<input className={fieldClass} type="datetime-local" required value={form.ends_at} onChange={event => update('ends_at', event.target.value)} /></label>
      <div className="flex gap-2 sm:col-span-2"><button className={actionClass} disabled={busy} type="submit">{busy ? 'Saving…' : editing ? 'Save creative' : 'Create advertisements'}</button>{editing && <button type="button" className={actionClass} onClick={reset}>Cancel edit</button>}</div>
    </form>
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Creatives and performance</h3><button type="button" className={actionClass} onClick={load}>Refresh counts</button></div>
    <p className="text-xs text-muted-foreground">Impressions require at least one second at 50% visibility in the foreground. Repeated events are deduplicated per creative, viewer, and 30 seconds. Unique viewers are pseudonymous signed-in accounts, not individual people; automated traffic may affect counts. Owner previews do not record events.</p>
    {!data.advertisements.length && <p className="text-sm">No advertisements yet.</p>}
    {data.advertisements.map(ad => {
      const stats = data.totals.find(row => row.ad_id === ad.id) || {}
      return <article key={ad.id} className="space-y-2 rounded border p-3">
        <CreativePreview id={ad.id} updatedAt={ad.updated_at} />
        <p className="break-words font-medium">{ad.headline} <span className="text-xs font-normal">({ad.status})</span></p>
        <p className="text-xs">{ad.advertiser} · {ad.duration_seconds}s · {ad.starts_at.slice(0, 16)} → {ad.ends_at.slice(0, 16)} UTC</p>
        <p className="text-sm">{stats.impressions || 0} impressions · {stats.clicks || 0} clicks · {stats.unique_viewers || 0} unique viewers</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={actionClass} onClick={() => { setEditing(ad.id); setForm({ advertiser: ad.advertiser, headline: ad.headline, body: ad.body, target_url: ad.target_url, duration_seconds: ad.duration_seconds, starts_at: utcInput(ad.starts_at), ends_at: utcInput(ad.ends_at), status: ad.status }); setFiles([]); if (upload.current) upload.current.value = '' }}>Edit / pause</button><button type="button" className={actionClass} disabled={busy} onClick={() => remove(ad.id)}>Remove</button></div>
        <details><summary className="cursor-pointer text-sm">Daily counts</summary><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Day (UTC)</th><th className="p-2">Impressions</th><th className="p-2">Clicks</th><th className="p-2">Unique viewers</th></tr></thead><tbody>{data.daily.filter(row => row.ad_id === ad.id).map(row => <tr key={row.day}><td className="p-2">{row.day}</td><td className="p-2">{row.impressions}</td><td className="p-2">{row.clicks}</td><td className="p-2">{row.unique_viewers}</td></tr>)}</tbody></table></div></details>
      </article>
    })}
  </div>
}
