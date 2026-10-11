export const METRICS_MAX_DAYS = 90
export const METRICS_DEFAULT_DAYS = 30
const DAY = 86_400_000
export interface MetricsRange { start: string; end: string }
export type MetricsSection = 'totals' | 'daily' | 'topPages' | 'topReferrers'
export interface MetricsResponse {
  schemaVersion: 1
  range: MetricsRange & { timezone: 'UTC' }
  generatedAt: string
  status: 'complete' | 'partial'
  totals: { pageviews: number; browserIds: number } | null
  daily: Array<{ date: string; pageviews: number; browserIds: number }>
  topPages: Array<{ path: string; pageviews: number }>
  topReferrers: Array<{ host: string; pageviews: number }>
  unavailable: MetricsSection[]
}
export interface MetricsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'disconnected' | 'error' | 'rate-limited'
  data: MetricsResponse | null
  error?: string
  retryAt?: string
}
export function utcDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN
}
export function rangeError(range: MetricsRange, now = Date.now()): string | null {
  const start = utcDate(range.start), end = utcDate(range.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Choose valid UTC dates.'
  if (end <= start) return 'End must be after start (the end date is excluded).'
  if (end - start > METRICS_MAX_DAYS * DAY) return 'Choose a window of at most 90 days.'
  const tomorrow = Math.floor(now / DAY) * DAY + DAY
  if (end > tomorrow) return 'End cannot be later than tomorrow in UTC.'
  return null
}
export function defaultMetricsRange(now = Date.now(), days = METRICS_DEFAULT_DAYS): MetricsRange {
  const end = Math.floor(now / DAY) * DAY
  return { start: new Date(end - days * DAY).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10) }
}
export const metricsDefinitions = {
  pageviews: 'Public-site $pageview events, not sessions or visits.',
  browserIds: 'Distinct browser IDs across the whole selected period. Not verified people; daily distinct counts must not be added together.',
  scope: 'frankmanu.com and www.frankmanu.com only. Dashboard traffic excluded. Bot and internal-traffic filtering is not guaranteed.',
  privacy: 'Only aggregate counts, public paths, and referrer hostnames are shown. No profiles, replay, query strings, or browser IDs are returned.',
} as const
