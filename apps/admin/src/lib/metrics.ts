import { ApiError } from './api'
import { rangeError, utcDate, type MetricsRange, type MetricsResponse, type MetricsSection } from './metrics-definitions'
export type { MetricsRange, MetricsResponse, MetricsSnapshot } from './metrics-definitions'
export class MetricsFailure extends Error {
  constructor(readonly code: 'DISCONNECTED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RANGE', readonly retryAt?: string) { super(code) }
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const sections: MetricsSection[] = ['totals', 'daily', 'topPages', 'topReferrers']
export function parseMetrics(value: unknown, requested: MetricsRange): MetricsResponse {
  const data = value as MetricsResponse | null
  const invalid = () => { throw new MetricsFailure('UNAVAILABLE') }
  if (!data || data.schemaVersion !== 1 || data.range?.start !== requested.start || data.range?.end !== requested.end || data.range.timezone !== 'UTC' || !['complete', 'partial'].includes(data.status)) return invalid()
  if (typeof data.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.generatedAt) || !Number.isFinite(Date.parse(data.generatedAt)) || new Date(data.generatedAt).toISOString() !== data.generatedAt) return invalid()
  if (!Array.isArray(data.unavailable) || data.unavailable.some(item => !sections.includes(item)) || new Set(data.unavailable).size !== data.unavailable.length || (data.status === 'complete') !== (data.unavailable.length === 0)) return invalid()
  const missing = (section: MetricsSection) => data.unavailable.includes(section)
  if (missing('totals') ? data.totals !== null : !data.totals || !count(data.totals.pageviews) || !count(data.totals.browserIds) || data.totals.browserIds > data.totals.pageviews) return invalid()
  const days = (utcDate(requested.end) - utcDate(requested.start)) / 86_400_000
  if (!Number.isInteger(days) || days <= 0 || days > 90) return invalid()
  if (!Array.isArray(data.daily) || (missing('daily') ? data.daily.length !== 0 : data.daily.length !== days)) return invalid()
  for (let index = 0; index < data.daily.length; index++) {
    const row = data.daily[index]
    const expected = new Date(utcDate(requested.start) + index * 86_400_000).toISOString().slice(0, 10)
    if (!row || row.date !== expected || !count(row.pageviews) || !count(row.browserIds) || row.browserIds > row.pageviews) return invalid()
  }
  if (!missing('daily') && data.totals && data.daily.reduce((total, row) => total + row.pageviews, 0) !== data.totals.pageviews) return invalid()
  if (!missing('daily') && data.totals && data.daily.some(row => row.browserIds > data.totals!.browserIds)) return invalid()
  if (!missing('daily') && data.totals && data.totals.browserIds > data.daily.reduce((total, row) => total + row.browserIds, 0)) return invalid()
  for (const section of ['topPages', 'topReferrers'] as const) {
    const rows = data[section]
    if (!Array.isArray(rows) || rows.length > 10 || (missing(section) && rows.length)) return invalid()
    const seen = new Set<string>()
    let totalPageviews = 0
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (!row) return invalid()
      const label = section === 'topPages' ? (row as MetricsResponse['topPages'][number]).path : (row as MetricsResponse['topReferrers'][number]).host
      const safe = section === 'topPages' ? /^\/(?!\/)[^?#\s\\\u0000-\u001f]*$/.test(label) && !/%(?:3f|23|5c|0[0-9a-f]|1[0-9a-f])/i.test(label) : label === '(direct)' || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(label)
      if (typeof label !== 'string' || label.length > 512 || !safe || seen.has(label) || !count(row.pageviews) || row.pageviews === 0 || (data.totals && row.pageviews > data.totals.pageviews) || (index && rows[index - 1].pageviews < row.pageviews)) return invalid()
      seen.add(label)
      totalPageviews += row.pageviews
    }
    if (data.totals && totalPageviews > data.totals.pageviews) return invalid()
  }
  // Reconstruct the response so unknown provider properties never reach the UI.
  return { schemaVersion: 1, range: { ...requested, timezone: 'UTC' }, generatedAt: data.generatedAt, status: data.status, totals: data.totals && { pageviews: data.totals.pageviews, browserIds: data.totals.browserIds }, daily: data.daily.map(({ date, pageviews, browserIds }) => ({ date, pageviews, browserIds })), topPages: data.topPages.map(({ path, pageviews }) => ({ path, pageviews })), topReferrers: data.topReferrers.map(({ host, pageviews }) => ({ host, pageviews })), unavailable: [...data.unavailable] }
}
export async function getMetrics(apiUrl: string, accessToken: string, range: MetricsRange, signal: AbortSignal, transport: typeof fetch = fetch): Promise<MetricsResponse> {
  if (rangeError(range)) throw new MetricsFailure('INVALID_RANGE')
  let response: Response
  try { response = await transport(`${apiUrl}/v1/metrics?${new URLSearchParams({ start: range.start, end: range.end })}`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal }) } catch { throw new MetricsFailure('UNAVAILABLE') }
  if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied')
  if (response.status === 429) {
    const delay = response.headers.get('retry-after')
    const seconds = delay && /^\d{1,5}$/.test(delay) ? Math.min(Number(delay), 3600) : null
    throw new MetricsFailure('RATE_LIMITED', seconds === null ? undefined : new Date(Date.now() + seconds * 1000).toISOString())
  }
  if (!response.ok) {
    let code: unknown
    try { code = (await response.json())?.error?.code } catch { /* No raw provider error is exposed. */ }
    throw new MetricsFailure(code === 'METRICS_NOT_CONNECTED' ? 'DISCONNECTED' : 'UNAVAILABLE')
  }
  if (!response.headers.get('cache-control')?.split(',').some(item => item.trim().toLowerCase() === 'no-store')) throw new MetricsFailure('UNAVAILABLE')
  let body: unknown
  try { body = await response.json() } catch { throw new MetricsFailure('UNAVAILABLE') }
  return parseMetrics(body, range)
}
