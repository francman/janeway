const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')

const API = 'https://fixture.execute-api.us-east-1.amazonaws.com'
const OWNER = 'owner-sub'
const SCOPE = 'fixture-pool|fixture-client|fixture-api'
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const OPERATION = '73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_OPERATION = '83cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const VALIDATION = '54c69aa4-ae81-4a91-a5d0-e16b4765e20c'
const UPLOAD = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const CURRENT = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const PUBLISHED = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEWER = '43cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const metadata = (publicationId = CURRENT, sha256 = 'a'.repeat(64), etag = '"reviewed-pointer"') => ({ schemaVersion: 1, publicationId, key: `documents/resume/revisions/${sha256}/inline/frank-manu-resume.pdf`, sha256, bytes: 100, publishedAt: new Date(NOW - 1000).toISOString(), publicUrl: 'https://www.frankmanu.com/resume.pdf', etag })
const receipt = () => ({ schemaVersion: 1, validationId: VALIDATION, uploadId: UPLOAD, key: `uploads/${OWNER}/${UPLOAD}/file.pdf`, versionId: 'exact-version', sha256: 'b'.repeat(64), bytes: 200, pageCount: 2, validatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() })
const published = () => ({ ...metadata(PUBLISHED, 'b'.repeat(64), '"committed-pointer"'), bytes: 200 })
const outcome = (status = 'committed', operationId = OPERATION, extra = {}) => ({ operationId, status, createdAt: new Date(NOW).toISOString(), ...(status === 'committed' || status === 'superseded' ? { result: published() } : {}), ...extra })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
const deferred = () => Promise.withResolvers()
function clockDate(clock) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])) }
    static now() { return clock.now }
  }
}
function libraries(globals = {}) {
  const modules = new Map()
  function load(name) {
    const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const context = vm.createContext({ module, exports: module.exports, URL, AbortController, AbortSignal, Response, TextDecoder, TextEncoder, fetch, Date: clockDate({ now: NOW }), setTimeout, clearTimeout, ...globals, require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) } })
    new vm.Script(code, { filename }).runInContext(context)
    modules.set(filename, module.exports)
    return module.exports
  }
  return load
}
const load = libraries()
const api = load('resume-publication')
const signal = () => new AbortController().signal
const failure = code => error => error instanceof api.PublicationFailure && error.code === code
class Storage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

test('publication sends only explicit confirmation with a frozen opaque precondition and GET never carries a mutation', async () => {
  const requests = [], etag = '"opaque/not-a-number=42"'
  const transport = async (url, options) => { requests.push({ url, options }); return response(outcome(), options.method === 'POST' ? 201 : 200) }
  await api.publishResume(API, 'synthetic-token', VALIDATION, etag, OPERATION, signal(), transport)
  await api.getResumePublication(API, 'synthetic-token', OPERATION, signal(), transport)
  assert.equal(requests[0].url, API + '/v1/resume/publications')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers['If-Match'], etag)
  assert.equal(requests[0].options.headers['Idempotency-Key'], OPERATION)
  assert.deepEqual(JSON.parse(requests[0].options.body), { validationId: VALIDATION, confirm: true })
  assert.equal(requests[1].url, API + '/v1/resume/publications/' + OPERATION)
  assert.equal(requests[1].options.method, 'GET')
  assert.equal(requests[1].options.body, undefined)
  assert.equal(requests[1].options.headers['If-Match'], undefined)
  for (const { options } of requests) {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
  }
  for (const [id, tag] of [[OPERATION, '*'], ['../owner', etag], [OPERATION, '"bad\r\nheader"'], [OPERATION, 'W/"weak"']]) {
    await assert.rejects(api.publishResume(API, 'token', VALIDATION, tag, id, signal(), () => { throw new Error('must not fetch') }), failure('INVALID_REQUEST'))
  }
})

test('domain conflict and known failure are not transport failures, while uncertainty is never fabricated as failed', async () => {
  for (const [status, http, errorCode] of [['conflict', 412, 'PRECONDITION_FAILED'], ['failed', 422, 'SOURCE_INTEGRITY'], ['unknown', 202, 'OUTCOME_UNCERTAIN'], ['in_progress', 202, undefined], ['superseded', 200, undefined]]) {
    const result = await api.publishResume(API, 'token', VALIDATION, '"etag"', OPERATION, signal(), async () => response(outcome(status, OPERATION, errorCode ? { errorCode } : {}), http))
    assert.equal(result.status, status)
  }
  await assert.rejects(api.publishResume(API, 'token', VALIDATION, '"etag"', OPERATION, signal(), async () => { throw new Error('lost response') }), failure('UNAVAILABLE'))
  await assert.rejects(api.getResumePublication(API, 'token', OPERATION, signal(), async () => response({ error: { code: 'NOT_FOUND', requestId: 'bounded-id', message: 'private-server-detail' } }, 404)), error => error.code === 'OPERATION_NOT_FOUND' && error.requestId === 'bounded-id' && !error.message.includes('private-server-detail'))
})

test('status results bind the requested operation, safe public metadata, required ETags and bounded bodies', async () => {
  const malformed = [
    outcome('committed', NEXT_OPERATION), outcome('committed', OPERATION, { result: undefined }),
    outcome('unknown', OPERATION, { result: published() }), outcome('committed', OPERATION, { createdAt: '2026-10-10T12:00:00Z' }),
    outcome('committed', OPERATION, { createdAt: new Date(NOW + 60000).toISOString() }),
    outcome('committed', OPERATION, { errorCode: 'PRIVATE_STACK_TRACE' }), outcome('committed', OPERATION, { privateReceipt: 'secret' }),
    outcome('committed', OPERATION, { result: { ...published(), etag: undefined } }),
    outcome('committed', OPERATION, { result: { ...published(), publicUrl: 'https://attacker.invalid/resume.pdf' } }),
    outcome('committed', OPERATION, { result: { ...published(), key: 'uploads/other/private.pdf' } }),
    outcome('committed', OPERATION, { current: metadata(NEWER) }),
    outcome('superseded', OPERATION, { current: published() }),
  ]
  for (const value of malformed) await assert.rejects(api.getResumePublication(API, 'token', OPERATION, signal(), async () => response(value)), failure('UNAVAILABLE'))
  await assert.rejects(api.getResumePublication(API, 'token', OPERATION, signal(), async () => response(outcome(), 200, { 'Cache-Control': 'private,max-age=60' })), failure('UNAVAILABLE'))
  await assert.rejects(api.publishResume(API, 'token', VALIDATION, '"etag"', OPERATION, signal(), async () => response(outcome('failed'), 201)), failure('UNAVAILABLE'))
  let canceled = false
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17000)) }, cancel() { canceled = true } })
  await assert.rejects(api.getResumePublication(API, 'token', OPERATION, signal(), async () => new Response(huge, { headers: { 'Cache-Control': 'no-store' } })), failure('UNAVAILABLE'))
  assert.equal(canceled, true)
  await assert.rejects(api.getResumePublication(API, 'token', OPERATION, signal(), async () => response(outcome('committed', OPERATION, { current: { ...published(), sha256: 'c'.repeat(64), key: `documents/resume/revisions/${'c'.repeat(64)}/inline/frank-manu-resume.pdf` } }))), failure('UNAVAILABLE'))
  const parsed = api.parsePublicationOutcome(outcome('committed', OPERATION, { result: { ...published(), privateVersion: 'secret' } }), OPERATION)
  assert.equal(parsed.result.privateVersion, undefined)
})

test('review snapshots bind owner, exact validation, preview, selection, expiry and ETag without mutable aliases', () => {
  const selected = receipt(), current = metadata()
  const review = api.capturePublicationReview(selected, 'selected.pdf', true, current, OPERATION, OWNER)
  current.etag = '"changed"'; selected.sha256 = 'c'.repeat(64)
  assert.equal(review.expectedEtag, '"reviewed-pointer"')
  assert.equal(review.receipt.sha256, 'b'.repeat(64))
  assert.equal(api.canConfirmPublication(review, receipt(), 'selected.pdf', true, OWNER), true)
  assert.equal(api.canConfirmPublication(review, receipt(), 'selected.pdf', false, OWNER), false)
  assert.equal(api.canConfirmPublication(review, receipt(), 'another.pdf', true, OWNER), false)
  assert.equal(api.canConfirmPublication(review, receipt(), 'selected.pdf', true, 'other-owner'), false)
  assert.equal(api.canConfirmPublication(review, { ...receipt(), validationId: UPLOAD }, 'selected.pdf', true, OWNER), false)
  assert.equal(api.canConfirmPublication(review, receipt(), 'selected.pdf', true, OWNER, NOW + 3600000), false)
  assert.throws(() => api.capturePublicationReview(receipt(), 'selected.pdf', false, metadata(), OPERATION, OWNER), failure('INVALID_REQUEST'))
  assert.throws(() => api.capturePublicationReview({ ...receipt(), key: `uploads/other/${UPLOAD}/file.pdf` }, 'selected.pdf', true, metadata(), OPERATION, OWNER), failure('INVALID_REQUEST'))
})

test('recovery storage is per owner and configuration, contains only a UUID and rejects malformed checkpoint capabilities', () => {
  const storage = new Storage()
  api.savePublicationCheckpoint(storage, SCOPE, OWNER, OPERATION)
  assert.deepEqual([...storage.values.values()], [OPERATION])
  assert.equal(api.readPublicationCheckpoint(storage, SCOPE, OWNER), OPERATION)
  assert.equal(api.readPublicationCheckpoint(storage, SCOPE, 'other-owner'), null)
  assert.equal(api.readPublicationCheckpoint(storage, 'other-environment', OWNER), null)
  storage.setItem(api.publicationCheckpointKey(SCOPE, OWNER), '../other-owner/private')
  assert.equal(api.readPublicationCheckpoint(storage, SCOPE, OWNER), null)
})

function sessionFixture(t) {
  const clock = { now: NOW }, state = { refreshes: 0, requests: [] }
  const config = { origin: 'https://admin.fixture.test', authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', clientId: 'fixture-client', loginId: 'owner@example.test', apiUrl: API, previewOrigin: 'https://janeway-resume-staging-111122223333-us-east-1.s3.us-east-1.amazonaws.com' }
  const user = { accessToken: 'synthetic-access', sub: OWNER, username: 'canonical-owner', deviceKey: 'fixture-device', issuer: config.authority, clientId: config.clientId, authTime: NOW / 1000, expiresAt: NOW / 1000 + 300 }
  let refresh = async () => ({ ...user, accessToken: 'synthetic-rotated', expiresAt: clock.now / 1000 + 300 })
  let transport = async url => response(url.endsWith('/session') ? { owner: { sub: OWNER }, authenticatedAt: user.authTime, expiresAt: clock.now / 1000 + 300, device: { key: user.deviceKey, createdAt: new Date(NOW - 1000).toISOString() } } : outcome())
  const auth = { signIn: async () => ({ kind: 'done', user }), refresh: async () => { state.refreshes++; return refresh() }, clear() {}, isTrusted: () => false, forgetLocal() {} }
  const modules = libraries({ Date: clockDate(clock), setTimeout: () => 1, clearTimeout() {} })
  const client = new (modules('session').OwnerSessionClient)(config, auth, async (url, options) => { state.requests.push({ url, options }); return transport(url, options) }, () => clock.now / 1000)
  t.after(() => client.clear('expired'))
  return { client, clock, state, start: () => client.signIn(config.loginId, 'synthetic-password', false), setRefresh(fn) { refresh = fn }, setTransport(fn) { transport = fn } }
}

test('publication methods share serialized refresh and owner generation safety without exposing tokens', async t => {
  const fixture = sessionFixture(t); await fixture.start()
  fixture.clock.now += 250000
  const pending = deferred(); fixture.setRefresh(() => pending.promise)
  const first = fixture.client.publishResume(VALIDATION, '"reviewed"', OPERATION)
  const second = fixture.client.getResumePublication(OPERATION)
  await Promise.resolve()
  assert.equal(fixture.state.refreshes, 1)
  pending.resolve({ accessToken: 'synthetic-rotated', sub: OWNER, username: 'canonical-owner', deviceKey: 'fixture-device', issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', clientId: 'fixture-client', authTime: NOW / 1000, expiresAt: fixture.clock.now / 1000 + 300 })
  await Promise.all([first, second])
  const requests = fixture.state.requests.filter(request => request.url.includes('/publications'))
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.options.headers.Authorization === 'Bearer synthetic-rotated'))
  assert.equal(fixture.client.getSnapshot().accessToken, undefined)
})

test('cancelled or post-logout publication responses cannot be accepted even when transport ignores abort', async t => {
  for (const action of ['cancel', 'logout']) {
    const fixture = sessionFixture(t); await fixture.start()
    const pending = deferred(); fixture.setTransport(() => pending.promise)
    const controller = new AbortController()
    const work = fixture.client.getResumePublication(OPERATION, controller.signal)
    for (let round = 0; round < 5; round++) await Promise.resolve()
    const request = fixture.state.requests.at(-1)
    if (action === 'cancel') controller.abort(); else fixture.client.clear('expired')
    assert.equal(request.options.signal.aborted, true)
    pending.resolve(response(outcome()))
    await assert.rejects(work, error => error.kind === (action === 'cancel' ? 'unavailable' : 'expired'))
    assert.equal(fixture.client.getSnapshot().status, action === 'cancel' ? 'authenticated' : 'expired')
  }
})

