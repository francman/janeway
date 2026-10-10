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

function publicationFixture(t, operations = {}, storage = new Storage(), initial = {}) {
  const clock = { now: NOW }, slots = [], effects = [], timers = new Map(), documentListeners = new Map(), listeners = new Set(), calls = [], activity = []
  let cursor = 0, dirty = false, mounted = true, tree, timerId = 0, uuidIndex = 0
  let snapshot = { status: 'authenticated', session: { owner: { sub: OWNER } }, resume: metadata(), resumeStatus: 'ready' }
  let props = { receipt: receipt(), filename: 'selected.pdf', previewAvailable: true, previewExpiresAt: new Date(NOW + 300000).toISOString(), ...initial }
  const client = {
    publicationScope: SCOPE, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async loadResume() {
      calls.push({ method: 'GET', resource: 'current' })
      const next = operations.current ? await operations.current() : snapshot.resume
      if (snapshot.status !== 'authenticated') return
      snapshot = { ...snapshot, resume: next, resumeStatus: next ? 'ready' : 'unavailable' }
      for (const listener of listeners) listener()
    },
    async publishResume(validationId, expectedEtag, operationId, signal) {
      calls.push({ method: 'POST', validationId, expectedEtag, operationId, signal, checkpoint: [...storage.values.values()] })
      return operations.publish ? operations.publish(operationId, signal) : outcome('unknown', operationId, { errorCode: 'OUTCOME_UNCERTAIN' })
    },
    async getResumePublication(operationId, signal) {
      calls.push({ method: 'GET', resource: 'operation', operationId, signal })
      return operations.get ? operations.get(operationId, signal) : outcome('unknown', operationId, { errorCode: 'OUTCOME_UNCERTAIN' })
    },
  }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true } }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(setup, dependencies) {
      const index = cursor++, previous = slots[index]
      if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: setup() } })
    },
  }
  const componentLibrary = libraries({ Date: clockDate(clock) })
  const jsx = (type, props) => ({ type, props })
  const filename = path.resolve(__dirname, '../src/components/resume-publication.tsx'), module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const context = vm.createContext({
    module, exports: module.exports, Date: clockDate(clock), AbortController, crypto: { randomUUID: () => [OPERATION, NEXT_OPERATION][uuidIndex++] }, window: { sessionStorage: storage },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock.now + delay }); return id }, clearTimeout(id) { timers.delete(id) },
    document: { addEventListener(name, callback) { documentListeners.set(name, callback) }, removeEventListener(name, callback) { if (documentListeners.get(name) === callback) documentListeners.delete(name) } },
    require(specifier) {
      if (specifier === 'react') return hooks
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (specifier === '@janeway/ui/button') return { Button: 'button' }
      if (specifier === '../lib/resume-publication') return componentLibrary('resume-publication')
      throw new Error('Unexpected dependency: ' + specifier)
    },
  })
  new vm.Script(code, { filename }).runInContext(context)
  const onActiveChange = active => activity.push(active)
  function render() {
    if (!mounted) return
    do { dirty = false; cursor = 0; tree = module.exports.ResumePublication({ client, ...props, onActiveChange }); for (const effect of effects.splice(0)) effect() } while (dirty)
  }
  function nodes(type) {
    const result = []
    function visit(node) { if (Array.isArray(node)) { node.forEach(visit); return } if (!node || typeof node !== 'object') return; if (node.type === type) result.push(node); visit(node.props?.children) }
    visit(tree); return result
  }
  function text(node = tree) { if (Array.isArray(node)) return node.map(text).join(' '); return node && typeof node === 'object' ? text(node.props?.children) : node === null || node === undefined || node === false ? '' : String(node) }
  function button(name) { return nodes('button').find(node => text(node) === name) }
  function unmount() { if (!mounted) return; mounted = false; for (const slot of slots) slot?.cleanup?.() }
  render(); t.after(unmount)
  return {
    calls, storage, activity, clock, nodes, text, button, render, unmount,
    async settle() { for (let round = 0; round < 40; round++) { await Promise.resolve(); if (dirty) render() } },
    click(name) { const node = button(name); assert.ok(node && !node.props.disabled, name); node.props.onClick(); render() },
    toggle(index = 0, checked = true) { const node = nodes('input')[index]; assert.ok(node && !node.props.disabled); node.props.onChange({ target: { checked } }); render() },
    update(next) { props = { ...props, ...next }; render() },
    metadata(next) { snapshot = { ...snapshot, resume: next, resumeStatus: next ? 'ready' : 'unavailable' }; for (const listener of listeners) listener(); render() },
    session(status, owner = OWNER) { snapshot = { ...snapshot, status, session: status === 'authenticated' ? { owner: { sub: owner } } : null, resume: null, resumeStatus: 'idle' }; for (const listener of listeners) listener(); render() },
    advance(milliseconds, fireTimers = true) { clock.now += milliseconds; if (fireTimers) for (const [id, timer] of [...timers]) if (timer.at <= clock.now) { timers.delete(id); timer.callback() } render() },
    visible() { documentListeners.get('visibilitychange')?.(); render() },
  }
}
async function reviewAndConfirm(ui) { ui.click('Review publication'); await ui.settle(); ui.toggle() }

test('owner review displays both bound revisions and explicit approval uses the frozen ETag despite metadata refresh', async t => {
  const ui = publicationFixture(t)
  assert.equal(ui.calls.some(call => call.method === 'POST'), false)
  ui.click('Review publication'); await ui.settle()
  const details = ui.nodes('dd').map(ui.text)
  assert.ok(details.includes('a'.repeat(64)))
  assert.ok(details.includes('b'.repeat(64)))
  assert.equal(ui.button('Publish résumé').props.disabled, true)
  ui.toggle()
  ui.metadata(metadata(NEWER, 'c'.repeat(64), '"new-pointer"'))
  ui.click('Publish résumé'); await ui.settle()
  const posts = ui.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].validationId, VALIDATION)
  assert.equal(posts[0].expectedEtag, '"reviewed-pointer"')
  assert.equal(posts[0].operationId, OPERATION)
  assert.deepEqual(posts[0].checkpoint, [OPERATION])
  assert.equal(ui.activity.includes(true), true)
  assert.equal(ui.button('Publish résumé'), undefined)
})

test('selection or preview changes invalidate approval and stale-clock expiry cannot start a publication', async t => {
  for (const change of [{ filename: 'different.pdf' }, { receipt: { ...receipt(), validationId: UPLOAD } }, { previewAvailable: false }]) {
    const ui = publicationFixture(t)
    await reviewAndConfirm(ui)
    ui.update(change)
    assert.equal(ui.button('Publish résumé'), undefined)
    assert.equal(ui.calls.some(call => call.method === 'POST'), false)
  }
  const ui = publicationFixture(t)
  await reviewAndConfirm(ui)
  const staleClick = ui.button('Publish résumé').props.onClick
  ui.advance(3600000, false)
  staleClick(); await ui.settle()
  assert.equal(ui.calls.some(call => call.method === 'POST'), false)
  assert.equal(ui.button('Publish résumé'), undefined)
  const previewExpiry = publicationFixture(t)
  await reviewAndConfirm(previewExpiry)
  const stalePreviewClick = previewExpiry.button('Publish résumé').props.onClick
  previewExpiry.advance(300000, false)
  stalePreviewClick(); await previewExpiry.settle()
  assert.equal(previewExpiry.calls.some(call => call.method === 'POST'), false)
  assert.equal(previewExpiry.button('Publish résumé'), undefined)
})

test('receipt expiry during a POST preserves the operation and GET-only reconciliation after expiry', async t => {
  const pending = deferred()
  const ui = publicationFixture(t, { publish: () => pending.promise, get: id => outcome('committed', id), current: () => published() })
  await reviewAndConfirm(ui)
  ui.click('Publish résumé')
  const request = ui.calls.find(call => call.method === 'POST')
  ui.advance(3600000)
  ui.update({ receipt: null, previewAvailable: false })
  assert.equal(request.signal.aborted, false)
  assert.deepEqual([...ui.storage.values.values()], [OPERATION])
  pending.resolve(outcome('unknown')); await ui.settle()
  ui.click('Check outcome'); await ui.settle()
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(ui.calls.filter(call => call.resource === 'operation').length, 1)
  const publicLink = ui.nodes('button').find(node => node.props.href === 'https://www.frankmanu.com/resume.pdf')
  assert.ok(publicLink)
  assert.equal(publicLink.props.target, '_blank')
  assert.equal(ui.button('Read current and start a new review').props.disabled, true)
})

test('unknown result locks duplicate approval, and acknowledged manual review reads fresh current with a new UUID', async t => {
  let current = metadata()
  const ui = publicationFixture(t, { current: () => current })
  await reviewAndConfirm(ui)
  ui.click('Publish résumé'); await ui.settle()
  assert.equal(ui.button('Publish résumé'), undefined)
  assert.equal(ui.button('Read current and start a new review').props.disabled, true)
  ui.click('Check outcome'); await ui.settle()
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1)
  current = metadata(NEWER, 'c'.repeat(64), '"fresh-pointer"')
  ui.toggle()
  ui.click('Read current and start a new review'); await ui.settle()
  assert.equal(ui.button('Publish résumé').props.disabled, true)
  assert.equal(ui.storage.values.size, 0)
  ui.toggle(); ui.click('Publish résumé'); await ui.settle()
  const posts = ui.calls.filter(call => call.method === 'POST')
  assert.deepEqual(posts.map(call => [call.operationId, call.expectedEtag]), [[OPERATION, '"reviewed-pointer"'], [NEXT_OPERATION, '"fresh-pointer"']])
})

test('conflict and failed results never automatically retry or reuse an approval', async t => {
  for (const [status, errorCode] of [['conflict', 'PRECONDITION_FAILED'], ['failed', 'SOURCE_INTEGRITY']]) {
    const ui = publicationFixture(t, { publish: id => outcome(status, id, { errorCode }) })
    await reviewAndConfirm(ui)
    ui.click('Publish résumé'); await ui.settle()
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(ui.nodes('button').some(node => node.props.href), false)
    assert.equal(ui.button('Publish résumé'), undefined)
    ui.click('Check outcome'); await ui.settle()
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('a newly uncertain outcome requires fresh acknowledgement before clearing recovery', async t => {
  const ui = publicationFixture(t, {
    publish: id => outcome('committed', id),
    get: async () => { throw new Error('Connection lost') },
    current: () => published(),
  })
  await reviewAndConfirm(ui)
  ui.click('Publish résumé'); await ui.settle()
  ui.toggle()
  assert.equal(ui.button('Dismiss acknowledged outcome').props.disabled, false)
  ui.click('Check outcome'); await ui.settle()
  assert.equal(ui.nodes('input')[0].props.checked, false)
  assert.equal(ui.button('Dismiss acknowledged outcome').props.disabled, true)
  assert.equal(ui.button('Read current and start a new review').props.disabled, true)
  assert.deepEqual([...ui.storage.values.values()], [OPERATION])
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1)
})

test('historical committed and superseded outcomes expose only the stable public route without mutation replay', async t => {
  for (const [status, current] of [['committed', null], ['committed', metadata(NEWER)], ['superseded', metadata(NEWER)]]) {
    const storage = new Storage(); api.savePublicationCheckpoint(storage, SCOPE, OWNER, OPERATION)
    const ui = publicationFixture(t, { get: id => outcome(status, id), current: () => current }, storage, { receipt: null, filename: '', previewAvailable: false })
    await ui.settle()
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0)
    const links = ui.nodes('button').filter(node => node.props.href)
    assert.equal(links.length, 1)
    assert.equal(links[0].props.href, 'https://www.frankmanu.com/resume.pdf')
    assert.equal(links[0].props.target, '_blank')
    assert.equal(links[0].props.rel, 'noopener noreferrer')
  }
})

test('reload reconciles only the scoped UUID without receipt or preview, and explicit acknowledgement alone dismisses recovery', async t => {
  const storage = new Storage(); api.savePublicationCheckpoint(storage, SCOPE, OWNER, OPERATION)
  const first = publicationFixture(t, {}, storage, { receipt: null, filename: '', previewAvailable: false })
  await first.settle()
  assert.deepEqual(first.calls.filter(call => call.resource === 'operation').map(call => call.operationId), [OPERATION])
  first.unmount()
  assert.deepEqual([...storage.values.values()], [OPERATION])
  const reloaded = publicationFixture(t, {}, storage, { receipt: null, filename: '', previewAvailable: false })
  await reloaded.settle()
  assert.equal(reloaded.calls.filter(call => call.method === 'POST').length, 0)
  assert.equal(reloaded.button('Dismiss acknowledged outcome').props.disabled, true)
  reloaded.toggle(); reloaded.click('Dismiss acknowledged outcome')
  assert.equal(storage.values.size, 0)
  const anotherOwner = new Storage(); api.savePublicationCheckpoint(anotherOwner, SCOPE, 'other-owner', OPERATION)
  const isolated = publicationFixture(t, {}, anotherOwner)
  await isolated.settle()
  assert.equal(isolated.calls.length, 0)
})

test('logout and unmount abort requests, clear private summaries, ignore late success and retain the recovery UUID', async t => {
  for (const action of ['logout', 'unmount']) {
    const pending = deferred(), ui = publicationFixture(t, { publish: () => pending.promise, current: () => published() })
    await reviewAndConfirm(ui)
    ui.click('Publish résumé')
    const request = ui.calls.find(call => call.method === 'POST')
    if (action === 'logout') ui.session('expired'); else ui.unmount()
    assert.equal(request.signal.aborted, true)
    pending.resolve(outcome()); await ui.settle()
    assert.deepEqual([...ui.storage.values.values()], [OPERATION])
    assert.equal(ui.calls.filter(call => call.resource === 'current').length, 1)
    if (action === 'logout') {
      assert.equal(ui.nodes('button').some(node => node.props.href), false)
      assert.equal(ui.nodes('dd').length, 0)
      assert.equal(ui.text().includes(PUBLISHED), false)
    }
  }
})

test('late recovery from another owner and a mismatched committed PDF cannot produce a success preview', async t => {
  const pending = deferred(), storage = new Storage(); api.savePublicationCheckpoint(storage, SCOPE, OWNER, OPERATION)
  const ui = publicationFixture(t, { get: () => pending.promise }, storage, { receipt: null, filename: '', previewAvailable: false })
  const request = ui.calls.find(call => call.resource === 'operation')
  ui.session('authenticated', 'other-owner')
  pending.resolve(outcome()); await ui.settle()
  assert.equal(request.signal.aborted, true)
  assert.equal(ui.nodes('button').some(node => node.props.href), false)
  assert.equal(ui.text().includes(PUBLISHED), false)
  const mismatch = publicationFixture(t, { publish: id => outcome('committed', id, { result: metadata(PUBLISHED, 'd'.repeat(64)) }) })
  await reviewAndConfirm(mismatch); mismatch.click('Publish résumé'); await mismatch.settle()
  assert.equal(mismatch.nodes('button').some(node => node.props.href), false)
  assert.equal(mismatch.button('Publish résumé'), undefined)
})

test('failed checkpoint persistence prevents sending an approved mutation', async t => {
  const storage = new Storage(); storage.setItem = () => { throw new Error('storage disabled') }
  const ui = publicationFixture(t, {}, storage)
  await reviewAndConfirm(ui); ui.click('Publish résumé'); await ui.settle()
  assert.equal(ui.calls.some(call => call.method === 'POST'), false)
  assert.equal(storage.values.size, 0)
})

function sessionFixture(t) {
  const clock = { now: NOW }, state = { refreshes: 0, requests: [] }
  const config = { origin: 'https://admin.fixture.test', authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', clientId: 'fixture-client', loginId: 'owner@example.test', apiUrl: API, previewOrigin: 'https://janeway-resume-staging-111122223333-us-east-1.s3.us-east-1.amazonaws.com' }
  const user = { accessToken: 'synthetic-access', sub: OWNER, username: 'canonical-owner', deviceKey: 'fixture-device', issuer: config.authority, clientId: config.clientId, scope: 'janeway-admin/access', authTime: NOW / 1000, expiresAt: NOW / 1000 + 300, loginKind: 'fresh' }
  let refresh = async () => ({ ...user, accessToken: 'synthetic-rotated', expiresAt: clock.now / 1000 + 300, loginKind: 'refresh' })
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
  pending.resolve({ accessToken: 'synthetic-rotated', sub: OWNER, username: 'canonical-owner', deviceKey: 'fixture-device', issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', clientId: 'fixture-client', scope: 'janeway-admin/access', authTime: NOW / 1000, expiresAt: fixture.clock.now / 1000 + 300, loginKind: 'refresh' })
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

test('late current metadata cannot create a review for a changed or expired selection', async t => {
  for (const action of ['change-selection', 'expire-preview']) {
    const pending = deferred(), ui = publicationFixture(t, { current: () => pending.promise })
    ui.click('Review publication')
    if (action === 'change-selection') ui.update({ receipt: { ...receipt(), validationId: UPLOAD }, filename: 'changed.pdf' })
    else ui.advance(300000, false)
    pending.resolve(metadata()); await ui.settle()
    assert.equal(ui.button('Publish résumé'), undefined)
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(ui.storage.values.size, 0)
  }
})

test('an unreadable later status withdraws the confirmed-outcome link without erasing GET-only recovery', async t => {
  let unavailable = false
  const storage = new Storage(); api.savePublicationCheckpoint(storage, SCOPE, OWNER, OPERATION)
  const ui = publicationFixture(t, {
    get: id => { if (unavailable) throw new Error('status unavailable'); return outcome('committed', id) },
    current: () => published(),
  }, storage, { receipt: null, filename: '', previewAvailable: false })
  await ui.settle()
  assert.equal(ui.nodes('button').some(node => node.props.href === 'https://www.frankmanu.com/resume.pdf'), true)
  unavailable = true
  ui.click('Check outcome'); await ui.settle()
  assert.equal(ui.nodes('button').some(node => node.props.href), false)
  assert.deepEqual([...storage.values.values()], [OPERATION])
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0)
  assert.equal(ui.button('Dismiss acknowledged outcome').props.disabled, true)
})

test('active publication prevents uploader selection and validation changes through programmatic control events', async () => {
  const slots = [], calls = [], previews = []
  let cursor = 0, tree
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(callback) { cursor++; return callback },
    useEffect() { cursor++ },
  }
  const client = {
    getSnapshot: () => ({ status: 'authenticated', session: { owner: { sub: OWNER } } }),
    authorizeResumeUpload() { calls.push('authorize'); throw new Error('must not authorize while publication is active') },
  }
  class LocalURL extends URL {
    static createObjectURL(file) { previews.push(file.name); return 'blob:' + file.name }
    static revokeObjectURL() {}
  }
  const jsx = (type, props) => ({ type, props }), module = { exports: {} }
  const filename = path.resolve(__dirname, '../src/components/resume-uploader.tsx')
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new vm.Script(code, { filename }).runInContext(vm.createContext({
    module, exports: module.exports, URL: LocalURL, AbortController, Date,
    require(specifier) {
      if (specifier === 'react') return hooks
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (specifier === '@janeway/ui/button') return { Button: 'button' }
      if (specifier === '../lib/resume-upload') return load('resume-upload')
      if (specifier === './resume-publication') return { ResumePublication: 'publication-panel' }
      throw new Error('Unexpected dependency: ' + specifier)
    },
  }))
  function render() { cursor = 0; tree = module.exports.ResumeUploader({ client }) }
  function nodes(type) {
    const found = []
    function visit(node) { if (Array.isArray(node)) { node.forEach(visit); return } if (!node || typeof node !== 'object') return; if (node.type === type) found.push(node); visit(node.props?.children) }
    visit(tree); return found
  }
  render()
  nodes('input')[0].props.onChange({ target: { files: [new File(['%PDF-selected'], 'selected.pdf', { type: 'application/pdf' })] } })
  render()
  nodes('publication-panel')[0].props.onActiveChange(true)
  render()
  assert.equal(nodes('input')[0].props.disabled, true)
  assert.equal(nodes('button')[0].props.disabled, true)
  nodes('input')[0].props.onChange({ target: { files: [new File(['%PDF-other'], 'other.pdf', { type: 'application/pdf' })] } })
  nodes('button')[0].props.onClick()
  await Promise.resolve()
  render()
  assert.deepEqual(calls, [])
  assert.deepEqual(previews, ['selected.pdf'])
  assert.equal(nodes('iframe')[0].props.src, 'blob:selected.pdf')
  nodes('publication-panel')[0].props.onActiveChange(false)
  render()
  assert.equal(nodes('input')[0].props.disabled, false)
  assert.equal(nodes('button')[0].props.disabled, false)
})
