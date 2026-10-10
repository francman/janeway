const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
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
    module, exports: module.exports, URL, AbortController, AbortSignal, Response, fetch, setTimeout, clearTimeout,
    require(specifier) { return specifier.startsWith('./') ? load(specifier.slice(2)) : sourceRequire(specifier) },
  })
  new vm.Script(code, { filename }).runInContext(context)
  modules.set(filename, module.exports)
  return module.exports
}
const { OwnerSessionClient } = load('session')
const { DeviceStorage } = load('device-storage')
const { NativeAuth, AuthFailure, authFailure } = load('auth')
const { ownerRequest, parseSession, parseResume } = load('api')
const config = {
  origin: 'https://admin.example.test',
  authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture',
  poolId: 'us-east-1_fixture', clientId: 'fixtureclient',
  apiUrl: 'https://fixture.execute-api.us-east-1.amazonaws.com',
}
const prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
const user = {
  accessToken: 'synthetic-access', sub: 'owner-sub', username: 'canonical-owner',
  authTime: 1000, expiresAt: 1300, issuer: config.authority, clientId: config.clientId,
  scope: 'janeway-admin/access aws.cognito.signin.user.admin', deviceKey: 'us-east-1_device', loginKind: 'fresh',
}
const device = { key: user.deviceKey, createdAt: new Date(1000_000).toISOString(), expiresAt: new Date(1000_000 + 30 * 86400_000).toISOString() }
const session = { owner: { sub: user.sub }, authenticatedAt: 1000, expiresAt: 1300, device }
const resume = {
  schemaVersion: 1, publicationId: '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1', sha256: 'a'.repeat(64),
  key: `documents/resume/revisions/${'a'.repeat(64)}/inline/frank-manu-resume.pdf`, bytes: 1234,
  publishedAt: '2026-10-09T12:00:00Z', publicUrl: 'https://www.frankmanu.com/resume.pdf',
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(value, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: '"exact-pointer-etag"' } })
}
class Storage {
  values = new Map()
  get length() { return this.values.size }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
  clear() { this.values.clear() }
}
async function populate(storage, owner = user) {
  await storage.setItem(prefix + 'LastAuthUser', owner.username)
  for (const [key, value] of Object.entries({ accessToken: owner.accessToken, idToken: 'synthetic-id', refreshToken: 'synthetic-refresh', deviceKey: owner.deviceKey, deviceGroupKey: 'device-group', randomPasswordKey: 'random-device-password' })) {
    await storage.setItem(`${prefix}${owner.username}.${key}`, value)
  }
}
function fixture(t) {
  const state = { now: 1000, refreshes: 0, signIns: 0, clears: 0, requests: [], signOuts: 0, trusts: 0, forgotten: 0, saved: false, restarts: 0 }
  let current = { ...user }
  let refresh = async () => ({ ...current, accessToken: 'synthetic-rotated', expiresAt: state.now + 300, loginKind: 'refresh' })
  let signIn = async () => ({ kind: 'done', user: current })
  let trust = async () => { state.saved = true; return true }
  let transport = async url => response(url.endsWith('/session') ? { ...session, expiresAt: state.now + 300 } : url.endsWith('/device') ? null : resume, url.endsWith('/device') ? 204 : 200)
  const auth = {
    signIn: async () => { state.signIns++; return signIn() }, confirm: async () => signIn(),
    reset: async () => ({ kind: 'reset-confirm' }), completeReset: async () => { state.forgotten++ },
    refresh: async () => { state.refreshes++; return refresh() }, clear: () => { state.clears++ },
    signOut: async () => { state.signOuts++ }, restart: () => { state.restarts++ },
    isTrusted: () => state.saved, trust: async () => { state.trusts++; return trust() }, forgetLocal: () => { state.forgotten++; state.saved = false },
  }
  const client = new OwnerSessionClient(config, auth, async (url, options) => { state.requests.push({ url, options }); return transport(url, options) }, () => state.now)
  t.after(() => client.clear('expired'))
  return {
    client, state,
    setUser(value) { current = value }, setTransport(value) { transport = value }, setRefresh(value) { refresh = value },
    setSignIn(value) { signIn = value }, setTrust(value) { trust = value },
    start: async (remember = false) => { client.start(); await client.signIn('owner@example.test', 'synthetic-password', remember) },
  }
}
function nativeFixture() {
  const persistent = new Storage(), transactions = new Storage()
  const storage = new DeviceStorage(config, persistent, () => 1000_000)
  const state = { navigations: [], requests: [], remembers: 0 }
  const token = { payload: { token_use: 'access', username: user.username, sub: user.sub, auth_time: user.authTime, exp: user.expiresAt, iss: user.issuer, client_id: user.clientId, scope: user.scope, device_key: user.deviceKey, janeway_login_kind: 'fresh' }, toString: () => user.accessToken }
  const sdk = {
    signIn: async () => { await populate(storage); return { isSignedIn: true, nextStep: { signInStep: 'DONE' } } },
    confirmSignIn: async () => ({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } }),
    fetchAuthSession: async () => ({ tokens: { accessToken: token } }),
    rememberDevice: async () => { state.remembers++ },
    resetPassword: async () => ({ nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE', codeDeliveryDetails: { destination: 'o***@example.test' } } }),
    confirmResetPassword: async () => {},
  }
  const environment = { transactions, navigate: url => state.navigations.push(url), transport: async (url, options) => { state.requests.push({ url, options }); return response({}) } }
  const auth = new NativeAuth(config, storage, environment, sdk)
  return { auth, storage, persistent, transactions, state, sdk, environment }
}

test('all SDK keys are memory-default and only explicit confirmed device promotion persists', async () => {
  const persistent = new Storage()
  const storage = new DeviceStorage(config, persistent, () => 1000_000)
  await populate(storage)
  await storage.setItem('unknownSDKKey', 'synthetic-secret')
  assert.equal(persistent.length, 0)
  storage.promote(user.username, 'owner@example.test', session)
  const record = JSON.parse(persistent.getItem(storage.recordKey))
  assert.deepEqual(Object.keys(record).sort(), ['version', 'poolId', 'clientId', 'username', 'sub', 'loginId', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey', 'expiresAt'].sort())
  assert.equal(record.expiresAt, device.expiresAt)
  assert.ok(!JSON.stringify(record).includes('synthetic-'))
  const reloaded = new DeviceStorage(config, persistent, () => 1001_000)
  reloaded.hydrate('owner@example.test')
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.deviceKey`), user.deviceKey)
  assert.equal(await reloaded.getItem(`${prefix}LastAuthUser`), null)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.refreshToken`), null)
  reloaded.hydrate('different-owner')
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.deviceKey`), null)
})

test('sealing is irreversible; late token writes never restore readable Auth state', async () => {
  const storage = new DeviceStorage(config, new Storage(), () => 1000_000)
  await populate(storage)
  storage.seal(true)
  await storage.setItem(`${prefix}${user.username}.accessToken`, 'late-access')
  await storage.setItem(`${prefix}${user.username}.refreshToken`, 'late-rotating-refresh')
  assert.equal(await storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(await storage.getItem(`${prefix}${user.username}.refreshToken`), null)
  assert.throws(() => storage.hydrate('owner@example.test'))
  assert.equal(storage.takeRevocationToken(), 'late-rotating-refresh')
  await storage.setItem(`${prefix}${user.username}.refreshToken`, 'even-later')
  assert.equal(storage.takeRevocationToken(), null)
})

test('saved proof expires, is pool/client scoped, and repeated login cannot extend server expiry', async () => {
  const persistent = new Storage()
  let now = 1000_000
  const storage = new DeviceStorage(config, persistent, () => now)
  await populate(storage)
  storage.promote(user.username, 'owner@example.test', session)
  const original = storage.saved()
  now += 86400_000
  storage.promote(user.username, 'owner@example.test', { ...session, device: { ...device, expiresAt: new Date(Date.parse(device.expiresAt) + 86400_000).toISOString() } })
  assert.equal(storage.saved().expiresAt, original.expiresAt)
  const otherPool = new DeviceStorage({ ...config, poolId: 'us-east-1_other' }, persistent, () => now)
  assert.equal(otherPool.saved(), null)
  now = Date.parse(original.expiresAt)
  assert.equal(storage.saved(), null)
  assert.equal(persistent.length, 0)
})

test('malformed, future, and wrong-client saved proof is discarded instead of hydrated', async () => {
  const persistent = new Storage()
  const storage = new DeviceStorage(config, persistent, () => 1000_000)
  await populate(storage)
  storage.promote(user.username, 'owner@example.test', session)
  const valid = storage.saved()
  for (const value of [{ ...valid, clientId: 'other' }, { ...valid, expiresAt: 'not-a-date' }, { ...valid, expiresAt: new Date(1000_000 + 31 * 86400_000).toISOString() }, { ...valid, randomPasswordKey: '' }]) {
    persistent.setItem(storage.recordKey, JSON.stringify(value))
    assert.equal(storage.saved(), null)
    assert.equal(persistent.length, 0)
  }
})

test('Cognito DONE without complete matching confirmation metadata fails closed', async () => {
  for (const key of ['deviceKey', 'deviceGroupKey', 'randomPasswordKey']) {
    const f = nativeFixture()
    f.sdk.signIn = async () => { await populate(f.storage); await f.storage.removeItem(`${prefix}${user.username}.${key}`); return { isSignedIn: true, nextStep: { signInStep: 'DONE' } } }
    await assert.rejects(f.auth.signIn('owner@example.test', 'synthetic-password'), error => error.code === 'device-confirmation' && error.terminal)
    assert.equal(f.persistent.length, 0)
  }
})

test('rememberDevice completion, not opt-in or metadata alone, gates local persistence', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  const pending = deferred(), started = deferred()
  f.sdk.rememberDevice = async () => { started.resolve(); await pending.promise }
  const saving = f.auth.trust(user, session)
  await started.promise
  assert.equal(f.persistent.length, 0)
  pending.reject(new Error('service-unavailable'))
  await assert.rejects(saving, error => error.code === 'trust-failed')
  assert.equal(f.persistent.length, 0)
  f.sdk.rememberDevice = async () => {}
  await f.auth.trust(user, session)
  assert.equal(f.persistent.length, 1)
})

test('late rememberDevice success cannot promote device proof after cancellation', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  const pending = deferred(), started = deferred()
  f.sdk.rememberDevice = async () => { started.resolve(); await pending.promise }
  const saving = f.auth.trust(user, session)
  await started.promise
  f.auth.clear()
  pending.resolve()
  await assert.rejects(saving, error => error.terminal)
  assert.equal(f.persistent.length, 0)
})

test('cancel clears transactions immediately and again after late SDK challenge writes', async () => {
  const f = nativeFixture()
  const pending = deferred(), started = deferred()
  f.sdk.signIn = async () => { started.resolve(); await pending.promise; f.transactions.setItem('CognitoSignInState.signInSession', 'late-transaction'); return { isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } } }
  const signingIn = f.auth.signIn('owner@example.test', 'synthetic-password')
  await started.promise
  f.transactions.setItem('CognitoSignInState.signInSession', 'transaction')
  f.auth.restart()
  assert.equal(f.transactions.length, 0)
  pending.resolve()
  await assert.rejects(signingIn, error => error.terminal)
  assert.equal(f.transactions.length, 0)
  assert.deepEqual(f.state.navigations, [config.origin + '/'])
})

test('logout seals memory, revokes the newest in-flight rotating token and goes to public homepage', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  await f.auth.trust(user, session)
  const pending = deferred(), started = deferred()
  f.sdk.fetchAuthSession = async () => { started.resolve(); await pending.promise; await f.storage.setItem(`${prefix}${user.username}.refreshToken`, 'newest-rotating-token'); return { tokens: {} } }
  const refreshing = f.auth.refresh()
  await started.promise
  const signingOut = f.auth.signOut()
  assert.equal(await f.storage.getItem(`${prefix}${user.username}.accessToken`), null)
  pending.resolve()
  await assert.rejects(refreshing)
  await signingOut
  assert.equal(JSON.parse(f.state.requests[0].options.body).Token, 'newest-rotating-token')
  assert.equal(f.state.requests[0].url, 'https://cognito-idp.us-east-1.amazonaws.com')
  assert.equal(f.persistent.length, 1)
  assert.equal(f.transactions.length, 0)
  assert.deepEqual(f.state.navigations, ['https://www.frankmanu.com/'])
})

test('terminal storage failure cannot prevent local logout or public-homepage navigation', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  f.transactions.clear = () => { throw new Error('Storage disabled') }
  await f.auth.signOut()
  assert.equal(await f.storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.deepEqual(f.state.navigations, ['https://www.frankmanu.com/'])
})

test('device/refresh logins cannot create replacement trust; existing proof is not re-remembered', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  await assert.rejects(f.auth.trust({ ...user, loginKind: 'device' }, session), error => error.code === 'trust-failed')
  assert.equal(f.state.remembers, 0)
  await f.auth.trust(user, session)
  const original = f.persistent.getItem(f.storage.recordKey)
  await f.auth.trust({ ...user, loginKind: 'device' }, session)
  assert.equal(f.state.remembers, 1)
  assert.equal(f.persistent.getItem(f.storage.recordKey), original)
})

test('revocation network failure still clears local state and navigates to public homepage', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  f.environment.transport = async () => { throw new Error('offline') }
  await f.auth.signOut()
  assert.equal(await f.storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(f.transactions.length, 0)
  assert.deepEqual(f.state.navigations, ['https://www.frankmanu.com/'])
})

test('successful password recovery clears saved proof; failed confirmation does not claim recovery', async () => {
  const f = nativeFixture()
  await populate(f.storage)
  f.storage.promote(user.username, 'owner@example.test', session)
  f.sdk.confirmResetPassword = async () => { throw { name: 'CodeMismatchException' } }
  await assert.rejects(f.auth.completeReset('owner@example.test', '123456', 'new-password'), error => error.code === 'code-mismatch')
  assert.equal(f.persistent.length, 1)
  f.sdk.confirmResetPassword = async () => {}
  await f.auth.completeReset('owner@example.test', '654321', 'new-password')
  assert.equal(f.persistent.length, 0)
})

test('reused or expired TOTP remains retryable; invalid sign-in transaction is terminal', async t => {
  assert.equal(authFailure({ name: 'ExpiredCodeException', message: 'software token has already been used once' }, true).code, 'code-expired')
  assert.equal(authFailure({ name: 'ExpiredCodeException' }, true).terminal, false)
  assert.equal(authFailure({ name: 'NotAuthorizedException' }, true).code, 'transaction-expired')
  assert.equal(authFailure({ name: 'NotAuthorizedException' }, true).terminal, true)
  const f = fixture(t)
  f.setSignIn(async () => ({ kind: 'totp', secret: 'in-memory-only-seed', uri: 'otpauth://totp/fixture?secret=seed' }))
  await f.start()
  f.setSignIn(async () => { throw { name: 'ExpiredCodeException' } })
  await f.client.confirm('123456')
  assert.equal(f.client.getSnapshot().status, 'login')
  assert.equal(f.client.getSnapshot().flow.kind, 'totp')
  f.setSignIn(async () => { throw { name: 'NotAuthorizedException' } })
  await f.client.confirm('654321')
  assert.equal(f.client.getSnapshot().status, 'error')
  assert.ok(!JSON.stringify(f.client.getSnapshot()).includes('in-memory-only-seed'))
})

test('only backend owner authorization can promote trust or open private data', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  f.setTransport(async () => { started.resolve(); return pending.promise })
  const starting = f.start(true)
  await started.promise
  assert.equal(f.client.getSnapshot().status, 'verifying')
  assert.equal(f.state.trusts, 0)
  pending.resolve(response({ error: { code: 'OWNER_NOT_ACTIVE', message: 'private-details' } }, 403))
  await starting
  assert.equal(f.client.getSnapshot().status, 'denied')
  assert.equal(f.state.trusts, 0)
  assert.equal(f.client.getSnapshot().session, null)
  assert.ok(!JSON.stringify(f.client.getSnapshot()).includes('private-details'))
})

test('MFA enrollment without owner scope is denied rather than mislabeled expired', async t => {
  const f = fixture(t)
  f.setUser({ ...user, scope: 'aws.cognito.signin.user.admin' })
  await f.start(true)
  assert.equal(f.client.getSnapshot().status, 'denied')
  assert.equal(f.state.trusts, 0)
  assert.equal(f.state.requests.length, 0)
})

test('opt-in trust failure is honest and does not invalidate an authorized memory session', async t => {
  const f = fixture(t)
  f.setTrust(async () => { throw new AuthFailure('trust-failed') })
  await f.start(true)
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.client.getSnapshot().deviceTrusted, false)
  assert.equal(f.client.getSnapshot().notice, 'trust-failed')
  await f.client.checkSession()
  assert.equal(f.state.trusts, 1)
})

test('a late owner-approved trust result cannot reopen a signed-out workspace', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  f.setTrust(async () => { started.resolve(); return pending.promise })
  const signingIn = f.start(true)
  await started.promise
  await f.client.signOut()
  pending.resolve(true)
  await signingIn
  assert.equal(f.client.getSnapshot().status, 'signing-out')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().deviceTrusted, false)
})

test('refresh failures close the memory session without retrying or showing old metadata', async t => {
  const f = fixture(t)
  await f.start()
  await f.client.loadResume()
  f.state.now = 1250
  f.setRefresh(async () => { throw new Error('synthetic-secret-error') })
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  assert.equal(f.state.refreshes, 1)
  assert.equal(f.state.requests.length, 2)
})

test('concurrent owner requests serialize rotation and use the same rotated access token', async t => {
  const f = fixture(t)
  await f.start()
  f.state.now = 1250
  const pending = deferred()
  f.setRefresh(() => pending.promise)
  const checking = f.client.checkSession(), reading = f.client.loadResume()
  assert.equal(f.state.refreshes, 1)
  pending.resolve({ ...user, accessToken: 'rotated-access', expiresAt: 1550, loginKind: 'refresh' })
  await Promise.all([checking, reading])
  assert.equal(f.state.refreshes, 1)
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  for (const request of f.state.requests.slice(1)) assert.equal(request.options.headers.Authorization, 'Bearer rotated-access')
})

test('late owner data and rotating tokens cannot resurrect a cleared session', async t => {
  for (const phase of ['api', 'refresh']) {
    const f = fixture(t), pending = deferred(), started = deferred()
    await f.start()
    if (phase === 'api') f.setTransport(async () => { started.resolve(); return pending.promise })
    else { f.state.now = 1250; f.setRefresh(async () => { started.resolve(); return pending.promise }) }
    const reading = f.client.loadResume()
    await started.promise
    await f.client.signOut()
    pending.resolve(phase === 'api' ? response(resume) : { ...user, expiresAt: 1550 })
    await reading
    assert.equal(f.client.getSnapshot().status, 'signing-out')
    assert.equal(f.client.getSnapshot().session, null)
    assert.equal(f.client.getSnapshot().resume, null)
  }
})

test('late sign-in success cannot restore a cancelled session or call owner API', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  f.setSignIn(async () => { started.resolve(); return pending.promise })
  const signingIn = f.start(true)
  await started.promise
  f.client.cancel()
  pending.resolve({ kind: 'done', user })
  await signingIn
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.state.trusts, 0)
  assert.equal(f.state.restarts, 1)
})

test('device error codes clear local proof and private metadata; native Gateway errors fail closed', async t => {
  for (const code of ['DEVICE_NOT_FOUND', 'DEVICE_EXPIRED', 'DEVICE_REVOKED', 'gateway401', 'gateway403']) {
    const f = fixture(t)
    await f.start()
    await f.client.loadResume()
    f.state.saved = true
    f.setTransport(async () => code.startsWith('gateway') ? new Response('Gateway rejected request', { status: Number(code.slice(7)) }) : response({ error: { code, requestId: 'request-123' } }, 403))
    await f.client.checkSession()
    assert.equal(f.client.getSnapshot().session, null)
    assert.equal(f.client.getSnapshot().resume, null)
    assert.equal(f.client.getSnapshot().status, code === 'gateway403' ? 'denied' : 'expired')
    if (code.startsWith('DEVICE_')) { assert.equal(f.state.forgotten, 1); assert.equal(f.client.getSnapshot().deviceError, code) }
  }
})

test('refresh cannot change identity/device/auth_time or extend the eight-hour boundary', async t => {
  for (const alteration of [{ sub: 'other' }, { deviceKey: 'other-device' }, { authTime: 1001 }, { username: 'other-username' }]) {
    const f = fixture(t)
    await f.start()
    f.state.now = 1250
    f.setRefresh(async () => ({ ...user, expiresAt: 1550, ...alteration }))
    await f.client.checkSession()
    assert.equal(f.client.getSnapshot().status, 'expired')
    assert.equal(f.state.requests.length, 1)
  }
  const f = fixture(t)
  await f.start()
  f.state.now = 1000 + 8 * 3600 - 10
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  f.state.now += 10
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.state.refreshes, 1)
})

test('server device expiry bounds an otherwise valid memory session', async t => {
  const f = fixture(t)
  const now = 30 * 86400 + 1000
  f.state.now = now
  f.setUser({ ...user, authTime: now, expiresAt: now + 300 })
  f.setTransport(async () => response({ ...session, authenticatedAt: now, expiresAt: now + 300, device: { ...device, createdAt: new Date(1010_000).toISOString(), expiresAt: new Date((now + 10) * 1000).toISOString() } }))
  await f.start()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  f.state.now += 10
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.state.requests.length, 1)
})

test('forget uses fixed DELETE and only confirmed 204 removes local proof and signs out', async t => {
  const f = fixture(t)
  await f.start(true)
  f.setTransport(async () => response({ error: { code: 'UNAVAILABLE' } }, 503))
  await f.client.forgetDevice()
  assert.equal(f.state.forgotten, 0)
  assert.equal(f.state.signOuts, 0)
  assert.equal(f.client.getSnapshot().deviceStatus, 'error')
  f.setTransport(async () => response(null, 204))
  await f.client.forgetDevice()
  assert.equal(f.state.forgotten, 1)
  assert.equal(f.state.signOuts, 1)
  const last = f.state.requests.at(-1)
  assert.equal(last.url, config.apiUrl + '/v1/device')
  assert.equal(last.options.method, 'DELETE')
  assert.equal(last.options.body, undefined)
  assert.equal(last.options.credentials, 'omit')
})

test('device deletion without no-store or exact 204 cannot claim success', async () => {
  for (const result of [new Response(null, { status: 204 }), response({}, 200)]) {
    await assert.rejects(ownerRequest(config.apiUrl, 'device', user.accessToken, new AbortController().signal, async () => result), error => error.kind === 'unavailable')
  }
})

test('reload opens an idle login form, never a persisted authenticated session or automatic redirect', t => {
  const f = fixture(t)
  f.client.start()
  f.client.start()
  assert.equal(f.client.getSnapshot().status, 'login')
  assert.equal(f.client.getSnapshot().flow.kind, 'credentials')
  assert.equal(f.state.signIns, 0)
  assert.equal(f.state.requests.length, 0)
})

test('backend unavailability hides private data and recovers only within the existing session', async t => {
  const f = fixture(t)
  await f.start()
  await f.client.loadResume()
  f.setTransport(async () => response({ error: { code: 'UNAVAILABLE', requestId: 'request-123', message: 'private-details' } }, 503))
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'unavailable')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  f.setTransport(async () => response(session))
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.client.getSnapshot().resume, null)
})

test('mismatched/malformed owner devices and publication metadata are never accepted', () => {
  for (const invalid of [
    { ...session, owner: { sub: 'other' } }, { ...session, device: { ...device, key: 'other-device' } },
    { ...session, device: { ...device, createdAt: 'invalid' } },
    { ...session, device: { ...device, expiresAt: new Date(Date.parse(device.expiresAt) + 1).toISOString() } },
    { ...session, device: { ...device, createdAt: '2026-02-31T12:00:00.000Z' } },
  ]) assert.throws(() => parseSession(invalid, user.sub, 1000, user.deviceKey))
  for (const invalid of [{ ...resume, publicUrl: 'https://attacker.invalid/resume.pdf' }, { ...resume, key: 'private/other-object.pdf' }, { ...resume, bytes: 0 }, { ...resume, publishedAt: '2026-02-31T12:00:00Z' }]) assert.throws(() => parseResume(invalid, '"pointer-etag"'))
  assert.throws(() => parseResume(resume, null))
})

test('an HTTP response crossing expiry is rejected even before a delayed timer fires', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  await f.start()
  f.setTransport(async () => { started.resolve(); return pending.promise })
  const reading = f.client.loadResume()
  await started.promise
  f.state.now = 1300
  pending.resolve(response(resume))
  await reading
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.client.getSnapshot().resume, null)
})
