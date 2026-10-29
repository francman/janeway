'use client'

import { useEffect, useId, useState } from 'react'
import { Button } from '@janeway/ui/button'
import { defaultMetricsRange, metricsDefinitions, rangeError, type MetricsRange, type MetricsSnapshot } from '../lib/metrics-definitions'
import { Icon } from './icon'

export interface MetricsViewProps {
  snapshot: MetricsSnapshot
  range: MetricsRange
  onRangeChange: (range: MetricsRange) => void
  onRefresh: () => void
  mode?: 'live' | 'sample'
}
const number = new Intl.NumberFormat('en-US')
export function MetricsView({ snapshot, range, onRangeChange, onRefresh, mode = 'live' }: MetricsViewProps) {
  const id = useId()
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    setClock(Date.now())
    if (!snapshot.retryAt) return
    const delay = Date.parse(snapshot.retryAt) - Date.now()
    if (!Number.isFinite(delay) || delay <= 0) return
    const timer = setTimeout(() => setClock(Date.now()), Math.min(delay + 50, 3_600_050))
    return () => clearTimeout(timer)
  }, [snapshot.retryAt, snapshot.status])
  const data = snapshot.data
  const error = rangeError(range)
  const loading = snapshot.status === 'loading'
  const limited = snapshot.status === 'rate-limited' && !!snapshot.retryAt && Date.parse(snapshot.retryAt) > clock
  const differentRange = !!data && (data.range.start !== range.start || data.range.end !== range.end)
  const stale = !!data && (differentRange || snapshot.status === 'error' || snapshot.status === 'rate-limited' || snapshot.status === 'disconnected' || (mode === 'live' && Date.now() - Date.parse(data.generatedAt) > 15 * 60_000))
  const max = data ? Math.max(1, ...data.daily.map(row => row.pageviews)) : 1
  const points = data?.daily.map((row, index) => `${data.daily.length === 1 ? 300 : index / (data.daily.length - 1) * 600},${150 - row.pageviews / max * 130}`).join(' ') ?? ''
  const message = snapshot.status === 'disconnected' ? 'PostHog is not connected. A server-side project ID, query API origin, and Query Read credential are required. No live totals are available.' : snapshot.status === 'rate-limited' ? `The analytics service is rate limiting requests.${snapshot.retryAt ? ` Retry after ${snapshot.retryAt} (UTC).` : ' Wait before refreshing again.'} No new result was received.` : snapshot.status === 'error' ? 'Metrics could not be refreshed. This is not evidence of zero traffic. Retry the read when the service is available.' : loading ? 'Reading aggregate metrics. No website content is changed.' : snapshot.status === 'idle' ? 'Metrics have not been loaded.' : null
  return <div className="workspace-split">
    <section className="panel space-y-6" aria-label="Metrics controls">
      <div className="flex items-center gap-3">
        <span className="panel-icon"><Icon name="chart" className="h-6 w-6" /></span>
        <div>
          <h1 className="panel-heading">Metrics</h1>
          <p className="panel-meta mt-1">Public website · UTC</p>
        </div>
      </div>
      {mode === 'sample' && <p className="rounded-xl border border-teal-300 bg-teal-50 p-4 text-sm text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-100" aria-label="Sample data notice"><strong>Sample data — not live or from PostHog.</strong></p>}
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!error && !loading && !limited) onRefresh() }}>
        <label className="block text-sm font-medium" htmlFor={`${id}-start`}>Start (UTC, inclusive)<input className="auth-input min-h-11" id={`${id}-start`} type="date" value={range.start} onChange={event => onRangeChange({ ...range, start: event.target.value })} aria-invalid={!!error} aria-describedby={`${id}-range-help`} /></label>
        <label className="block text-sm font-medium" htmlFor={`${id}-end`}>End (UTC, exclusive)<input className="auth-input min-h-11" id={`${id}-end`} type="date" value={range.end} onChange={event => onRangeChange({ ...range, end: event.target.value })} aria-invalid={!!error} aria-describedby={`${id}-range-help`} /></label>
        <div className="flex flex-wrap gap-2" aria-label="Preset date ranges">{[7, 30, 90].map(days => <Button key={days} type="button" variant="secondary" className="min-h-11 flex-1 whitespace-nowrap" onClick={() => onRangeChange(defaultMetricsRange(Date.now(), days))}>Last {days} days</Button>)}</div>
        <p id={`${id}-range-help`} className={`text-xs ${error ? 'text-red-700 dark:text-red-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{error ?? 'Maximum 90 days · completed UTC days'}</p>
        <Button type="submit" className="min-h-11 w-full disabled:opacity-60" disabled={loading || !!error || limited}>{loading ? 'Refreshing…' : mode === 'sample' ? 'Refresh sample' : 'Refresh metrics'}</Button>
      </form>
      {data && <div className="panel-meta space-y-2 break-words"><p>Showing {data.range.start} → {data.range.end}<br />UTC · end excluded</p><p>{mode === 'sample' ? 'Sample timestamp' : 'Fetched'}: <time dateTime={data.generatedAt}>{data.generatedAt}</time></p></div>}
      <details className="text-xs leading-5 text-zinc-500 dark:text-zinc-400"><summary className="min-h-11 cursor-pointer py-3 font-semibold">Metric definitions and privacy</summary><p className="mt-2">{metricsDefinitions.scope}</p><p className="mt-1">{metricsDefinitions.privacy}</p><p className="mt-1">No bounce rate, session duration, conversions, geography, or people-level analytics are inferred from these counts.</p></details>
    </section>
    <div className="min-w-0 space-y-6">
      {(message || stale) && <div className="panel space-y-3" role="status" aria-live="polite">{message && <p className="text-sm">{message}</p>}{stale && <p className="text-sm text-amber-800 dark:text-amber-300">Stale result retained for reference. The cards and tables below are for {data!.range.start} to {data!.range.end} (end excluded), not a new successful refresh.</p>}</div>}
      {!data ? <section className="panel" aria-busy={loading}><h2 className="panel-heading">{loading ? 'Loading metrics' : 'No metrics result available'}</h2><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Counts remain unavailable until a valid aggregate result is received. No sample or zero totals are substituted.</p></section> : <div className="space-y-6" aria-busy={loading}>
      {data.status === 'partial' && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Partial result: {data.unavailable.join(', ')} could not be retrieved. Missing sections are unavailable, not zero.</p>}
      <div className="grid gap-6 sm:grid-cols-2">{[{ title: 'Pageviews', value: data.totals?.pageviews, detail: metricsDefinitions.pageviews }, { title: 'Distinct browser IDs', value: data.totals?.browserIds, detail: metricsDefinitions.browserIds }].map(item => <section key={item.title} className="panel min-w-0"><h2 className="panel-heading">{item.title}</h2><p className="mt-3 break-words text-4xl font-semibold tracking-tight tabular-nums">{item.value === undefined ? 'Unavailable' : number.format(item.value)}</p><p className="panel-meta mt-3 leading-5">{item.detail}</p></section>)}</div>
      {data.totals?.pageviews === 0 && <p className="text-sm text-zinc-600 dark:text-zinc-400">No matching pageview events were returned for this UTC window. This does not prove that nobody visited the website.</p>}
      <section className="panel min-w-0"><h2 className="panel-heading">Daily pageviews</h2><p className="panel-meta mt-1">UTC days · daily browser IDs are listed in the table, not summed.</p>{data.unavailable.includes('daily') ? <p className="mt-4 text-sm">Daily trend unavailable.</p> : <><figure className="mt-6"><svg viewBox="-45 -10 655 200" className="h-52 w-full text-teal-600 dark:text-teal-400" role="img" aria-labelledby={`${id}-chart-title ${id}-chart-desc`}><title id={`${id}-chart-title`}>Daily pageviews for {data.range.start} to {data.range.end}, end excluded</title><desc id={`${id}-chart-desc`}>Horizontal axis: UTC dates. Vertical axis: pageview count, zero to {number.format(max)}. Exact values are available in the daily data table below.</desc>{[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="0" x2="600" y1={150 - fraction * 130} y2={150 - fraction * 130} stroke="currentColor" opacity="0.15" /><text x="-8" y={154 - fraction * 130} textAnchor="end" fill="currentColor" fontSize="11">{number.format(Math.round(max * fraction))}</text></g>)}<polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />{data.daily.length === 1 && <circle cx="300" cy={150 - data.daily[0].pageviews / max * 130} r="4" fill="currentColor" />}<text x="0" y="178" fill="currentColor" fontSize="11">{data.daily[0]?.date}</text><text x="600" y="178" textAnchor="end" fill="currentColor" fontSize="11">{data.daily.at(-1)?.date}</text></svg><figcaption className="sr-only">Daily pageviews; full accessible data table follows.</figcaption></figure><details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Daily data table</summary><div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Daily UTC pageviews and distinct browser IDs</caption><thead><tr className="border-b border-zinc-200 dark:border-zinc-700"><th scope="col" className="py-3">UTC date</th><th scope="col" className="py-3 text-right">Pageviews</th><th scope="col" className="py-3 text-right">Browser IDs</th></tr></thead><tbody>{data.daily.map(row => <tr key={row.date} className="border-b border-zinc-100 dark:border-zinc-800"><th scope="row" className="py-2 font-normal">{row.date}</th><td className="text-right tabular-nums">{number.format(row.pageviews)}</td><td className="text-right tabular-nums">{number.format(row.browserIds)}</td></tr>)}</tbody></table></div></details></>}</section>
      <div className="grid gap-6 lg:grid-cols-2">{[{ section: 'topPages' as const, title: 'Top pages', label: 'Public path', rows: data.topPages.map(row => ({ label: row.path, pageviews: row.pageviews })) }, { section: 'topReferrers' as const, title: 'Top referrers', label: 'Referrer hostname', rows: data.topReferrers.map(row => ({ label: row.host === '(direct)' ? 'Direct / unknown' : row.host, pageviews: row.pageviews })) }].map(table => <section className="panel min-w-0" key={table.section}><h2 className="panel-heading">{table.title}</h2><p className="panel-meta mt-1">Top 10 by pageviews · not unique visitors</p>{data.unavailable.includes(table.section) ? <p className="mt-4 text-sm">This section is unavailable.</p> : !table.rows.length ? <p className="mt-4 text-sm">No matching rows returned.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{table.title} by pageview count</caption><thead><tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"><th scope="col" className="py-3">{table.label}</th><th scope="col" className="py-3 text-right">Pageviews</th></tr></thead><tbody>{table.rows.map(row => <tr className="border-b border-zinc-100 dark:border-zinc-800" key={row.label}><th scope="row" className="break-all py-3 pr-4 font-normal">{row.label}</th><td className="text-right tabular-nums">{number.format(row.pageviews)}</td></tr>)}</tbody></table></div>}</section>)}</div>
    </div>}
    </div>
  </div>
}
