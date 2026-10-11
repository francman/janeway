import type { MetricsResponse } from '../lib/metrics-definitions'

// Fictional design-review data. Import only from the local mockup entry, never production.
const pageviews = [71, 84, 96, 65, 58, 44, 51, 79, 103, 88, 76, 61, 49, 67, 105, 121, 110, 92, 83, 56, 72, 119, 132, 98, 111, 102, 87, 93, 124, 136]
export const metricsSample: MetricsResponse = {
  schemaVersion: 1,
  range: { start: '2026-09-10', end: '2026-10-10', timezone: 'UTC' },
  generatedAt: '2026-10-10T10:30:00.000Z',
  status: 'complete',
  totals: { pageviews: pageviews.reduce((total, value) => total + value, 0), browserIds: 814 },
  daily: pageviews.map((value, index) => ({ date: new Date(Date.UTC(2026, 8, 10 + index)).toISOString().slice(0, 10), pageviews: value, browserIds: Math.round(value * 0.72) })),
  topPages: [{ path: '/', pageviews: 1102 }, { path: '/writings/', pageviews: 638 }, { path: '/writings/designing-for-clarity/', pageviews: 372 }, { path: '/projects/', pageviews: 296 }, { path: '/about/', pageviews: 148 }],
  topReferrers: [{ host: '(direct)', pageviews: 1298 }, { host: 'google.com', pageviews: 532 }, { host: 'github.com', pageviews: 294 }, { host: 'linkedin.com', pageviews: 172 }, { host: 'bing.com', pageviews: 106 }],
  unavailable: [],
}
