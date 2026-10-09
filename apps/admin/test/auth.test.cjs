const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { webcrypto, createHash } = require('node:crypto')
const ts = require('typescript')

const modules = new Map()
function load(name) {
  const filename = path.resolve(__dirname, '../src/lib', name + '.ts')
  if (modules.has(filename)) return modules.get(filename)
  const sourceRequire = createRequire(filename)
  const module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const context = vm.createContext({
    module, exports: module.exports,
    URL, URLSearchParams, AbortController, AbortSignal, Response, fetch, setTimeout, clearTimeout,
    crypto: webcrypto,
    require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) },
  })
  new vm.Script(code, { filename }).runInContext(context)
  modules.set(filename, module.exports)
  return module.exports
}

const { OwnerSessionClient } = load('session')
const { MemoryUserStore, TransactionStore } = load('auth-storage')
const { oidcSettings } = load('oidc')
const { parseResume } = load('api')
const config = {
  origin: 'https://admin.example.test',
  authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture',
  clientId: 'fixtureclient',
  cognitoDomain: 'https://fixture.auth.us-east-1.amazoncognito.com',
  apiUrl: 'https://fixture.execute-api.us-east-1.amazonaws.com',
}
const resume = {
  schemaVersion: 1,
  publicationId: '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1',
  sha256: 'a'.repeat(64),
  key: `documents/resume/revisions/${'a'.repeat(64)}/inline/frank-manu-resume.pdf`,
  bytes: 1234,
  publishedAt: '2026-10-09T12:00:00Z',
  publicUrl: 'https://www.frankmanu.com/resume.pdf',
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: '"exact-pointer-etag"' } })
}
function fixture(t) {
  const state = { now: 1000, refreshes: 0, redirects: 0, clears: 0, requests: [], signedOut: null }
  let user = {
    access_token: 'synthetic-access-original', refresh_token: 'synthetic-refresh-original',
    expires_at: 1300, token_type: 'Bearer', scope: 'openid email janeway-admin/access',
    profile: { sub: 'owner-sub', auth_time: 1000, iss: config.authority, aud: config.clientId },
  }
  let refresh = async () => ({ ...user, access_token: 'synthetic-access-rotated', refresh_token: 'synthetic-refresh-rotated', expires_at: state.now + 300 })
  let transport = async url => response(url.endsWith('/session') ? { owner: { sub: 'owner-sub' }, authenticatedAt: 1000, expiresAt: state.now + 300 } : resume)
  const auth = {
    signIn: async () => { state.redirects++ },
    callback: async () => user,
    refresh: async () => { state.refreshes++; return refresh() },
    clear: () => { state.clears++ },
    signOut: async value => { state.signedOut = value },
  }
  const client = new OwnerSessionClient(config, auth, async (url, options) => { state.requests.push({ url, options }); return transport(url, options) }, () => state.now)
  t.after(() => client.clear('signed-out'))
  return {
    client, state, user,
    setUser(value) { user = value },
    setTransport(value) { transport = value },
    setRefresh(value) { refresh = value },
    start: () => client.start('callback', `${config.origin}/auth/callback/?code=fixture&state=fixture`),
  }
}

class Storage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

test('authorization transactions expire, consume once, and do not share user token storage', async () => {
  const storage = new Storage()
  let now = 1000
  const transactions = new TransactionStore(storage, () => now)
  const users = new MemoryUserStore()
  await transactions.set('request', 'synthetic-state-nonce-verifier')
  await users.set('user', 'synthetic-bearer-refresh-id-tokens')
  assert.equal(storage.length, 1)
  assert.ok(![...storage.values.values()].join('').includes('synthetic-bearer'))
  assert.equal(await transactions.remove('request'), 'synthetic-state-nonce-verifier')
  assert.equal(await transactions.remove('request'), null)
  await transactions.set('concurrent', 'single-use-verifier')
  const consumed = await Promise.all([transactions.remove('concurrent'), transactions.remove('concurrent')])
  assert.equal(consumed.filter(value => value === 'single-use-verifier').length, 1)
  await transactions.set('old', 'old-verifier')
  now += 600_000
  assert.equal(await transactions.remove('old'), null)
  await transactions.set('future', 'future-verifier')
  now -= 1
  assert.equal(await transactions.get('future'), null)
  users.seal()
  await users.set('user', 'late-refresh-must-not-resurrect')
  assert.equal(await users.get('user'), null)
  assert.equal(storage.length, 0)
})

test('real OIDC code flow uses S256 and rejects missing state, replay, and a wrong nonce', async t => {
  const { OidcClient } = require('oidc-client-ts')
  const storage = new Storage()
  const transactions = new TransactionStore(storage)
  const settings = oidcSettings(config, transactions, new MemoryUserStore())
  const oidc = new OidcClient(settings)
  const jwt = claims => `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`
  let tokenCalls = 0
  let nonce = 'wrong-nonce'
  let verifier
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), `${config.cognitoDomain}/oauth2/token`)
    tokenCalls++
    const body = new URLSearchParams(options.body)
    verifier = body.get('code_verifier')
    assert.ok(verifier)
    assert.equal(body.get('client_secret'), null)
    return response({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 300, scope: settings.scope, id_token: jwt({ sub: 'owner-sub', iss: config.authority, aud: config.clientId, nonce, auth_time: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 }) })
  })
  const request = await oidc.createSigninRequest({ nonce: 'expected-nonce' })
  const authorize = new URL(request.url)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('response_type'), 'code')
  assert.equal(authorize.searchParams.get('nonce'), 'expected-nonce')
  const state = authorize.searchParams.get('state')
  assert.ok(state)
  await assert.rejects(oidc.processSigninResponse(`${config.origin}/auth/callback/?code=fixture&state=not-the-state`))
  assert.equal(tokenCalls, 0)
  await assert.rejects(oidc.processSigninResponse(`${config.origin}/auth/callback/?code=fixture&state=${state}`), /nonce/i)
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'))
  assert.equal(storage.length, 0)
  await assert.rejects(oidc.processSigninResponse(`${config.origin}/auth/callback/?code=fixture&state=${state}`))
  assert.equal(tokenCalls, 1)
  nonce = 'valid-nonce'
  const valid = await oidc.createSigninRequest({ nonce })
  const result = await oidc.processSigninResponse(`${config.origin}/auth/callback/?code=fixture&state=${new URL(valid.url).searchParams.get('state')}`)
  assert.equal(result.profile.sub, 'owner-sub')
  assert.equal(storage.length, 0)
})

test('only backend authorization opens the workspace; rejected accounts expose no private data', async t => {
  const f = fixture(t)
  const pending = deferred()
  f.setTransport(() => pending.promise)
  const starting = f.start()
  assert.equal(f.client.getSnapshot().status, 'verifying')
  assert.equal(f.client.getSnapshot().session, null)
  pending.resolve(response({ error: { code: 'OWNER_NOT_ACTIVE', message: 'raw-private-details' } }, 403))
  await starting
  assert.equal(f.client.getSnapshot().status, 'denied')
  assert.equal(f.client.getSnapshot().resume, null)
  assert.ok(!JSON.stringify(f.client.getSnapshot()).includes('raw-private-details'))
  assert.equal(f.state.requests.length, 1)
})


test('concurrent API requests serialize refresh and use the rotated token', async t => {
  const f = fixture(t)
  await f.start()
  f.state.now = 1250
  const pending = deferred()
  f.setRefresh(() => pending.promise)
  const checking = f.client.checkSession()
  const reading = f.client.loadResume()
  assert.equal(f.state.refreshes, 1)
  pending.resolve({ ...f.user, access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_at: 1550 })
  await Promise.all([checking, reading])
  assert.equal(f.state.refreshes, 1)
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  for (const request of f.state.requests.slice(1)) assert.equal(request.options.headers.Authorization, 'Bearer synthetic-new-access')
})

test('late refresh cannot resurrect a signed-out session and newest refresh token is revoked', async t => {
  const f = fixture(t)
  await f.start()
  await f.client.loadResume()
  f.state.now = 1250
  const pending = deferred()
  f.setRefresh(() => pending.promise)
  const checking = f.client.checkSession()
  const signingOut = f.client.signOut()
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  pending.resolve({ ...f.user, access_token: 'late-access', refresh_token: 'latest-refresh', expires_at: 1550 })
  await Promise.all([checking, signingOut])
  assert.equal(f.client.getSnapshot().status, 'signing-out')
  assert.equal(f.state.signedOut.refresh_token, 'latest-refresh')
  assert.equal(f.state.requests.length, 2)
})

test('late owner API response cannot restore private data after local expiry', async t => {
  const f = fixture(t)
  await f.start()
  const pending = deferred()
  f.setTransport(() => pending.promise)
  const reading = f.client.loadResume()
  await Promise.resolve()
  f.client.clear('expired')
  pending.resolve(response(resume))
  await reading
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.client.getSnapshot().resume, null)
})

test('refresh failure, native Gateway 401, and owner 403 all fail closed without retry loops', async t => {
  for (const mode of ['refresh', '401', '403']) {
    const f = fixture(t)
    await f.start()
    if (mode === 'refresh') {
      f.state.now = 1250
      f.setRefresh(async () => { throw new Error('synthetic-secret-failure') })
    } else f.setTransport(async () => new Response('Gateway rejected request', { status: Number(mode) }))
    await f.client.loadResume()
    assert.equal(f.client.getSnapshot().status, mode === '403' ? 'denied' : 'expired')
    assert.equal(f.client.getSnapshot().session, null)
    assert.equal(f.client.getSnapshot().resume, null)
    assert.ok(f.state.refreshes <= 1)
    assert.ok(f.state.requests.length <= 2)
  }
})

test('refresh rotation cannot extend the eight-hour authentication boundary', async t => {
  const f = fixture(t)
  await f.start()
  f.state.now = 1000 + 8 * 60 * 60 - 10
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.state.refreshes, 1)
  f.state.now = 1000 + 8 * 60 * 60
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.state.refreshes, 1)
  assert.equal(f.state.requests.length, 2)
})

test('reload starts a fresh authorization flow but signed-out landing never auto-signs in', async t => {
  const reload = fixture(t)
  await Promise.all([reload.client.start('workspace'), reload.client.start('workspace')])
  assert.equal(reload.state.redirects, 1)
  assert.equal(reload.state.requests.length, 0)
  const signedOut = fixture(t)
  await signedOut.client.start('signed-out')
  assert.equal(signedOut.state.redirects, 0)
  assert.equal(signedOut.client.getSnapshot().status, 'signed-out')
})

test('backend unavailability hides old owner data and can recover within the existing session', async t => {
  const f = fixture(t)
  await f.start()
  await f.client.loadResume()
  f.setTransport(async () => response({ error: { code: 'UNAVAILABLE', requestId: 'request-123', message: 'private-storage-details' } }, 503))
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'unavailable')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  assert.equal(f.client.getSnapshot().requestId, 'request-123')
  f.setTransport(async () => response({ owner: { sub: 'owner-sub' }, authenticatedAt: 1000, expiresAt: 1300 }))
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.client.getSnapshot().resume, null)
})

test('session subject mismatch and malformed publication data never open private content', async t => {
  const f = fixture(t)
  f.setTransport(async () => response({ owner: { sub: 'different-sub' }, authenticatedAt: 1000, expiresAt: 1300 }))
  await f.start()
  assert.equal(f.client.getSnapshot().status, 'unavailable')
  assert.equal(f.client.getSnapshot().session, null)
  for (const invalid of [
    { ...resume, publicUrl: 'https://attacker.invalid/resume.pdf' },
    { ...resume, key: 'private/other-object.pdf' },
    { ...resume, bytes: 0 },
    { ...resume, publishedAt: '2026-02-31T12:00:00Z' },
  ]) assert.throws(() => parseResume(invalid, '"pointer-etag"'))
  assert.throws(() => parseResume(resume, null))
})
