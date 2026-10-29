const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')

const API = 'https://fixture.execute-api.us-east-1.amazonaws.com'
const STAGING = 'https://janeway-resume-staging-111122223333-us-east-1.s3.us-east-1.amazonaws.com'
const OWNER = 'owner-sub'
const SCOPE = 'fixture-pool|fixture-client|fixture-api'
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const OPERATION = '73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_OPERATION = '83cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const VALIDATION = '54c69aa4-ae81-4a91-a5d0-e16b4765e20c'
const UPLOAD = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const CURRENT = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const PUBLISHED = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const VERSION = 'exact/immutable+version'
const pdf = (name = 'selected.pdf') => new File([Buffer.alloc(100, 32)], name, { type: 'application/pdf' })
const metadata = (publicationId = CURRENT, sha256 = 'a'.repeat(64), etag = '"initial-pointer"') => ({ schemaVersion: 1, publicationId, key: `documents/resume/revisions/${sha256}/inline/frank-manu-resume.pdf`, sha256, bytes: 100, publishedAt: new Date(NOW - 1000).toISOString(), publicUrl: 'https://www.frankmanu.com/resume.pdf', etag })
const published = () => metadata(PUBLISHED, 'b'.repeat(64), '"committed-pointer"')
const receipt = (now = NOW) => ({ schemaVersion: 1, validationId: VALIDATION, uploadId: UPLOAD, key: `uploads/${OWNER}/${UPLOAD}/file.pdf`, versionId: VERSION, sha256: 'b'.repeat(64), bytes: 100, pageCount: 2, validatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString() })
const authorization = (now = NOW) => ({ uploadId: UPLOAD, upload: { url: STAGING + '/', fields: { key: `uploads/${OWNER}/${UPLOAD}/file.pdf`, policy: 'synthetic-policy', 'Content-Type': 'application/pdf', success_action_status: '201', 'x-amz-server-side-encryption': 'AES256' }, expiresAt: new Date(now + 300000).toISOString(), maxBytes: 10 * 1024 * 1024 } })
const preview = (now = NOW) => ({ url: `${STAGING}/uploads/${OWNER}/${UPLOAD}/file.pdf?versionId=${encodeURIComponent(VERSION)}&X-Amz-Signature=synthetic`, expiresAt: new Date(now + 300000).toISOString() })
const outcome = (status = 'committed', operationId = OPERATION, extra = {}) => ({ operationId, status, createdAt: new Date(NOW).toISOString(), ...(['committed', 'superseded'].includes(status) ? { result: published() } : {}), ...extra })
const response = (value, status = 200) => value instanceof Response ? value : new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const deferred = () => Promise.withResolvers()
class Storage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
function libraries(clock) {
  const modules = new Map()
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])) }
    static now() { return clock.now }
  }
  function load(name) {
    const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new vm.Script(code, { filename }).runInContext(vm.createContext({
      module, exports: module.exports, URL, AbortController, AbortSignal, Response, TextDecoder, TextEncoder, File, Promise,
      Date: ClockDate, fetch: () => { throw new Error('Tests must never use a real network transport') },
      require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) },
    }))
    modules.set(filename, module.exports)
    return module.exports
  }
  return load
}
async function until(predicate) {
  for (let round = 0; round < 100 && !predicate(); round++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(predicate(), 'Expected asynchronous publisher state')
}
function fixture(t, operations = {}, options = {}) {
  const clock = { now: NOW }, load = libraries(clock), calls = [], listeners = new Set(), snapshots = []
  const storage = options.storage ?? new Storage(), scope = options.scope ?? SCOPE
  const session = (ownerSub = OWNER, authenticatedAt = NOW / 1000, deviceKey = 'synthetic-device') => ({ owner: { sub: ownerSub }, authenticatedAt, expiresAt: NOW / 1000 + 3600, device: { key: deviceKey, createdAt: new Date(NOW - 1000).toISOString() } })
  let snapshot = { status: 'authenticated', session: session(), resume: metadata(), resumeStatus: 'ready' }
  let currentReads = 0, uuids = 0
  const notify = () => { for (const listener of listeners) listener() }
  const transport = async (url, request) => {
    const body = request.body ? JSON.parse(request.body) : undefined
    const base = { url, method: request.method, signal: request.signal, body, headers: request.headers }
    if (url === API + '/v1/resume/uploads') {
      const call = { kind: 'authorize', ...base }; calls.push(call)
      return response(operations.authorize ? await operations.authorize(call) : authorization(clock.now))
    }
    if (url.endsWith('/validate')) {
      const call = { kind: 'validate', ...base }; calls.push(call)
      return response(operations.validate ? await operations.validate(call) : receipt(clock.now))
    }
    if (url.endsWith('/preview')) {
      const call = { kind: 'preview', ...base }; calls.push(call)
      return response(operations.preview ? await operations.preview(call) : preview(clock.now))
    }
    if (url === API + '/v1/resume/publications') {
      const call = { kind: 'publish', operationId: request.headers['Idempotency-Key'], checkpoint: [...storage.values.values()], ...base }; calls.push(call)
      const value = operations.publish ? await operations.publish(call) : outcome('committed', call.operationId)
      return response(value, ({ committed: 201, superseded: 200, conflict: 412, failed: 422, unknown: 202, in_progress: 202 })[value.status] ?? 200)
    }
    if (url.startsWith(API + '/v1/resume/publications/')) {
      const call = { kind: 'outcome', operationId: url.split('/').at(-1), ...base }; calls.push(call)
      return response(operations.get ? await operations.get(call) : outcome('committed', call.operationId))
    }
    throw new Error('Unexpected synthetic request: ' + url)
  }
  const uploads = load('resume-upload'), publications = load('resume-publication')
  const client = {
    stagingOrigin: STAGING, publicationScope: scope, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    authorizeResumeUpload(file, signal) { return uploads.authorizeResumeUpload(API, STAGING, snapshot.session.owner.sub, 'synthetic-token', file, signal, transport) },
    validateResumeUpload(uploadId, versionId, signal) { return uploads.validateResumeUpload(API, snapshot.session.owner.sub, 'synthetic-token', uploadId, versionId, signal, transport) },
    getResumePreview(value, signal) { return uploads.getResumePreview(API, STAGING, snapshot.session.owner.sub, 'synthetic-token', value, signal, transport) },
    publishResume(validationId, expectedEtag, operationId, signal) { return publications.publishResume(API, 'synthetic-token', validationId, expectedEtag, operationId, signal, transport) },
    getResumePublication(operationId, signal) { return publications.getResumePublication(API, 'synthetic-token', operationId, signal, transport) },
    async loadResume() {
      const owner = snapshot.session, call = { kind: 'current', index: ++currentReads }; calls.push(call)
      const value = operations.current ? await operations.current(call) : currentReads === 1 ? metadata(CURRENT, 'a'.repeat(64), '"fresh-pointer"') : published()
      if (snapshot.session !== owner) return
      snapshot = { ...snapshot, resume: value, resumeStatus: value ? 'ready' : 'unavailable' }
      notify()
    },
  }
  const { ResumePublisher } = load('resume-publisher')
  const engine = new ResumePublisher(client, {
    storage: options.storageFactory ?? (() => storage), now: () => clock.now,
    uuid: () => [OPERATION, NEXT_OPERATION][uuids++],
    upload: async (origin, ownerSub, grant, file, signal, onProgress) => {
      const call = { kind: 'upload', origin, ownerSub, grant, file, signal, onProgress }; calls.push(call)
      return operations.upload ? operations.upload(call) : { versionId: VERSION, etag: '"staged-object"' }
    },
  })
  engine.subscribe(() => snapshots.push(engine.getSnapshot()))
  const disconnect = options.connect === false ? null : engine.connect()
  t.after(() => engine.dispose())
  return {
    engine, client, storage, publications, uploads, calls, snapshots, clock, disconnect,
    setSession(status, ownerSub = OWNER, authenticatedAt = NOW / 1000, deviceKey = 'synthetic-device') {
      snapshot = { ...snapshot, status, session: status === 'authenticated' ? session(ownerSub, authenticatedAt, deviceKey) : null, resume: null, resumeStatus: 'idle' }
      notify()
    },
  }
}
const posts = fixture => fixture.calls.filter(call => call.kind === 'publish')

test('one publish captures the file and completes every stage once with a fresh pointer and durable UUID', async t => {
  const f = fixture(t, { upload(call) { call.onProgress(37, 100); return { versionId: VERSION, etag: '"staged"' } } })
  const before = f.engine.getSnapshot()
  assert.equal(f.engine.getSnapshot(), before)
  assert.equal(f.calls.length, 0)
  const file = pdf()
  await f.engine.publish(file)
  assert.deepEqual(f.calls.map(call => call.kind), ['authorize', 'upload', 'validate', 'preview', 'current', 'publish', 'current'])
  const upload = f.calls.find(call => call.kind === 'upload'), validation = f.calls.find(call => call.kind === 'validate'), post = posts(f)[0]
  assert.equal(upload.file, file)
  assert.equal(upload.ownerSub, OWNER)
  assert.equal(upload.origin, STAGING)
  assert.deepEqual(validation.body, { versionId: VERSION })
  assert.equal(post.headers['If-Match'], '"fresh-pointer"')
  assert.equal(post.operationId, OPERATION)
  assert.deepEqual(post.body, { validationId: VALIDATION, confirm: true })
  assert.deepEqual(post.checkpoint, [OPERATION])
  assert.ok(f.snapshots.some(value => value.progress === 37))
  assert.equal(f.engine.getSnapshot().progress, null)
  assert.equal(f.engine.getSnapshot().status, 'published')
  assert.equal(f.engine.getSnapshot().operationId, OPERATION)
  assert.equal(f.client.getSnapshot().resume.publicationId, PUBLISHED)
  assert.equal(f.storage.values.size, 0)
})

test('rapid clicks cannot start a second upload or publication, and reset cannot cancel active work', async t => {
  const pending = deferred(), f = fixture(t, { upload: () => pending.promise })
  const first = f.engine.publish(pdf())
  await until(() => f.calls.some(call => call.kind === 'upload'))
  const active = f.engine.getSnapshot()
  f.engine.reset()
  await f.engine.publish(pdf('other.pdf'))
  assert.equal(f.engine.getSnapshot(), active)
  assert.equal(f.calls.filter(call => call.kind === 'authorize').length, 1)
  pending.resolve({ versionId: VERSION, etag: null })
  await first
  assert.equal(posts(f).length, 1)
  assert.equal(f.engine.getSnapshot().status, 'published')
  await f.engine.publish(pdf())
  assert.equal(posts(f).length, 1)
})

test('basic file guards reject invalid selections before any authorization', async t => {
  for (const file of [new File([], 'empty.pdf', { type: 'application/pdf' }), new File(['text'], 'resume.pdf', { type: 'text/plain' }), pdf('../resume.pdf'), pdf('resume.txt'), { name: 'large.pdf', size: 10 * 1024 * 1024 + 1, type: 'application/pdf' }]) {
    const f = fixture(t)
    await f.engine.publish(file)
    assert.equal(f.engine.getSnapshot().status, 'failed')
    assert.equal(f.calls.length, 0)
    assert.equal(f.storage.values.size, 0)
  }
})

test('validation rejection or a receipt for another immutable version cannot publish', async t => {
  for (const validate of [() => response({ error: { code: 'INVALID_PDF', requestId: 'synthetic-request' } }, 422), () => ({ ...receipt(), versionId: 'another-version' }), () => ({ ...receipt(), uploadId: VALIDATION }), () => ({ ...receipt(), bytes: 99 })]) {
    const f = fixture(t, { validate })
    await f.engine.publish(pdf())
    assert.equal(f.engine.getSnapshot().status, 'failed')
    assert.equal(posts(f).length, 0)
    assert.equal(f.calls.some(call => call.kind === 'preview'), false)
    assert.equal(f.storage.values.size, 0)
  }
})

test('unavailable current metadata and preview expiry during its read prevent the publication POST', async t => {
  const unavailable = fixture(t, { current: () => null })
  await unavailable.engine.publish(pdf())
  assert.equal(unavailable.engine.getSnapshot().status, 'failed')
  assert.equal(posts(unavailable).length, 0)
  for (const elapsed of [300000, 3600000]) {
    const pending = deferred(), f = fixture(t, { current: () => pending.promise })
    const publishing = f.engine.publish(pdf())
    await until(() => f.calls.some(call => call.kind === 'current'))
    f.clock.now += elapsed
    pending.resolve(metadata())
    await publishing
    assert.equal(f.engine.getSnapshot().status, 'failed')
    assert.equal(posts(f).length, 0)
    assert.equal(f.storage.values.size, 0)
  }
})

test('conflict and known failure do not retry, while a later explicit click binds fresh metadata and a new UUID', async t => {
  for (const status of ['conflict', 'failed']) {
    let attempts = 0
    const f = fixture(t, {
      publish: call => ++attempts === 1 ? outcome(status, call.operationId, { errorCode: status === 'conflict' ? 'PRECONDITION_FAILED' : 'SOURCE_INTEGRITY' }) : outcome('committed', call.operationId),
      current: call => metadata(CURRENT, 'a'.repeat(64), `"fresh-${call.index}"`),
    })
    await f.engine.publish(pdf())
    assert.equal(f.engine.getSnapshot().status, status)
    assert.equal(posts(f).length, 1)
    assert.equal(f.storage.values.size, 0)
    await f.engine.checkOutcome()
    assert.equal(posts(f).length, 1)
    await f.engine.publish(pdf())
    assert.equal(f.engine.getSnapshot().status, 'published')
    assert.deepEqual(posts(f).map(call => call.operationId), [OPERATION, NEXT_OPERATION])
    assert.notEqual(posts(f)[0].headers['If-Match'], posts(f)[1].headers['If-Match'])
  }
})

test('lost POST response keeps the checkpoint and permits only GET recovery, including a new controller', async t => {
  const f = fixture(t, { publish: () => { throw new Error('response lost after commit') }, get: call => outcome('unknown', call.operationId) })
  await f.engine.publish(pdf())
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  assert.deepEqual([...f.storage.values.values()], [OPERATION])
  const uncertain = f.engine.getSnapshot(), count = f.calls.length
  f.engine.reset()
  await f.engine.publish(pdf('replacement.pdf'))
  assert.equal(f.engine.getSnapshot(), uncertain)
  assert.equal(f.calls.length, count)
  await f.engine.checkOutcome()
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  assert.equal(posts(f).length, 1)
  assert.deepEqual(f.calls.filter(call => call.kind === 'outcome').map(call => call.method), ['GET'])
  f.engine.dispose()
  const restored = fixture(t, {}, { storage: f.storage })
  await until(() => restored.engine.getSnapshot().status === 'published')
  assert.equal(posts(restored).length, 0)
  assert.equal(restored.calls.some(call => ['authorize', 'upload', 'validate', 'preview'].includes(call.kind)), false)
  assert.deepEqual(restored.calls.filter(call => call.kind === 'outcome').map(call => call.operationId), [OPERATION])
  assert.equal(f.storage.values.size, 0)
})

test('receipt expiry after a POST cannot erase or prevent GET-only recovery', async t => {
  const pending = deferred(), f = fixture(t, { publish: () => pending.promise })
  const publishing = f.engine.publish(pdf())
  await until(() => posts(f).length === 1)
  f.clock.now += 3600000
  assert.equal(posts(f)[0].signal.aborted, false)
  pending.resolve(outcome('unknown'))
  await publishing
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  await f.engine.checkOutcome()
  assert.equal(f.engine.getSnapshot().status, 'published')
  assert.equal(posts(f).length, 1)
})

test('malformed or mismatched publication results stay uncertain until a trustworthy matching GET', async t => {
  for (const bad of [outcome('committed', OPERATION, { result: metadata(PUBLISHED, 'd'.repeat(64)) }), outcome('committed', OPERATION, { result: { ...published(), bytes: 99 } }), outcome('committed', NEXT_OPERATION)]) {
    const f = fixture(t, { publish: () => bad })
    await f.engine.publish(pdf())
    assert.equal(f.engine.getSnapshot().status, 'uncertain')
    assert.deepEqual([...f.storage.values.values()], [OPERATION])
    assert.equal(f.calls.filter(call => call.kind === 'current').length, 1)
    await f.engine.publish(pdf())
    assert.equal(posts(f).length, 1)
    await f.engine.checkOutcome()
    assert.equal(f.engine.getSnapshot().status, 'published')
    assert.equal(f.storage.values.size, 0)
  }
})

test('a mismatched GET remains bound to the prepared receipt rather than trusting a valid-looking result', async t => {
  const f = fixture(t, { publish: call => outcome('unknown', call.operationId), get: call => outcome('committed', call.operationId, { result: metadata(PUBLISHED, 'e'.repeat(64)) }) })
  await f.engine.publish(pdf())
  await f.engine.checkOutcome()
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  assert.deepEqual([...f.storage.values.values()], [OPERATION])
  assert.equal(posts(f).length, 1)
})

test('owner loss or identity change cancels every pre-publication stage and ignores late completion', async t => {
  for (const stage of ['authorize', 'upload', 'validate', 'preview', 'current']) {
    for (const change of ['logout', 'owner', 'authentication', 'device']) {
      const pending = deferred(), operations = { [stage]: () => pending.promise }, f = fixture(t, operations)
      const publishing = f.engine.publish(pdf())
      await until(() => f.calls.some(call => call.kind === stage))
      const signals = f.calls.filter(call => call.signal).map(call => call.signal)
      if (change === 'logout') f.setSession('expired')
      else f.setSession('authenticated', change === 'owner' ? 'other-owner' : OWNER, change === 'authentication' ? NOW / 1000 + 1 : NOW / 1000, change === 'device' ? 'other-device' : 'synthetic-device')
      assert.ok(signals.every(signal => signal.aborted))
      const hidden = f.engine.getSnapshot()
      assert.equal(hidden.status, 'idle')
      assert.equal(hidden.operationId, null)
      pending.resolve(({ authorize: authorization(), upload: { versionId: VERSION, etag: null }, validate: receipt(), preview: preview(), current: metadata() })[stage])
      await publishing
      assert.equal(f.engine.getSnapshot(), hidden)
      assert.equal(posts(f).length, 0)
      assert.equal(f.storage.values.size, 0)
    }
  }
})

test('owner loss after POST aborts late success and leaves recovery scoped to the original owner', async t => {
  const pending = deferred(), f = fixture(t, { publish: () => pending.promise })
  const publishing = f.engine.publish(pdf())
  await until(() => posts(f).length === 1)
  f.setSession('authenticated', 'other-owner')
  assert.equal(posts(f)[0].signal.aborted, true)
  const hidden = f.engine.getSnapshot()
  pending.resolve(outcome())
  await publishing
  assert.equal(f.engine.getSnapshot(), hidden)
  assert.equal(hidden.status, 'idle')
  assert.equal(hidden.operationId, null)
  assert.equal(f.calls.filter(call => call.kind === 'current').length, 1)
  assert.equal(f.publications.readPublicationCheckpoint(f.storage, SCOPE, OWNER), OPERATION)
  assert.equal(f.publications.readPublicationCheckpoint(f.storage, SCOPE, 'other-owner'), null)
  f.setSession('authenticated')
  await until(() => f.engine.getSnapshot().status === 'published')
  assert.equal(posts(f).length, 1)
})

test('late GET responses from another owner are ignored without clearing that owner checkpoint', async t => {
  const storage = new Storage(), pending = deferred()
  storage.setItem(`janeway.resume-publication.${encodeURIComponent(SCOPE)}.${OWNER}`, OPERATION)
  const f = fixture(t, { get: () => pending.promise }, { storage })
  assert.equal(f.engine.getSnapshot().status, 'checking')
  const request = f.calls.find(call => call.kind === 'outcome')
  f.setSession('authenticated', 'other-owner')
  assert.equal(request.signal.aborted, true)
  pending.resolve(outcome())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.engine.getSnapshot().status, 'idle')
  assert.equal(f.engine.getSnapshot().operationId, null)
  assert.equal(f.publications.readPublicationCheckpoint(storage, SCOPE, OWNER), OPERATION)
  assert.equal(posts(f).length, 0)
})

test('StrictMode setup-cleanup-setup resumes checkpoints with GET only and suppresses an aborted late response', async t => {
  const storage = new Storage(), pending = deferred()
  storage.setItem(`janeway.resume-publication.${encodeURIComponent(SCOPE)}.${OWNER}`, OPERATION)
  let reads = 0
  const f = fixture(t, { get: call => ++reads === 1 ? pending.promise : outcome('unknown', call.operationId) }, { storage, connect: false })
  const cleanup = f.engine.connect()
  const first = f.calls.find(call => call.kind === 'outcome')
  cleanup(); cleanup()
  assert.equal(first.signal.aborted, true)
  const cleanupAgain = f.engine.connect()
  await until(() => f.engine.getSnapshot().status === 'uncertain')
  const latest = f.engine.getSnapshot()
  pending.resolve(outcome())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.engine.getSnapshot(), latest)
  assert.deepEqual(f.calls.map(call => call.kind), ['outcome', 'outcome'])
  assert.equal(posts(f).length, 0)
  assert.deepEqual([...storage.values.values()], [OPERATION])
  cleanupAgain()
})

test('disconnect aborts a transfer, ignores progress and late upload completion, and reconnect can publish a new file', async t => {
  const pending = deferred()
  let uploads = 0
  const f = fixture(t, { upload: () => ++uploads === 1 ? pending.promise : { versionId: VERSION, etag: null } })
  const publishing = f.engine.publish(pdf())
  await until(() => f.calls.some(call => call.kind === 'upload'))
  const transfer = f.calls.find(call => call.kind === 'upload')
  f.disconnect()
  assert.equal(transfer.signal.aborted, true)
  const after = f.engine.getSnapshot()
  transfer.onProgress(100, 100)
  pending.resolve({ versionId: VERSION, etag: null })
  await publishing
  assert.equal(f.engine.getSnapshot(), after)
  assert.equal(posts(f).length, 0)
  const cleanup = f.engine.connect()
  await f.engine.publish(pdf('replacement.pdf'))
  assert.equal(f.engine.getSnapshot().status, 'published')
  assert.equal(posts(f).length, 1)
  cleanup()
})

test('a confirmed commit survives metadata refresh failure and cannot be replayed by Publish or Check status', async t => {
  for (const refresh of ['throw', 'unavailable']) {
    const f = fixture(t, { current(call) { if (call.index === 1) return metadata(); if (refresh === 'throw') throw new Error('refresh failed'); return null } })
    await f.engine.publish(pdf())
    assert.equal(f.engine.getSnapshot().status, 'published')
    assert.equal(f.storage.values.size, 0)
    await f.engine.publish(pdf())
    await f.engine.checkOutcome()
    assert.equal(posts(f).length, 1)
    assert.equal(f.calls.filter(call => call.kind === 'outcome').length, 0)
    f.engine.reset()
    assert.equal(f.engine.getSnapshot().status, 'idle')
  }
})

test('historical committed and superseded checkpoints resolve without a file or mutation', async t => {
  for (const status of ['committed', 'superseded']) {
    const storage = new Storage()
    storage.setItem(`janeway.resume-publication.${encodeURIComponent(SCOPE)}.${OWNER}`, OPERATION)
    const f = fixture(t, { get: call => outcome(status, call.operationId), current: () => null }, { storage })
    await until(() => ['published', 'superseded'].includes(f.engine.getSnapshot().status))
    assert.equal(f.engine.getSnapshot().status, status === 'committed' ? 'published' : status)
    assert.equal(posts(f).length, 0)
    assert.equal(storage.values.size, 0)
    await f.engine.publish(pdf())
    assert.equal(posts(f).length, 0)
    f.engine.reset()
    assert.equal(f.engine.getSnapshot().status, 'idle')
  }
})

test('missing operation records stay ambiguous and cannot be erased by reset or file replacement', async t => {
  const storage = new Storage()
  storage.setItem(`janeway.resume-publication.${encodeURIComponent(SCOPE)}.${OWNER}`, OPERATION)
  const f = fixture(t, { get: () => response({ error: { code: 'NOT_FOUND', requestId: 'synthetic-request' } }, 404) }, { storage })
  await until(() => f.engine.getSnapshot().status === 'uncertain')
  assert.equal(f.engine.getSnapshot().requestId, 'synthetic-request')
  f.engine.reset()
  await f.engine.publish(pdf())
  await f.engine.checkOutcome()
  assert.equal(posts(f).length, 0)
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  assert.deepEqual([...storage.values.values()], [OPERATION])
})

test('recovery is isolated by owner and configuration and constructor storage access is lazy', async t => {
  const storage = new Storage()
  storage.setItem(`janeway.resume-publication.${encodeURIComponent(SCOPE)}.other-owner`, OPERATION)
  storage.setItem(`janeway.resume-publication.${encodeURIComponent('other-environment')}.${OWNER}`, NEXT_OPERATION)
  let reads = 0
  const f = fixture(t, {}, { storage, connect: false, storageFactory: () => { reads++; return storage } })
  assert.equal(reads, 0)
  const cleanup = f.engine.connect()
  assert.equal(reads, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.engine.getSnapshot().status, 'idle')
  cleanup()
})

test('unreadable or unwritable checkpoints prevent the publication mutation', async t => {
  for (const mode of ['access', 'read', 'write', 'readback']) {
    const storage = new Storage()
    if (mode === 'read') storage.getItem = () => { throw new Error('storage unavailable') }
    if (mode === 'write') storage.setItem = () => { throw new Error('storage quota') }
    if (mode === 'readback') storage.setItem = () => {}
    const f = fixture(t, {}, { storage, storageFactory: () => { if (mode === 'access') throw new Error('storage disabled'); return storage } })
    await f.engine.publish(pdf())
    assert.equal(posts(f).length, 0)
    assert.equal(f.engine.getSnapshot().status, 'failed')
    assert.equal(storage.values.size, 0)
  }
})

test('a checkpoint appearing during preparation cannot be overwritten with a second publication', async t => {
  const pending = deferred(), f = fixture(t, { current: () => pending.promise })
  const publishing = f.engine.publish(pdf())
  await until(() => f.calls.some(call => call.kind === 'current'))
  f.publications.savePublicationCheckpoint(f.storage, SCOPE, OWNER, NEXT_OPERATION)
  pending.resolve(metadata())
  await publishing
  assert.equal(f.engine.getSnapshot().status, 'uncertain')
  assert.equal(f.engine.getSnapshot().operationId, NEXT_OPERATION)
  assert.deepEqual([...f.storage.values.values()], [NEXT_OPERATION])
  assert.equal(posts(f).length, 0)
})

test('a new selected file can publish only after resetting a confirmed terminal result', async t => {
  const f = fixture(t)
  await f.engine.publish(pdf())
  await f.engine.publish(pdf('replacement.pdf'))
  assert.equal(posts(f).length, 1)
  f.engine.reset()
  await f.engine.publish(pdf('replacement.pdf'))
  assert.equal(f.engine.getSnapshot().status, 'published')
  assert.deepEqual(posts(f).map(call => call.operationId), [OPERATION, NEXT_OPERATION])
  assert.equal(f.calls.filter(call => call.kind === 'upload').at(-1).file.name, 'replacement.pdf')
})

test('disconnect after POST retains its checkpoint and reconnect checks status without repeating publication', async t => {
  const pending = deferred(), f = fixture(t, { publish: () => pending.promise })
  const publishing = f.engine.publish(pdf())
  await until(() => posts(f).length === 1)
  f.disconnect()
  assert.equal(posts(f)[0].signal.aborted, true)
  assert.deepEqual([...f.storage.values.values()], [OPERATION])
  const cleanup = f.engine.connect()
  await until(() => f.engine.getSnapshot().status === 'published')
  const committed = f.engine.getSnapshot()
  pending.resolve(outcome('failed', OPERATION, { errorCode: 'SOURCE_INTEGRITY' }))
  await publishing
  assert.equal(f.engine.getSnapshot(), committed)
  assert.equal(posts(f).length, 1)
  assert.equal(f.calls.filter(call => call.kind === 'outcome').length, 1)
  assert.equal(f.storage.values.size, 0)
  cleanup()
})

test('checking an ambiguous operation blocks concurrent checks, reset and replacement publication', async t => {
  const pending = deferred(), f = fixture(t, { publish: call => outcome('in_progress', call.operationId), get: () => pending.promise })
  await f.engine.publish(pdf())
  const checking = f.engine.checkOutcome()
  assert.equal(f.engine.getSnapshot().status, 'checking')
  f.engine.reset()
  await Promise.all([f.engine.checkOutcome(), f.engine.publish(pdf('replacement.pdf'))])
  assert.equal(f.engine.getSnapshot().status, 'checking')
  assert.equal(posts(f).length, 1)
  assert.equal(f.calls.filter(call => call.kind === 'outcome').length, 1)
  pending.resolve(outcome())
  await checking
  assert.equal(f.engine.getSnapshot().status, 'published')
})

test('expiry immediately before checkpointing is rechecked even without an asynchronous clock event', async t => {
  const f = fixture(t)
  f.engine.subscribe(() => {
    const snapshot = f.engine.getSnapshot()
    if (snapshot.status === 'publishing' && snapshot.operationId) f.clock.now += 3600000
  })
  await f.engine.publish(pdf())
  assert.equal(f.engine.getSnapshot().status, 'failed')
  assert.equal(posts(f).length, 0)
  assert.equal(f.storage.values.size, 0)
})
