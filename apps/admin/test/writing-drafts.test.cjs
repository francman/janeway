const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')
const { File } = require('node:buffer')

const API = 'https://fixture.execute-api.us-east-1.amazonaws.com'
const ORIGIN = 'https://janeway-writing-drafts-486207805298-us-east-1.s3.us-east-1.amazonaws.com'
const OWNER = 'owner-sub'
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const DRAFT = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const REVISION = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_REVISION = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEWER_REVISION = '43cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const ASSET = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OP = '63cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_OP = '73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OTHER_DRAFT = '83cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const iso = milliseconds => new Date(milliseconds).toISOString()
const plain = value => JSON.parse(JSON.stringify(value))
const metadata = (revision = REVISION, extra = {}) => ({ draftId: DRAFT, label: 'Private writing', targetSlug: 'fixture-writing', revision, createdAt: iso(NOW - 1000), updatedAt: iso(NOW), basePublished: null, ...extra })
const asset = (extra = {}) => ({ assetId: ASSET, name: 'image.png', sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/png', key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, versionId: 'exact-version', width: 10, height: 20, ...extra })
const draft = (revision = REVISION, extra = {}) => ({ ...metadata(revision), schemaVersion: 1, sourceMdx: '---\ntitle: "Original"\n---\n\nOriginal body.\n', assets: [], ...extra })
const outcome = (status = 'committed', extra = {}) => ({ operationId: OP, draftId: DRAFT, status, createdAt: iso(NOW), ...(['committed', 'superseded'].includes(status) ? { result: metadata(NEXT_REVISION) } : {}), ...extra })
const signal = () => new AbortController().signal
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
function libraries(globals = {}) {
  const modules = new Map()
  function load(name) {
    const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    modules.set(filename, module.exports)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const context = vm.createContext({ module, exports: module.exports, URL, AbortController, AbortSignal, Response, TextDecoder, TextEncoder, FormData, File, fetch, setTimeout, clearTimeout, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])) } static now() { return NOW } }, ...globals, require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) } })
    new vm.Script(code, { filename }).runInContext(context)
    return module.exports
  }
  return load
}
const load = libraries()
const api = load('writing-drafts')
const errors = load('api')
const failure = code => error => error instanceof api.DraftFailure && error.code === code

function editorFixture(overrides = {}, initial = draft()) {
  const controller = new api.WritingEditorController(), calls = [], checkpoints = []
  controller.configureCheckpoint(value => checkpoints.push(value ? plain(value) : null))
  const client = {
    async getWritingDraft(id, abortSignal) { calls.push({ type: 'read', id, abortSignal }); return overrides.read ? overrides.read(id, abortSignal) : initial },
    async saveWritingDraft(id, input, revision, operationId, abortSignal) { calls.push({ type: 'save', id, input, revision, operationId, abortSignal }); return overrides.save ? overrides.save(input, revision, operationId, abortSignal) : outcome('committed', { operationId, result: metadata(NEXT_REVISION, { label: input.label, targetSlug: input.targetSlug }) }) },
    async getWritingOperation(operationId, abortSignal) { calls.push({ type: 'outcome', operationId, abortSignal }); return overrides.outcome ? overrides.outcome(operationId, abortSignal) : outcome('committed', { operationId }) },
  }
  return { controller, client, calls, checkpoints }
}

test('canonical metadata edits replace only one explicit scalar and preserve every other byte', () => {
  const original = '\uFEFF---\r\ntitle  :  \'Owner\'\'s title\'  # keep this comment\r\ndescription: "Do not rewrite"\r\nauthor: Frank Manu\r\ndate: 2026-10-10\r\nstatus: DRAFT\r\ntags: [one, two] # untouched\r\ncustom: &anchor {deep: value}\r\n---\r\n\r\n<Callout>Canonical **body** with {unsafeDraftExpression}</Callout>\r\n'
  assert.equal(api.readFrontmatterScalar(original, 'title'), "Owner's title")
  assert.equal(api.changeFrontmatterScalar(original, 'title', "Owner's title"), original)
  const edited = api.changeFrontmatterScalar(original, 'title', 'A "quoted" new title')
  assert.equal(edited, original.replace("'Owner''s title'", JSON.stringify('A "quoted" new title')))
  assert.equal(api.changeFrontmatterScalar(original, 'date', '2026-10-11'), original.replace('date: 2026-10-10', 'date: "2026-10-11"'))
  for (const complex of ['---\ntitle: |\n  multiline\n---\nbody', '---\ntitle: first\ntitle: second\n---\nbody', '---\ntitle: &anchor value\n---\nbody', '---\ntitle: value\n  continuation\n---\nbody', 'No frontmatter\nbody']) {
    assert.equal(api.readFrontmatterScalar(complex, 'title'), null)
    assert.throws(() => api.changeFrontmatterScalar(complex, 'title', 'replace'), failure('INVALID_REQUEST'))
  }
  assert.throws(() => api.changeFrontmatterScalar(original, 'title', 'line\nbreak'), failure('INVALID_REQUEST'))
})

test('multiline YAML after blank or comment lines remains source-only and cannot be partially rewritten', () => {
  for (const original of [
    '---\ntitle: First\n\n  second\n---\nBody unchanged\n',
    '---\ntitle: First\n# preserved comment\n\n  second\n---\nBody unchanged\n',
  ]) {
    assert.equal(api.readFrontmatterScalar(original, 'title'), null)
    assert.throws(() => api.changeFrontmatterScalar(original, 'title', 'Replacement'), failure('INVALID_REQUEST'))
  }
})

test('incomplete and invalid publication metadata can save without source rewriting; snapshots freeze revision, operation and attachments', () => {
  const input = { label: '', targetSlug: 'Not publishable yet!', sourceMdx: '---\ntitle: [unfinished\n\n{incomplete', assets: [{ assetId: ASSET, name: 'image.png' }] }
  const frozen = api.captureDraftSave(DRAFT, input, REVISION, OP)
  input.label = 'changed'; input.sourceMdx = 'changed'; input.assets[0].name = 'changed.png'; input.assets.push({ assetId: NEXT_OP, name: 'another.png' })
  assert.equal(frozen.input.label, '')
  assert.equal(frozen.input.sourceMdx, '---\ntitle: [unfinished\n\n{incomplete')
  assert.equal(frozen.input.assets.length, 1)
  assert.equal(frozen.input.assets[0].name, 'image.png')
  assert.equal(frozen.revision, REVISION)
  assert.equal(frozen.operationId, OP)
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.input) && Object.isFrozen(frozen.input.assets) && Object.isFrozen(frozen.input.assets[0]))
  assert.throws(() => api.captureDraftSave(DRAFT, { ...input, sourceMdx: '😀'.repeat(65537) }, REVISION, OP), failure('INVALID_REQUEST'))
  assert.throws(() => api.captureDraftSave(DRAFT, { ...input, assets: Array.from({ length: 20 }, (_, index) => ({ assetId: `${index.toString(16).padStart(8, '0')}-7e06-4b92-8524-f0c6ba5f0ad1`, name: `${index}.png` })) }, REVISION, OP), failure('INVALID_REQUEST'))
  assert.throws(() => api.captureDraftSave(DRAFT, { ...input, assets: [{ assetId: ASSET, name: '../private.png' }] }, REVISION, OP), failure('INVALID_REQUEST'))
})

test('explicit Save is single-flight and later edits remain dirty after a frozen revision commits', async () => {
  const deferred = Promise.withResolvers(), fixture = editorFixture({ save: () => deferred.promise })
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'First explicit input' })
  const first = fixture.controller.save(fixture.client, OP), second = fixture.controller.save(fixture.client, NEXT_OP)
  assert.equal(first, second)
  fixture.controller.change({ sourceMdx: 'Typed after clicking Save' })
  assert.equal(fixture.calls.filter(call => call.type === 'save').length, 1)
  assert.equal(fixture.calls[1].input.sourceMdx, 'First explicit input')
  assert.equal(fixture.calls[1].revision, REVISION)
  assert.deepEqual(fixture.checkpoints, [{ draftId: DRAFT, operationId: OP }])
  deferred.resolve(outcome())
  await first
  const state = fixture.controller.getSnapshot()
  assert.equal(state.saved.sourceMdx, 'First explicit input')
  assert.equal(state.working.sourceMdx, 'Typed after clicking Save')
  assert.equal(state.revision, NEXT_REVISION)
  assert.equal(state.dirty, true)
  assert.equal(state.pending, null)
  assert.equal(state.phase, 'ready')
  assert.equal(fixture.checkpoints.at(-1), null)
  fixture.controller.change({ sourceMdx: 'First explicit input' })
  assert.equal(fixture.controller.getSnapshot().dirty, false)
})

test('lost Save response stays uncertain; read-only reconciliation proves the original input without resubmitting', async () => {
  const fixture = editorFixture({ save: async () => { throw new api.DraftFailure('UNAVAILABLE') } })
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'Frozen original input' })
  await fixture.controller.save(fixture.client, OP)
  fixture.controller.change({ sourceMdx: 'Newer local input' })
  assert.equal(fixture.controller.getSnapshot().phase, 'uncertain')
  assert.equal(fixture.controller.getSnapshot().pending.operationId, OP)
  await fixture.controller.save(fixture.client, NEXT_OP)
  assert.equal(fixture.calls.filter(call => call.type === 'save').length, 1)
  await fixture.controller.reconcile(fixture.client)
  assert.equal(fixture.calls.at(-1).type, 'outcome')
  assert.equal(fixture.calls.at(-1).operationId, OP)
  assert.equal(fixture.controller.getSnapshot().saved.sourceMdx, 'Frozen original input')
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'Newer local input')
  assert.equal(fixture.controller.getSnapshot().dirty, true)
  assert.equal(fixture.controller.getSnapshot().pending, null)
})

test('412 never rebases: conflict proof, fresh review and explicit merge adoption are required before a new Save', async () => {
  let readCount = 0, saveCount = 0
  const fixture = editorFixture({
    read: () => ++readCount === 1 ? draft() : draft(NEWER_REVISION, { sourceMdx: 'Remote writer change' }),
    save: async (input, revision, operationId) => { if (++saveCount === 1) throw new api.DraftFailure('REVISION_CONFLICT'); return outcome('committed', { operationId, result: metadata(NEXT_REVISION) }) },
    outcome: async () => outcome('conflict', { errorCode: 'REVISION_CONFLICT', current: metadata(NEWER_REVISION) }),
  })
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'My original input' })
  await fixture.controller.save(fixture.client, OP)
  await fixture.controller.reconcile(fixture.client)
  assert.equal(fixture.controller.getSnapshot().phase, 'conflict')
  assert.equal(fixture.controller.getSnapshot().revision, REVISION)
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'My original input')
  await fixture.controller.save(fixture.client, NEXT_OP)
  assert.equal(saveCount, 1)
  await fixture.controller.reviewCurrent(fixture.client)
  assert.equal(fixture.controller.getSnapshot().saved.sourceMdx, 'Remote writer change')
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'My original input')
  assert.equal(fixture.controller.getSnapshot().revision, REVISION)
  fixture.controller.change({ sourceMdx: 'Manually merged remote + local input' })
  fixture.controller.adoptReviewedRevision()
  assert.equal(fixture.controller.getSnapshot().revision, NEWER_REVISION)
  await fixture.controller.save(fixture.client, NEXT_OP)
  assert.equal(saveCount, 2)
  assert.equal(fixture.calls.filter(call => call.type === 'save').at(-1).revision, NEWER_REVISION)
  assert.equal(fixture.calls.filter(call => call.type === 'save').at(-1).operationId, NEXT_OP)
})

test('session expiry cancels in-flight callbacks, clears saved source and asset capabilities, and retains only protected input for recovery', async () => {
  const deferred = Promise.withResolvers(), fixture = editorFixture({ save: () => deferred.promise }, draft(REVISION, { assets: [asset()] }))
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'Retain my unsaved text' })
  const saving = fixture.controller.save(fixture.client, OP)
  fixture.controller.suspend()
  const state = fixture.controller.getSnapshot()
  assert.equal(state.recovery, true)
  assert.equal(state.saved, null)
  assert.equal(state.availableAssets.length, 0)
  assert.equal(state.working.sourceMdx, 'Retain my unsaved text')
  assert.equal(state.pending.input.sourceMdx, 'Retain my unsaved text')
  assert.equal(fixture.calls[1].abortSignal.aborted, true)
  assert.ok(!JSON.stringify(state).includes('exact-version'))
  assert.ok(!JSON.stringify(state).includes('a'.repeat(64)))
  deferred.resolve(outcome())
  await saving
  assert.equal(fixture.controller.getSnapshot().phase, 'uncertain')
  assert.equal(fixture.controller.getSnapshot().revision, REVISION)
  await assert.rejects(fixture.controller.open(fixture.client, DRAFT, 'different-owner'), failure('INVALID_REQUEST'))
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'Retain my unsaved text')
  assert.equal(fixture.controller.getSnapshot().pending.operationId, OP)
  fixture.controller.discard()
  assert.equal(fixture.controller.getSnapshot().working, null)
  assert.equal(fixture.controller.hasProtectedWork(), false)
  const clean = editorFixture()
  await clean.controller.open(clean.client, DRAFT, OWNER)
  clean.controller.suspend()
  assert.equal(clean.controller.getSnapshot().working, null)
})

test('reauthentication never silently adopts the server revision or drops newer local text', async () => {
  let count = 0
  const fixture = editorFixture({ read: () => ++count === 1 ? draft() : draft(NEWER_REVISION, { sourceMdx: 'Different saved content' }) })
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'My recovered text' })
  fixture.controller.suspend()
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  assert.equal(fixture.controller.getSnapshot().phase, 'conflict')
  assert.equal(fixture.controller.getSnapshot().revision, REVISION)
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'My recovered text')
  await fixture.controller.save(fixture.client, OP)
  assert.equal(fixture.calls.filter(call => call.type === 'save').length, 0)
  fixture.controller.adoptReviewedRevision()
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'My recovered text')
  assert.equal(fixture.controller.getSnapshot().revision, NEWER_REVISION)
  assert.equal(fixture.controller.getSnapshot().dirty, true)
})

test('new asset references become dirty and only enter the saved snapshot when its frozen Save commits', async () => {
  const fixture = editorFixture()
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.rememberAsset(asset())
  fixture.controller.change({ assets: [{ assetId: ASSET, name: 'image.png' }] })
  assert.equal(fixture.controller.getSnapshot().saved.assets.length, 0)
  assert.equal(fixture.controller.getSnapshot().dirty, true)
  await fixture.controller.save(fixture.client, OP)
  assert.equal(fixture.controller.getSnapshot().saved.assets[0].versionId, 'exact-version')
  assert.equal(fixture.controller.getSnapshot().dirty, false)
  fixture.controller.change({ assets: [] })
  assert.equal(fixture.controller.getSnapshot().dirty, true)
  fixture.controller.discardToSaved()
  assert.equal(fixture.controller.getSnapshot().working.assets[0].assetId, ASSET)
})

test('fork article slug is locked even though incomplete new-article target slugs are editable', async () => {
  const basePublished = { slug: 'fixture-writing', s3Key: `articles/fixture-writing/revisions/${REVISION}/page.mdx` }
  const fixture = editorFixture({}, draft(REVISION, { basePublished }))
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  assert.throws(() => fixture.controller.change({ targetSlug: 'renamed-article' }), failure('INVALID_REQUEST'))
  fixture.controller.change({ sourceMdx: 'Still editable' })
  assert.equal(fixture.controller.getSnapshot().working.targetSlug, 'fixture-writing')
})

test('unproved, failed, superseded and mismatched outcomes never become a current saved confirmation', async () => {
  for (const result of [outcome('in_progress'), outcome('unknown', { draftId: null, createdAt: null }), outcome('failed', { errorCode: 'ASSET_NOT_FOUND' }), outcome('superseded', { current: metadata(NEWER_REVISION) }), outcome('committed', { operationId: NEXT_OP }), outcome('committed', { result: metadata(NEXT_REVISION, { label: 'different input' }) })]) {
    const fixture = editorFixture({ save: async () => result })
    await fixture.controller.open(fixture.client, DRAFT, OWNER)
    fixture.controller.change({ sourceMdx: 'Protected local input' })
    await fixture.controller.save(fixture.client, OP)
    assert.notEqual(fixture.controller.getSnapshot().phase, 'ready')
    assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'Protected local input')
    assert.equal(fixture.controller.getSnapshot().revision, REVISION)
    assert.equal(fixture.controller.getSnapshot().dirty, true)
  }
})

test('requests bind exact operation and revision, stay private, and GET outcome cannot mutate or choose an owner', async () => {
  const calls = [], input = { label: 'Private writing', targetSlug: '', sourceMdx: '{unfinished', assets: [] }
  const transport = async (url, options) => { calls.push({ url, options }); return response(outcome('committed', { result: metadata(NEXT_REVISION, { targetSlug: '' }) })) }
  await api.saveWritingDraft(API, 'synthetic-token', DRAFT, input, REVISION, OP, signal(), transport)
  await api.getWritingOperation(API, 'synthetic-token', OP, signal(), async (url, options) => { calls.push({ url, options }); return response(outcome()) })
  assert.equal(calls[0].options.method, 'PUT')
  assert.equal(calls[0].options.headers['If-Match'], `"${REVISION}"`)
  assert.equal(calls[0].options.headers['Idempotency-Key'], OP)
  assert.deepEqual(JSON.parse(calls[0].options.body), input)
  assert.equal(calls[1].url, API + '/v1/writings/operations/' + OP)
  assert.equal(calls[1].options.method, 'GET')
  assert.equal(calls[1].options.body, undefined)
  assert.equal(calls[1].options.headers['Idempotency-Key'], undefined)
  for (const { options } of calls) {
    assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token')
  }
  await assert.rejects(api.getWritingDraft(API, 'token', OWNER, '../another-owner', signal(), () => { throw Error('must not dispatch') }), failure('INVALID_REQUEST'))
  await assert.rejects(api.listWritingDrafts(API, 'token', '../other-page', signal(), () => { throw Error('must not dispatch') }), failure('INVALID_REQUEST'))
  await assert.rejects(api.getPublishedWriting(API, 'token', 'bad/slug', signal(), () => { throw Error('must not dispatch') }), failure('INVALID_REQUEST'))
})

test('create and fork require explicit POST intent; browser cannot provide a public key, owner or canonical receipt descriptor', async () => {
  const calls = [], base = `articles/fixture-writing/revisions/${REVISION}/page.mdx`
  const transport = async (url, options) => { calls.push({ url, options }); return response(outcome('committed', { result: metadata(NEXT_REVISION, { basePublished: { slug: 'fixture-writing', s3Key: base } }) }), 201) }
  await api.createWritingDraft(API, 'token', { draftId: DRAFT, fromPublishedSlug: 'fixture-writing', owner: 'other', s3Key: 'arbitrary', sourceMdx: 'injected' }, OP, signal(), transport)
  assert.deepEqual(JSON.parse(calls[0].options.body), { draftId: DRAFT, fromPublishedSlug: 'fixture-writing' })
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['Idempotency-Key'], OP)
  assert.equal(calls[0].options.headers['If-Match'], undefined)
  const saved = { label: 'Private writing', targetSlug: 'fixture-writing', sourceMdx: '', assets: [asset()] }
  await api.saveWritingDraft(API, 'token', DRAFT, saved, REVISION, OP, signal(), async (url, options) => { calls.push({ url, options }); return response(outcome()) })
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).assets, [{ assetId: ASSET, name: 'image.png' }])
})

test('auth, conflict and size failures remain bounded domain errors and never leak server text', async () => {
  for (const [status, kind] of [[401, 'expired'], [403, 'denied']]) {
    await assert.rejects(api.getWritingDraft(API, 'token', OWNER, DRAFT, signal(), async () => response({ error: { requestId: 'bounded-id', message: 'SECRET-MDX' } }, status)), error => error instanceof errors.ApiError && error.kind === kind && error.requestId === 'bounded-id' && !error.message.includes('SECRET'))
  }
  for (const [status, code] of [[412, 'REVISION_CONFLICT'], [409, 'OPERATION_REUSED'], [413, 'INVALID_REQUEST']]) {
    await assert.rejects(api.saveWritingDraft(API, 'token', DRAFT, api.draftInput(draft()), REVISION, OP, signal(), async () => response({ error: { message: 'private stack and source', requestId: '\r\nunsafe' } }, status)), error => failure(code)(error) && error.requestId === undefined && !error.message.includes('private stack'))
  }
  await assert.rejects(api.getWritingOperation(API, 'token', OP, signal(), async () => { throw Error('lost connection') }), failure('UNAVAILABLE'))
  await assert.rejects(api.getWritingOperation(API, 'token', OP, signal(), async () => response(outcome(), 200, { 'Cache-Control': 'private,max-age=300' })), failure('UNAVAILABLE'))
  let canceled = false
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(800000)) }, cancel() { canceled = true } })
  await assert.rejects(api.getWritingOperation(API, 'token', OP, signal(), async () => new Response(huge, { headers: { 'Cache-Control': 'no-store' } })), failure('UNAVAILABLE'))
  assert.equal(canceled, true)
})

test('strong reads reject wrong ETag, owner/draft assets, malformed canonical snapshots and inconsistent operation envelopes', async () => {
  const invalid = [draft(REVISION, { schemaVersion: 2 }), draft(REVISION, { draftId: OTHER_DRAFT }), draft(REVISION, { assets: [asset({ key: `drafts/other/${DRAFT}/assets/${ASSET}/image` })] }), draft(REVISION, { assets: [asset({ versionId: 'null' })] })]
  for (const item of invalid) await assert.rejects(api.getWritingDraft(API, 'token', OWNER, DRAFT, signal(), async () => response(item, 200, { ETag: `"${REVISION}"` })), failure('UNAVAILABLE'))
  await assert.rejects(api.getWritingDraft(API, 'token', OWNER, DRAFT, signal(), async () => response(draft(), 200, { ETag: `W/"${REVISION}"` })), failure('UNAVAILABLE'))
  const malformed = [outcome('committed', { result: undefined }), outcome('unknown', { result: metadata(NEXT_REVISION) }), outcome('committed', { current: metadata(NEWER_REVISION) }), outcome('superseded', { current: metadata(NEXT_REVISION) }), outcome('unknown', { draftId: null, createdAt: iso(NOW) })]
  for (const item of malformed) await assert.rejects(api.getWritingOperation(API, 'token', OP, signal(), async () => response(item)), failure('UNAVAILABLE'))
  await assert.rejects(api.saveWritingDraft(API, 'token', DRAFT, api.draftInput(draft()), REVISION, OP, signal(), async () => response(outcome('conflict'), 201)), failure('UNAVAILABLE'))
  const unknown = await api.getWritingOperation(API, 'token', OP, signal(), async () => response({ operationId: OP, status: 'unknown', draftId: null, createdAt: null }))
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.result, undefined)
  const parsed = api.parseDraftOperation(outcome('committed', { sourceMdx: 'SECRET', result: { ...metadata(NEXT_REVISION), token: 'SECRET' } }), OP)
  assert.ok(!JSON.stringify(parsed).includes('SECRET'))
})

test('reload recovery stores only two UUIDs, is scoped to owner/environment, and storage failure stops Save before dispatch', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  api.saveWritingCheckpoint(storage, 'pool|client|api', OWNER, { draftId: DRAFT, operationId: OP, sourceMdx: 'NEVER-PERSIST', token: 'NEVER-PERSIST' })
  assert.deepEqual(JSON.parse([...values.values()][0]), { operationId: OP, draftId: DRAFT })
  assert.equal(api.readWritingCheckpoint(storage, 'different-api', OWNER), null)
  assert.equal(api.readWritingCheckpoint(storage, 'pool|client|api', 'other-owner'), null)
  values.set(api.writingCheckpointKey('pool|client|api', OWNER), JSON.stringify({ draftId: DRAFT, operationId: OP, sourceMdx: 'unexpected' }))
  assert.equal(api.readWritingCheckpoint(storage, 'pool|client|api', OWNER), null)
  const fixture = editorFixture()
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'Recover this text' })
  fixture.controller.configureCheckpoint(() => { throw Error('storage denied') })
  await fixture.controller.save(fixture.client, OP)
  assert.equal(fixture.calls.filter(call => call.type === 'save').length, 0)
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'Recover this text')
  assert.equal(fixture.controller.getSnapshot().dirty, true)
})

const authorization = (extra = {}) => ({ assetId: ASSET, upload: { url: ORIGIN + '/', fields: { key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, 'Content-Type': 'image/png', success_action_status: '201', 'x-amz-server-side-encryption': 'AES256', Policy: 'synthetic-policy' }, expiresAt: iso(NOW + 300000), maxBytes: api.MAX_ASSET_BYTES }, ...extra })
const imageFile = () => new File([new Uint8Array(100)], 'image.png', { type: 'image/png' })

test('asset authorization pins exact owner/draft key and private origin, rejects oversized or unsupported content and public ACL fields', async () => {
  const file = imageFile(), original = authorization()
  assert.equal(api.validateAssetAuthorization(original, OWNER, DRAFT, file).assetId, ASSET)
  for (const changes of [{ url: 'https://attacker.invalid/' }, { fields: { ...original.upload.fields, key: `drafts/other/${DRAFT}/assets/${ASSET}/image` } }, { fields: { ...original.upload.fields, acl: 'public-read' } }, { fields: { ...original.upload.fields, 'x-amz-website-redirect-location': 'https://attacker.invalid' } }, { expiresAt: iso(NOW - 1) }, { expiresAt: iso(NOW + 600000) }]) assert.throws(() => api.validateAssetAuthorization({ ...original, upload: { ...original.upload, ...changes } }, OWNER, DRAFT, file), failure('UNAVAILABLE'))
  await assert.rejects(api.authorizeWritingAsset(API, 'token', OWNER, DRAFT, new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }), signal(), () => { throw Error('must not dispatch') }), failure('INVALID_REQUEST'))
  await assert.rejects(api.authorizeWritingAsset(API, 'token', OWNER, DRAFT, new File([new Uint8Array(api.MAX_ASSET_BYTES + 1)], 'large.png', { type: 'image/png' }), signal(), () => { throw Error('must not dispatch') }), failure('FILE_TOO_LARGE'))
})

test('direct private upload carries no bearer token/cookie, requires version proof, and cancellation cannot later succeed', async () => {
  let xhr, observedForm
  const create = () => (xhr = { upload: {}, status: 201, withCredentials: true, open(method, url) { this.method = method; this.url = url }, send(form) { observedForm = form }, getResponseHeader(name) { return name === 'x-amz-version-id' ? 'exact-version' : null }, abort() { this.aborted = true } })
  const controller = new AbortController(), progress = []
  const promise = api.uploadWritingAsset(OWNER, DRAFT, authorization(), imageFile(), controller.signal, (loaded, total) => progress.push([loaded, total]), create)
  assert.equal(xhr.method, 'POST'); assert.equal(xhr.url, ORIGIN + '/'); assert.equal(xhr.withCredentials, false)
  assert.equal(observedForm.has('Authorization'), false)
  assert.equal(observedForm.get('key'), `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`)
  xhr.upload.onprogress({ loaded: 50, total: 100, lengthComputable: true })
  xhr.onload()
  assert.equal(await promise, 'exact-version')
  assert.deepEqual(progress, [[50, 100]])
  assert.equal(xhr.onload, null)
  const abort = new AbortController(), interrupted = api.uploadWritingAsset(OWNER, DRAFT, authorization(), imageFile(), abort.signal, () => {}, create)
  const lateLoad = xhr.onload
  abort.abort()
  await assert.rejects(interrupted, failure('TRANSFER_INTERRUPTED'))
  assert.equal(xhr.aborted, true)
  lateLoad()
  const noVersion = api.uploadWritingAsset(OWNER, DRAFT, authorization(), imageFile(), signal(), () => {}, create)
  xhr.getResponseHeader = () => null; xhr.onload()
  await assert.rejects(noVersion, failure('UNAVAILABLE'))
})

test('image validation and preview bind the uploaded version and never accept arbitrary private or public URLs', async () => {
  const valid = asset(), goodUrl = `${ORIGIN}/${valid.key}?versionId=exact-version&X-Amz-Signature=synthetic`
  const receipt = await api.validateWritingAsset(API, 'token', OWNER, DRAFT, ASSET, 'exact-version', signal(), async () => response({ asset: valid }, 201))
  assert.equal(receipt.versionId, 'exact-version')
  await assert.rejects(api.validateWritingAsset(API, 'token', OWNER, DRAFT, ASSET, 'exact-version', signal(), async () => response({ asset: asset({ versionId: 'other-version' }) }, 201)), failure('UNAVAILABLE'))
  for (const url of ['https://www.frankmanu.com/private.png', goodUrl.replace('owner-sub', 'other-owner'), goodUrl.replace('versionId=exact-version', 'versionId=other-version'), goodUrl + '&versionId=exact-version']) await assert.rejects(api.getWritingAssetPreview(API, 'token', OWNER, DRAFT, valid, signal(), async () => response({ url, expiresAt: iso(NOW + 300000) })), failure('UNAVAILABLE'))
  const result = await api.getWritingAssetPreview(API, 'token', OWNER, DRAFT, valid, signal(), async () => response({ url: goodUrl, expiresAt: iso(NOW + 300000) }))
  assert.equal(result.url, goodUrl)
})

test('saved preview request cannot send unsaved source or fall back to public images and rejects wrong revision and expired grants', async () => {
  let sent
  const preview = { draftId: DRAFT, revision: REVISION, html: '<p>Saved body</p>', fieldErrors: [{ field: 'title', code: 'REQUIRED', message: 'title is required', line: 2 }], expiresAt: iso(NOW + 300000) }
  const rendered = await api.previewWritingDraft(API, 'token', DRAFT, REVISION, signal(), async (url, options) => { sent = { url, options }; return response(preview) })
  assert.equal(sent.options.headers['If-Match'], `"${REVISION}"`)
  assert.deepEqual(JSON.parse(sent.options.body), {})
  assert.equal(rendered.fieldErrors[0].line, 2)
  await assert.rejects(api.previewWritingDraft(API, 'token', DRAFT, REVISION, signal(), async () => response({ ...preview, revision: NEXT_REVISION })), failure('UNAVAILABLE'))
  await assert.rejects(api.previewWritingDraft(API, 'token', DRAFT, REVISION, signal(), async () => response({ ...preview, expiresAt: iso(NOW - 1) })), failure('UNAVAILABLE'))
  const document = api.privatePreviewDocument('<script>secret()</script><img src="https://attacker.invalid/image">')
  assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf('<script>'))
  assert.ok(document.includes("default-src 'none'")); assert.ok(document.includes("script-src 'none'")); assert.ok(document.includes(`img-src ${ORIGIN};`)); assert.ok(!document.includes('allow-same-origin'))
})

test('textarea edits preserve untouched CRLF, mixed line endings and no-op original bytes', () => {
  const original = '---\r\ntitle: "Keep"\r\n---\r\n\r\nFirst body.\nLast body.\n'
  const normalized = original.replace(/\r\n/g, '\n')
  assert.equal(api.applySourceEditorChange(original, normalized), original)
  assert.equal(api.applySourceEditorChange(original, normalized.replace('First body.', 'Changed body.')), original.replace('First body.', 'Changed body.'))
  assert.equal(api.applySourceEditorChange(original, normalized.replace('title: "Keep"\n', 'title: "Keep"\nauthor: Owner\n')), original.replace('title: "Keep"\r\n', 'title: "Keep"\r\nauthor: Owner\r\n'))
  assert.equal(api.applySourceEditorChange(original, normalized.replace('Last body.', 'Last body.\nNew body line.')), original.replace('Last body.', 'Last body.\nNew body line.'))
  assert.equal(api.applySourceEditorChange('one\rtwo\rthree', 'one\ntwo edited\nthree'), 'one\rtwo edited\rthree')
  assert.equal(api.applySourceEditorChange('', 'new\nbody'), 'new\nbody')
  assert.equal(api.applySourceEditorChange(original, ''), '')
  for (const value of ['ASCII', 'é漢字😀', 'unpaired \ud800 and \udc00', '\r\nmixed\n']) assert.equal(api.writingSourceBytes(value), new TextEncoder().encode(value).byteLength)
})

test('outcome checks are single-flight and cannot resurrect an older uncertain result after commitment', async () => {
  const deferred = Promise.withResolvers()
  let reads = 0
  const fixture = editorFixture({ save: async () => { throw new api.DraftFailure('UNAVAILABLE') }, outcome: () => ++reads === 1 ? deferred.promise : outcome() })
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'Frozen input' })
  await fixture.controller.save(fixture.client, OP)
  const first = fixture.controller.reconcile(fixture.client), second = fixture.controller.reconcile(fixture.client)
  assert.equal(first, second)
  assert.equal(reads, 1)
  deferred.resolve(outcome('in_progress'))
  await first
  assert.equal(fixture.controller.getSnapshot().pending.operationId, OP)
  await fixture.controller.reconcile(fixture.client)
  assert.equal(reads, 2)
  assert.equal(fixture.controller.getSnapshot().phase, 'ready')
  assert.equal(fixture.controller.getSnapshot().pending, null)
  await fixture.controller.reconcile(fixture.client)
  assert.equal(reads, 2)
})

test('publication baseline handoff preserves newer local text and refuses unknown, cross-owner or superseded review', async () => {
  const fixture = editorFixture(), basePublished = { slug: 'fixture-writing', s3Key: `articles/fixture-writing/revisions/${NEXT_REVISION}/page.mdx` }
  await fixture.controller.open(fixture.client, DRAFT, OWNER)
  fixture.controller.change({ sourceMdx: 'Typed after publication intent was approved' })
  const fresh = draft(NEXT_REVISION, { basePublished })
  assert.equal(fixture.controller.advancePublicationBaseline(fresh, null, OWNER), false)
  assert.equal(fixture.controller.advancePublicationBaseline(fresh, REVISION, 'other-owner'), false)
  assert.equal(fixture.controller.advancePublicationBaseline({ ...fresh, sourceMdx: 'Newer remote private source' }, REVISION, OWNER), false)
  assert.equal(fixture.controller.advancePublicationBaseline(fresh, REVISION, OWNER), true)
  assert.equal(fixture.controller.getSnapshot().working.sourceMdx, 'Typed after publication intent was approved')
  assert.equal(fixture.controller.getSnapshot().revision, NEXT_REVISION)
  assert.equal(fixture.controller.getSnapshot().saved.basePublished.s3Key, basePublished.s3Key)
  assert.equal(fixture.controller.getSnapshot().dirty, true)
  assert.equal(fixture.controller.advancePublicationBaseline(draft(NEWER_REVISION), REVISION, OWNER), false)
})
