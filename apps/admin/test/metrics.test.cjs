const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')
const modules = new Map()
function load(name) {
  const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
  if (modules.has(filename)) return modules.get(filename)
  const module = { exports: {} }, sourceRequire = createRequire(filename)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new vm.Script(code, { filename }).runInContext(vm.createContext({ module, exports: module.exports, URLSearchParams, Date, fetch, require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) } }))
  modules.set(filename, module.exports)
  return module.exports
}
const api = load('metrics'), definitions = load('metrics-definitions')
const range = { start: '2026-09-01', end: '2026-09-03' }
function result() {
  return { schemaVersion: 1, range: { ...range, timezone: 'UTC' }, generatedAt: '2026-09-03T12:00:00.000Z', status: 'complete', totals: { pageviews: 12, browserIds: 5 }, daily: [{ date: '2026-09-01', pageviews: 7, browserIds: 4 }, { date: '2026-09-02', pageviews: 5, browserIds: 3 }], topPages: [{ path: '/', pageviews: 8 }, { path: '/writings/', pageviews: 4 }], topReferrers: [{ host: '(direct)', pageviews: 8 }, { host: 'google.com', pageviews: 4 }], unavailable: [] }
}
const failure = code => error => error instanceof api.MetricsFailure && error.code === code
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Cache-Control': 'no-store', ...headers } })

test('UTC windows exclude end, reject impossible dates, future end and windows above90', () => {
  const now = Date.parse('2026-10-10T23:59:59Z')
  const preset = definitions.defaultMetricsRange(now)
  assert.equal(preset.start, '2026-09-10')
  assert.equal(preset.end, '2026-10-10')
  assert.equal(definitions.rangeError({ start: '2026-07-13', end: '2026-10-11' }, now), null)
  for (const window of [{ start: '2026-07-12', end: '2026-10-11' }, { start: '2026-02-30', end: '2026-03-03' }, { start: '2026-10-10', end: '2026-10-10' }, { start: '2026-10-10', end: '2026-10-12' }]) assert.ok(definitions.rangeError(window, now))
})
test('period distinct browser IDs are not the sum of daily distinct counts; unknown provider fields stripped', () => {
  const data = result()
  data.secret = 'must not propagate'
  data.daily[0].distinct_id = 'must not propagate'
  const parsed = api.parseMetrics(data, range)
  assert.equal(parsed.totals.browserIds, 5)
  assert.equal(parsed.daily.reduce((sum, row) => sum + row.browserIds, 0), 7)
  assert.equal(parsed.secret, undefined)
  assert.equal(parsed.daily[0].distinct_id, undefined)
})
test('partial unavailable totals stay null, while genuine empty complete counts stay zero', () => {
  const partial = result()
  partial.status = 'partial'; partial.totals = null; partial.unavailable = ['totals']
  assert.equal(api.parseMetrics(partial, range).totals, null)
  const empty = result()
  empty.totals = { pageviews: 0, browserIds: 0 }; empty.daily.forEach(row => { row.pageviews = 0; row.browserIds = 0 }); empty.topPages = []; empty.topReferrers = []
  assert.equal(api.parseMetrics(empty, range).totals.pageviews, 0)
})
test('rejects inconsistent aggregates, omitted UTC day, malformed/private labels and wrong requested window', () => {
  const mutations = [data => { data.totals.pageviews++ }, data => { data.daily.pop() }, data => { data.daily[1].date = '2026-09-01' }, data => { data.totals.browserIds = 13 }, data => { data.topPages[0].path = '/?private=query' }, data => { data.topPages[0].path = '//foreign.example/' }, data => { data.topPages[0].path = '/%3Fprivate' }, data => { data.topReferrers[0].host = 'https://example.com/private' }, data => { data.topReferrers[0].host = 'bad..example' }, data => { data.topPages[0] = null }, data => { data.range.end = '2026-09-04' }, data => { data.status = 'partial' }, data => { data.unavailable = ['daily']; data.status = 'partial' }]
  for (const mutate of mutations) { const data = result(); mutate(data); assert.throws(() => api.parseMetrics(data, range), failure('UNAVAILABLE')) }
})
test('fixed authenticated GET is no-store, no browser PostHog credential, and invalid windows never fetch', async () => {
  let request
  const signal = new AbortController().signal
  await api.getMetrics('https://owner-api.example', 'owner-token', range, signal, async (url, options) => { request = { url, options }; return response(result()) })
  assert.equal(request.url, 'https://owner-api.example/v1/metrics?start=2026-09-01&end=2026-09-03')
  assert.equal(request.options.headers.Authorization, 'Bearer owner-token')
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.signal, signal)
  await assert.rejects(api.getMetrics('https://owner-api.example', 'owner-token', { start: 'bad', end: range.end }, signal, () => { throw new Error('must not fetch') }), failure('INVALID_RANGE'))
})
test('disconnected, auth, rate limit and invalid upstream result are never fabricated as traffic', async () => {
  const signal = new AbortController().signal
  for (const [body, status, code] of [[{ error: { code: 'METRICS_NOT_CONNECTED' } }, 503, 'DISCONNECTED'], [{ error: { code: 'OTHER' } }, 503, 'UNAVAILABLE'], [{}, 429, 'RATE_LIMITED'], [{}, 200, 'UNAVAILABLE']]) await assert.rejects(api.getMetrics('https://owner-api.example', 'token', range, signal, async () => response(body, status)), failure(code))
  for (const status of [401, 403]) await assert.rejects(api.getMetrics('https://owner-api.example', 'token', range, signal, async () => response({}, status)), error => error.kind === (status === 401 ? 'expired' : 'denied'))
  await assert.rejects(api.getMetrics('https://owner-api.example', 'token', range, signal, async () => response({}, 429, { 'Retry-After': '99999' })), error => error.code === 'RATE_LIMITED' && Date.parse(error.retryAt) <= Date.now() + 3600_000)
  await assert.rejects(api.getMetrics('https://owner-api.example', 'token', range, signal, async () => response(result(), 200, { 'Cache-Control': 'public,max-age=60' })), failure('UNAVAILABLE'))
})
