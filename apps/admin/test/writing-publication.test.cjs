const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const API = 'https://fixture.execute-api.us-east-1.amazonaws.com'
const OWNER = 'owner-sub'
const DRAFT = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const REV = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_REV = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const BASE = '43cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const PUBLICATION = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OP = '63cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_OP = '73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const ASSET = '83cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const SLUG = 'fixture-writing'
const key = id => `articles/${SLUG}/revisions/${id}/page.mdx`
const iso = value => new Date(value).toISOString()
const plain = value => JSON.parse(JSON.stringify(value))
const source = title => `---\ntitle: "${title}"\ndescription: "Unchanged description"\nauthor: "Owner"\ndate: 2026-10-10\nstatus: PUBLISHED\n---\n\nCanonical ${title} body.\n`
const asset = () => ({ assetId: ASSET, name: 'image.png', bytes: 100, contentType: 'image/png', sha256: 'a'.repeat(64), width: 10, height: 20, key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, versionId: 'exact-private-version' })
const draft = extra => ({ schemaVersion: 1, draftId: DRAFT, label: 'Private label', targetSlug: SLUG, revision: REV, createdAt: iso(NOW - 1000), updatedAt: iso(NOW), sourceMdx: source('Saved'), assets: [asset()], basePublished: { slug: SLUG, s3Key: key(BASE) }, ...extra })
const current = extra => ({ slug: SLUG, title: 'Current', s3Key: key(BASE), sourceMdx: source('Current'), assets: [{ name: 'image.png', bytes: 90, contentType: 'image/png' }], unsupportedAssets: [], ...extra })
const preview = extra => ({ draftId: DRAFT, revision: REV, html: '<p>Actual private rendered body</p>', fieldErrors: [], expiresAt: iso(NOW + 60000), ...extra })
const result = extra => ({ slug: SLUG, s3Key: key(PUBLICATION), previousPublishedKey: key(BASE), publicationId: PUBLICATION, draftRevision: NEXT_REV, publishedAt: '2026-10-10', updatedAt: iso(NOW), refreshPending: true, ...extra })
const outcome = (status = 'committed', extra = {}) => ({ operationId: OP, draftId: DRAFT, createdAt: iso(NOW), status, ...(['committed', 'superseded'].includes(status) ? { result: result() } : {}), ...extra })
const fresh = extra => draft({ revision: NEXT_REV, basePublished: { slug: SLUG, s3Key: key(PUBLICATION) }, ...extra })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
const signal = () => new AbortController().signal
function libraries(clock = { now: NOW }) {
  const modules = new Map()
  function load(name) {
    const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    modules.set(filename, module.exports)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new vm.Script(code, { filename }).runInNewContext({ module, exports: module.exports, URL, TextEncoder, TextDecoder, Response, AbortController, AbortSignal, fetch, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])) } static now() { return clock.now } }, require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) } })
    return module.exports
  }
  return load
}
const load = libraries(), api = load('writing-publication'), drafts = load('writing-drafts'), errors = load('api')
const failure = code => error => error instanceof api.WritingPublicationFailure && error.code === code
function fixture(overrides = {}, saved = draft(), clock) {
  const lib = clock ? libraries(clock)('writing-publication') : api
  const controller = new lib.WritingPublicationController(), calls = [], checkpoints = [], advanced = []
  const selection = { ownerSub: OWNER, saved, working: drafts.draftInput(saved), eligible: true }
  controller.setSelection(selection)
  controller.configure(value => { checkpoints.push(value); overrides.checkpoint?.(value) }, (saved, revision) => { advanced.push({ saved, revision }); return overrides.advance ? overrides.advance(saved, revision) : true })
  const client = {
    publicationScope: 'pool|client|api',
    async getPublishedWriting(slug, abortSignal) { calls.push({ type: 'current', slug, abortSignal }); return overrides.current ? overrides.current() : current() },
    async previewWritingDraft(id, revision, abortSignal) { calls.push({ type: 'preview', id, revision, abortSignal }); return overrides.preview ? overrides.preview() : preview() },
    async publishWriting(id, revision, expectedPublishedKey, operationId, abortSignal) { calls.push({ type: 'publish', id, revision, expectedPublishedKey, operationId, abortSignal }); return overrides.publish ? overrides.publish() : outcome('committed', { operationId }) },
    async getWritingPublication(operationId, abortSignal) { calls.push({ type: 'get', operationId, abortSignal }); return overrides.get ? overrides.get() : outcome('committed', { operationId }) },
    async getWritingDraft(id, abortSignal) { calls.push({ type: 'draft', id, abortSignal }); return overrides.draft ? overrides.draft() : fresh() },
    async refreshWritingPublication(operationId, abortSignal) { calls.push({ type: 'refresh', operationId, abortSignal }); return overrides.refresh ? overrides.refresh() : outcome('committed', { operationId, result: result({ refreshPending: false }) }) },
  }
  return { controller, client, calls, checkpoints, advanced, selection }
}

test('publish sends only exact frozen CAS/approval inputs; GET recovery and cache retry cannot replay publication', async () => {
  const calls = [], transport = async (url, init) => { calls.push({ url, ...init }); return response(outcome(), init.method === 'POST' && !url.endsWith('/refresh') ? 201 : 200) }
  await api.publishWriting(API, 'secret-token', DRAFT, REV, key(BASE), OP, signal(), transport)
  await api.getWritingPublication(API, 'secret-token', OP, signal(), transport)
  await api.refreshWritingPublication(API, 'secret-token', OP, signal(), transport)
  assert.equal(calls[0].url, `${API}/v1/writings/drafts/${DRAFT}/publications`)
  assert.equal(calls[0].headers['If-Match'], `"${REV}"`)
  assert.equal(calls[0].headers['Idempotency-Key'], OP)
  assert.deepEqual(JSON.parse(calls[0].body), { expectedPublishedKey: key(BASE), confirm: true })
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'POST'])
  assert.equal(calls[1].url, `${API}/v1/writings/publications/${OP}`)
  assert.equal(calls[2].url, `${API}/v1/writings/publications/${OP}/refresh`)
  for (const call of calls) { assert.equal(call.credentials, 'omit'); assert.equal(call.cache, 'no-store'); assert.equal(call.redirect, 'error') }
  for (const call of calls.slice(1)) { assert.equal(call.body, undefined); assert.equal(call.headers['If-Match'], undefined); assert.equal(call.headers['Idempotency-Key'], undefined) }
})

test('domain conflict and validation outcomes are data, while malformed proofs and status mismatches remain unavailable', async () => {
  for (const [status, http] of [['conflict', 412], ['failed', 422], ['unknown', 202], ['in_progress', 202]]) {
    const value = await api.publishWriting(API, 'token', DRAFT, REV, key(BASE), OP, signal(), async () => response(outcome(status), http))
    assert.equal(value.status, status)
  }
  for (const value of [outcome('committed', { operationId: NEXT_OP }), outcome('committed', { draftId: NEXT_OP }), outcome('committed', { result: result({ publicationId: BASE }) }), outcome('committed', { result: result({ draftRevision: REV }) }), outcome('committed', { result: result({ previousPublishedKey: null }) }), outcome('committed', { result: result({ publishedAt: '2026-02-30' }) }), outcome('committed', { current: { slug: SLUG, s3Key: key(BASE) } })]) {
    await assert.rejects(api.publishWriting(API, 'token', DRAFT, REV, key(BASE), OP, signal(), async () => response(value, 201)), failure('UNAVAILABLE'))
  }
  await assert.rejects(api.publishWriting(API, 'token', DRAFT, REV, key(BASE), OP, signal(), async () => response(outcome('failed'), 201)), failure('UNAVAILABLE'))
  await assert.rejects(api.getWritingPublication(API, 'token', OP, signal(), async () => response(outcome(), 200, { 'Cache-Control': 'private' })), failure('UNAVAILABLE'))
  assert.equal(api.parseWritingPublicationOutcome(outcome('superseded'), OP).current, undefined)
  assert.equal(api.parseWritingPublicationOutcome(outcome('superseded', { current: { slug: SLUG, s3Key: key(NEXT_OP) } }), OP).status, 'superseded')
})

test('missing records are not proof of failure and authentication/error payloads stay sanitized', async () => {
  await assert.rejects(api.getWritingPublication(API, 'token', OP, signal(), async () => response({ error: { code: 'NOT_FOUND' } }, 404)), failure('OPERATION_NOT_FOUND'))
  await assert.rejects(api.refreshWritingPublication(API, 'token', OP, signal(), async () => response({ error: { code: 'PUBLICATION_NOT_PROVEN' } }, 409)), failure('REFRESH_NOT_PROVEN'))
  await assert.rejects(api.getWritingPublication(API, 'token', OP, signal(), async () => new Response('private error details', { status: 401 })), error => error instanceof errors.ApiError && error.kind === 'expired')
  await assert.rejects(api.getWritingPublication(API, 'token', OP, signal(), async () => response({ error: { requestId: 'safe-reference', message: 'private details' } }, 500)), error => error.code === 'UNAVAILABLE' && error.requestId === 'safe-reference' && !error.message.includes('private details'))
  await assert.rejects(api.getWritingPublication(API, 'token', OP, signal(), async () => response({ private: 'x'.repeat(17000) })), failure('UNAVAILABLE'))
  await assert.rejects(api.publishWriting(API, 'token', DRAFT, REV, 'https://outside.invalid/page.mdx', OP, signal(), async () => { throw Error('should not transport invalid input') }), failure('INVALID_REQUEST'))
})

test('review freezes canonical source, saved revision/public base/assets and actual private preview without checking approval', async () => {
  const f = fixture()
  await f.controller.review(f.client, OP)
  const review = f.controller.getSnapshot().review
  assert.equal(f.controller.getSnapshot().approved, false)
  assert.equal(review.saved.sourceMdx, source('Saved'))
  assert.equal(review.current.sourceMdx, source('Current'))
  assert.equal(review.preview.html, '<p>Actual private rendered body</p>')
  assert.equal(review.expectedPublishedKey, key(BASE))
  assert.equal(review.saved.revision, REV)
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.saved) && Object.isFrozen(review.saved.assets[0]) && Object.isFrozen(review.preview) && Object.isFrozen(review.current))
  f.selection.saved.sourceMdx = 'Changed after review'
  assert.equal(review.saved.sourceMdx, source('Saved'))
  f.controller.approve(true)
  await f.controller.publish(f.client)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
})

test('dirty, invalid, stale-public and DRAFT source cannot publish or silently save/rewrite/rebase', async () => {
  const dirty = fixture(); dirty.controller.setSelection({ ...dirty.selection, working: { ...dirty.selection.working, sourceMdx: 'Unsaved body' } })
  await dirty.controller.review(dirty.client, OP)
  assert.equal(dirty.calls.length, 0)
  for (const overrides of [
    { preview: () => preview({ fieldErrors: [{ field: 'status', code: 'INVALID_STATUS', message: 'Must be PUBLISHED' }] }) },
    { preview: () => preview({ html: null }) },
    { preview: () => preview({ revision: NEXT_REV }) },
    { preview: () => preview({ expiresAt: iso(NOW) }) },
    { current: () => current({ s3Key: key(NEXT_OP) }) },
  ]) {
    const f = fixture(overrides)
    await f.controller.review(f.client, OP); f.controller.approve(true); await f.controller.publish(f.client)
    assert.equal(f.controller.getSnapshot().review, null)
    assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
    assert.equal(f.selection.saved.sourceMdx, source('Saved'))
    assert.equal(f.selection.saved.basePublished.s3Key, key(BASE))
  }
  const draftSource = source('Saved').replace('status: PUBLISHED', 'status: DRAFT')
  const incomplete = fixture({ preview: () => preview({ fieldErrors: [{ field: 'status', code: 'INVALID_STATUS', message: 'DRAFT cannot publish' }] }) }, draft({ sourceMdx: draftSource }))
  await incomplete.controller.review(incomplete.client, OP)
  assert.equal(incomplete.selection.working.sourceMdx, draftSource)
  assert.equal(incomplete.controller.getSnapshot().validation[0].field, 'status')
})

test('new writing requires authenticated absence and retains null public CAS; an existing target is not silently replaced', async () => {
  const f = fixture({ current: () => { throw new drafts.DraftFailure('NOT_FOUND') }, publish: () => outcome('committed', { result: result({ previousPublishedKey: null }) }) }, draft({ basePublished: null }))
  await f.controller.review(f.client, OP)
  assert.equal(f.controller.getSnapshot().review.current, null)
  f.controller.approve(true); await f.controller.publish(f.client)
  assert.equal(f.calls.find(call => call.type === 'publish').expectedPublishedKey, null)
  const collision = fixture({}, draft({ basePublished: null }))
  await collision.controller.review(collision.client, OP)
  assert.equal(collision.controller.getSnapshot().error, 'PUBLIC_BASE_CHANGED')
})

test('duplicate approved intent is locked synchronously and changed in-flight working source survives a proven successor baseline', async () => {
  const deferred = Promise.withResolvers(), editor = new drafts.WritingEditorController()
  await editor.open({ getWritingDraft: async () => draft() }, DRAFT, OWNER)
  const f = fixture({ publish: () => deferred.promise, advance: (saved, revision) => editor.advancePublicationBaseline(saved, revision, OWNER) })
  await f.controller.review(f.client, OP); f.controller.approve(true)
  const first = f.controller.publish(f.client), second = f.controller.publish(f.client)
  editor.change({ sourceMdx: 'Owner typed this while POST was pending' })
  f.controller.setSelection({ ...f.selection, working: editor.getSnapshot().working, eligible: false })
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 1)
  const intent = f.calls.find(call => call.type === 'publish')
  assert.equal(intent.revision, REV); assert.equal(intent.expectedPublishedKey, key(BASE)); assert.equal(intent.operationId, OP)
  assert.equal(f.checkpoints.at(-1), OP)
  deferred.resolve(outcome()); await Promise.all([first, second])
  assert.equal(editor.getSnapshot().working.sourceMdx, 'Owner typed this while POST was pending')
  assert.equal(editor.getSnapshot().saved.sourceMdx, source('Saved'))
  assert.equal(editor.getSnapshot().revision, NEXT_REV)
  assert.equal(editor.getSnapshot().saved.basePublished.s3Key, key(PUBLICATION))
  assert.equal(editor.getSnapshot().dirty, true)
  assert.equal(f.controller.getSnapshot().baselinePending, false)
  await f.controller.recover(f.client)
  assert.equal(f.advanced.length, 1)
  assert.equal(f.controller.getSnapshot().baselinePending, false)
})

test('lost POST response retains the original intent for GET-only proof and baseline advancement, never retries POST', async () => {
  const f = fixture({ publish: () => { throw new api.WritingPublicationFailure('UNAVAILABLE') } })
  await f.controller.review(f.client, OP); f.controller.approve(true); await f.controller.publish(f.client)
  assert.equal(f.controller.getSnapshot().unresolved, true)
  await f.controller.publish(f.client); await f.controller.review(f.client, NEXT_OP)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 1)
  await f.controller.recover(f.client)
  assert.equal(f.calls.filter(call => call.type === 'get').length, 1)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 1)
  assert.equal(f.advanced[0].revision, REV)
  assert.equal(f.controller.getSnapshot().outcome.status, 'committed')
})

test('reload recovery stores only an owner/scope operation UUID and hard-auth expiry clears all private review data', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  api.saveWritingPublicationCheckpoint(storage, 'pool|client|api', OWNER, OP)
  assert.deepEqual([...values.values()], [OP])
  assert.equal(api.readWritingPublicationCheckpoint(storage, 'pool|client|api', OWNER), OP)
  assert.equal(api.readWritingPublicationCheckpoint(storage, 'other-scope', OWNER), null)
  assert.equal(api.readWritingPublicationCheckpoint(storage, 'pool|client|api', 'other-owner'), null)
  const pending = Promise.withResolvers(), f = fixture({ publish: () => pending.promise })
  await f.controller.review(f.client, OP); f.controller.approve(true)
  const publish = f.controller.publish(f.client)
  const sent = f.calls.find(call => call.type === 'publish')
  f.controller.suspend()
  assert.equal(sent.abortSignal.aborted, true)
  assert.equal(f.controller.getSnapshot().review, null)
  assert.equal(f.controller.getSnapshot().outcome, null)
  assert.equal(f.controller.getSnapshot().operationId, null)
  pending.resolve(outcome()); await publish
  assert.equal(f.advanced.length, 0)
  const recovered = fixture({ advance: () => false })
  await recovered.controller.recover(recovered.client, api.readWritingPublicationCheckpoint(storage, 'pool|client|api', OWNER))
  assert.deepEqual(recovered.calls.map(call => call.type), ['get', 'draft'])
  assert.equal(recovered.advanced[0].revision, null)
  assert.equal(recovered.controller.getSnapshot().baselinePending, true)
})

test('404 remains unknown; only an acknowledged new manual review gets a new ID and unchecked approval', async () => {
  const f = fixture({ get: () => { throw new api.WritingPublicationFailure('OPERATION_NOT_FOUND') } })
  await f.controller.recover(f.client, OP)
  assert.equal(f.controller.getSnapshot().unresolved, true)
  assert.equal(f.controller.getSnapshot().outcome, null)
  assert.equal(f.checkpoints.length, 0)
  await f.controller.review(f.client, NEXT_OP)
  assert.equal(f.calls.filter(call => call.type === 'preview').length, 0)
  f.controller.acknowledgeUncertainty(true)
  await f.controller.review(f.client, OP)
  assert.equal(f.controller.getSnapshot().review, null)
  await f.controller.review(f.client, NEXT_OP)
  assert.equal(f.controller.getSnapshot().review.operationId, NEXT_OP)
  assert.equal(f.controller.getSnapshot().approved, false)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
})

test('in-progress recovery blocks another intent; refresh retry is independent and never changes proven commit into unpublished', async () => {
  const pending = fixture({ get: () => outcome('in_progress') })
  await pending.controller.recover(pending.client, OP)
  pending.controller.acknowledgeUncertainty(true); await pending.controller.review(pending.client, NEXT_OP); await pending.controller.refresh(pending.client)
  assert.equal(pending.controller.getSnapshot().uncertaintyAcknowledged, false)
  assert.deepEqual(pending.calls.map(call => call.type), ['get'])
  const f = fixture({ refresh: () => { throw new api.WritingPublicationFailure('UNAVAILABLE') } })
  await f.controller.recover(f.client, OP); await f.controller.refresh(f.client)
  assert.equal(f.controller.getSnapshot().outcome.status, 'committed')
  assert.equal(f.controller.getSnapshot().outcome.result.refreshPending, true)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
  assert.equal(f.controller.getSnapshot().error, 'UNAVAILABLE')
  const superseded = fixture({ get: () => outcome('superseded') })
  await superseded.controller.recover(superseded.client, OP); await superseded.controller.refresh(superseded.client)
  assert.equal(superseded.advanced.length, 0)
  assert.deepEqual(superseded.calls.map(call => call.type), ['get'])
})

test('a changed saved baseline, expired preview, or unavailable checkpoint cannot authorize new publication', async () => {
  const clock = { now: NOW }, f = fixture({}, draft(), clock)
  await f.controller.review(f.client, OP); f.controller.approve(true)
  clock.now += 60001; f.controller.expirePreview(); await f.controller.publish(f.client)
  assert.equal(f.controller.getSnapshot().review, null)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
  const blocked = fixture({ checkpoint: value => { if (value) throw Error('browser storage blocked') } })
  await blocked.controller.review(blocked.client, OP); blocked.controller.approve(true); await blocked.controller.publish(blocked.client)
  assert.equal(blocked.calls.filter(call => call.type === 'publish').length, 0)
  assert.equal(blocked.controller.getSnapshot().error, 'UNAVAILABLE')
  const stale = fixture({ draft: () => fresh({ revision: NEXT_OP }) })
  await stale.controller.review(stale.client, OP); stale.controller.approve(true); await stale.controller.publish(stale.client)
  assert.equal(stale.controller.getSnapshot().outcome.status, 'committed')
  assert.equal(stale.controller.getSnapshot().baselinePending, true)
  assert.equal(stale.advanced.length, 0)
})
