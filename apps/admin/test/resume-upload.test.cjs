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
const TOKEN = 'synthetic-access'
const UPLOAD_ID = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const VALIDATION_ID = '54c69aa4-ae81-4a91-a5d0-e16b4765e20c'
const VERSION = '3/L4kqtJlcpXroDTDmJ+RMspXd3dIbrHY'
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const KEY = `uploads/${OWNER}/${UPLOAD_ID}/file.pdf`
const MAX_BYTES = 10 * 1024 * 1024
const pdf = () => new File([Buffer.from('%PDF-fixture')], 'resume.pdf', { type: 'application/pdf' })
const noStore = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const authorization = (now = NOW) => ({ uploadId: UPLOAD_ID, upload: { url: STAGING + '/', fields: { key: KEY, policy: 'signed-policy', 'Content-Type': 'application/pdf', success_action_status: '201', 'x-amz-server-side-encryption': 'AES256' }, expiresAt: new Date(now + 300000).toISOString(), maxBytes: MAX_BYTES } })
const receipt = (now = NOW) => ({ schemaVersion: 1, validationId: VALIDATION_ID, uploadId: UPLOAD_ID, key: KEY, versionId: VERSION, sha256: 'a'.repeat(64), bytes: 100, pageCount: 2, validatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString() })
const preview = (now = NOW) => ({ url: `${STAGING}/${KEY}?versionId=${encodeURIComponent(VERSION)}&X-Amz-Signature=fixture`, expiresAt: new Date(now + 300000).toISOString() })

function clockDate(clock) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])) }
    static now() { return clock.now }
  }
}
function library(globals = {}) {
  const modules = new Map()
  function load(name) {
    const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
    if (modules.has(filename)) return modules.get(filename)
    const sourceRequire = createRequire(filename)
    const module = { exports: {} }
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const context = vm.createContext({ module, exports: module.exports, require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) }, URL, AbortController, FormData, File, XMLHttpRequest: class {}, fetch, Response, Promise, Date: clockDate({ now: NOW }), ...globals })
    new vm.Script(code, { filename }).runInContext(context)
    modules.set(filename, module.exports)
    return module.exports
  }
  return load('resume-upload')
}
const uploadClient = library()
const { authorizeResumeUpload, validateResumeUpload, getResumePreview, uploadPdfToStaging, UploadFailure } = uploadClient
const signal = () => new AbortController().signal
const rejected = code => error => error instanceof UploadFailure && error.code === code

function xhrFixture(send = function () { this.onload() }, headers = { 'x-amz-version-id': VERSION, etag: '"etag"' }) {
  return {
    upload: {}, status: 201, sent: 0, aborted: 0,
    open(method, url) { this.method = method; this.url = url },
    getResponseHeader(name) { return headers[name.toLowerCase()] ?? null },
    send(form) { this.sent++; this.entries = [...form.entries()]; send.call(this) },
    abort() { this.aborted++; this.onabort?.() },
  }
}

test('authorization accepts only the configured staging root and authenticated owner key', async () => {
  const grant = authorization()
  const result = await authorizeResumeUpload(API, STAGING, OWNER, TOKEN, pdf(), signal(), async () => noStore(grant))
  assert.equal(result.uploadId, UPLOAD_ID)
  assert.equal(result.upload.fields.key, KEY)
  const substitutions = [
    { url: 'https://attacker.invalid/' },
    { url: 'https://janeway-resume-staging-999999999999-us-east-1.s3.us-east-1.amazonaws.com/' },
    { url: STAGING + '/other' },
    { url: STAGING + '/?redirect=elsewhere' },
    { url: STAGING.replace('https://', 'https://user:password@') + '/' },
    { url: STAGING + '/#fragment' },
    { fields: { ...grant.upload.fields, key: `uploads/other/${UPLOAD_ID}/file.pdf` } },
    { fields: { ...grant.upload.fields, key: `uploads/${OWNER}/../${UPLOAD_ID}/file.pdf` } },
    { fields: { ...grant.upload.fields, success_action_status: '204' } },
    { fields: { ...grant.upload.fields, 'Content-Type': 'text/html' } },
    { fields: { ...grant.upload.fields, policy: 42 } },
    { expiresAt: new Date(NOW).toISOString() },
    { expiresAt: new Date(NOW + 3600000).toISOString() },
  ]
  for (const substitution of substitutions) {
    await assert.rejects(authorizeResumeUpload(API, STAGING, OWNER, TOKEN, pdf(), signal(), async () => noStore({ ...grant, upload: { ...grant.upload, ...substitution } })), rejected('UNAVAILABLE'))
  }
  await assert.rejects(authorizeResumeUpload(API, STAGING, '../owner', TOKEN, pdf(), signal(), async () => noStore(grant)), rejected('INVALID_REQUEST'))
})

test('receipt validation binds owner, upload and immutable version with a live one-hour expiry', async () => {
  const value = receipt()
  const validated = await validateResumeUpload(API, OWNER, TOKEN, UPLOAD_ID, VERSION, signal(), async () => noStore(value))
  assert.equal(validated.validationId, VALIDATION_ID)
  const substitutions = [
    { key: `uploads/other/${UPLOAD_ID}/file.pdf` },
    { uploadId: VALIDATION_ID },
    { versionId: 'other-version' },
    { versionId: 'null' },
    { sha256: 'not-a-digest' },
    { pageCount: 201 },
    { bytes: MAX_BYTES + 1 },
    { validatedAt: new Date(NOW - 3600000).toISOString(), expiresAt: new Date(NOW).toISOString() },
    { validatedAt: new Date(NOW + 60000).toISOString(), expiresAt: new Date(NOW + 3660000).toISOString() },
    { expiresAt: new Date(NOW + 7200000).toISOString() },
  ]
  for (const substitution of substitutions) {
    await assert.rejects(validateResumeUpload(API, OWNER, TOKEN, UPLOAD_ID, VERSION, signal(), async () => noStore({ ...value, ...substitution })), rejected('UNAVAILABLE'))
  }
})

test('preview binds the exact owner key and version and cannot outlive the receipt', async () => {
  const value = preview()
  const result = await getResumePreview(API, STAGING, OWNER, TOKEN, receipt(), signal(), async () => noStore(value))
  assert.equal(result.url, value.url)
  const substitutions = [
    { url: value.url.replace(STAGING, 'https://attacker.invalid') },
    { url: value.url.replace(`/uploads/${OWNER}/`, '/uploads/other/') },
    { url: value.url.replace(encodeURIComponent(VERSION), 'other-version') },
    { url: value.url + '&versionId=' + encodeURIComponent(VERSION) },
    { url: value.url.replace('https://', 'https://user:password@') },
    { url: value.url + '#fragment' },
    { expiresAt: new Date(NOW).toISOString() },
    { expiresAt: new Date(NOW + 3600000).toISOString() },
  ]
  for (const substitution of substitutions) {
    await assert.rejects(getResumePreview(API, STAGING, OWNER, TOKEN, receipt(), signal(), async () => noStore({ ...value, ...substitution })), rejected('UNAVAILABLE'))
  }
  const nearExpiry = receipt(NOW - 3590000)
  await assert.rejects(getResumePreview(API, STAGING, OWNER, TOKEN, nearExpiry, signal(), async () => noStore(value)), rejected('UNAVAILABLE'))
  await assert.rejects(getResumePreview(API, STAGING, OWNER, TOKEN, receipt(NOW - 3600000), signal(), async () => noStore(value)), rejected('VALIDATION_EXPIRED'))
})

test('late preview responses cannot resurrect an expired validation', async () => {
  const clock = { now: NOW }
  const client = library({ Date: clockDate(clock) })
  const value = receipt(NOW - 3590000)
  await assert.rejects(client.getResumePreview(API, STAGING, OWNER, TOKEN, value, signal(), async () => {
    clock.now += 10000
    return noStore(preview(clock.now))
  }), error => error.code === 'VALIDATION_EXPIRED')
})

test('direct upload appends the file last and requires a versioned 201 result', async () => {
  const file = pdf(), progress = []
  const xhr = xhrFixture(function () {
    this.upload.onprogress({ loaded: file.size, total: file.size, lengthComputable: true })
    this.onload()
  })
  const grant = authorization()
  const result = await uploadPdfToStaging(STAGING, OWNER, grant, file, signal(), (loaded, total) => progress.push([loaded, total]), () => xhr)
  assert.equal(xhr.method, 'POST')
  assert.equal(xhr.url, STAGING + '/')
  assert.deepEqual(xhr.entries.slice(0, -1), Object.entries(grant.upload.fields))
  assert.equal(xhr.entries.at(-1)[0], 'file')
  assert.equal(xhr.entries.at(-1)[1], file)
  assert.deepEqual(progress, [[file.size, file.size]])
  assert.equal(result.versionId, VERSION)
  assert.equal(result.etag, '"etag"')
  assert.equal(xhr.withCredentials, false)
  assert.ok(xhr.timeout > 0 && xhr.timeout <= 120000)
})

test('unsafe or expired grants never create a transfer', async () => {
  for (const change of [
    { url: 'https://attacker.invalid/' },
    { fields: { ...authorization().upload.fields, key: `uploads/other/${UPLOAD_ID}/file.pdf` } },
    { expiresAt: new Date(NOW).toISOString() },
  ]) {
    let created = false
    const grant = authorization()
    await assert.rejects(uploadPdfToStaging(STAGING, OWNER, { ...grant, upload: { ...grant.upload, ...change } }, pdf(), signal(), () => {}, () => { created = true; return xhrFixture() }), rejected('UNAVAILABLE'))
    assert.equal(created, false)
  }
})

test('pre-aborted and opening-time cancellation never send bytes', async () => {
  const request = new AbortController()
  request.abort()
  let created = false
  await assert.rejects(uploadPdfToStaging(STAGING, OWNER, authorization(), pdf(), request.signal, () => {}, () => { created = true; return xhrFixture() }), rejected('TRANSFER_INTERRUPTED'))
  assert.equal(created, false)
  const duringOpen = new AbortController()
  const xhr = xhrFixture()
  xhr.open = () => duringOpen.abort()
  await assert.rejects(uploadPdfToStaging(STAGING, OWNER, authorization(), pdf(), duringOpen.signal, () => {}, () => xhr), rejected('TRANSFER_INTERRUPTED'))
  assert.equal(xhr.sent, 0)
})

test('aborted, timed-out and interrupted transfers never claim success or remain pending', async () => {
  for (const mode of ['error', 'timeout', 'abort', 'missing-version', 'rejected', 'send-throws']) {
    const request = new AbortController()
    const xhr = xhrFixture(function () {
      if (mode === 'error') this.onerror()
      else if (mode === 'timeout') this.ontimeout()
      else if (mode === 'abort') request.abort()
      else if (mode === 'send-throws') throw new Error('transport broke')
      else this.onload()
    }, mode === 'missing-version' ? {} : undefined)
    if (mode === 'rejected') xhr.status = 204
    await assert.rejects(uploadPdfToStaging(STAGING, OWNER, authorization(), pdf(), request.signal, () => {}, () => xhr), rejected(mode === 'missing-version' ? 'UNAVAILABLE' : mode === 'rejected' ? 'TRANSFER_REJECTED' : 'TRANSFER_INTERRUPTED'))
    assert.equal(xhr.upload.onprogress, null)
    assert.equal(xhr.onload, null)
  }
})

test('null-version S3 responses cannot authorize validation of a mutable object', async () => {
  const xhr = xhrFixture(undefined, { 'x-amz-version-id': 'null' })
  await assert.rejects(uploadPdfToStaging(STAGING, OWNER, authorization(), pdf(), signal(), () => {}, () => xhr), rejected('UNAVAILABLE'))
  await assert.rejects(validateResumeUpload(API, OWNER, TOKEN, UPLOAD_ID, 'null', signal(), async () => noStore(receipt())), rejected('INVALID_REQUEST'))
})

