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
    module, exports: module.exports, URL, AbortController, AbortSignal, Response, TextEncoder, fetch, setTimeout, clearTimeout,
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
  loginId: 'owner@example.test', apiUrl: 'https://fixture.execute-api.us-east-1.amazonaws.com',
}
const prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
const user = {
  accessToken: 'synthetic-access', sub: 'owner-sub', username: 'canonical-owner',
  authTime: 1000, expiresAt: 1300, issuer: config.authority, clientId: config.clientId,
  deviceKey: 'us-east-1_device',
}
const device = { key: user.deviceKey, createdAt: new Date(1000_000).toISOString() }
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
  key(index) { return [...this.values.keys()][index] ?? null }
  clear() { this.values.clear() }
}
async function populate(storage, owner = user) {
  await storage.setItem(prefix + 'LastAuthUser', owner.username)
  for (const [key, value] of Object.entries({ accessToken: owner.accessToken, idToken: 'synthetic-id', refreshToken: 'synthetic-refresh', deviceKey: owner.deviceKey, deviceGroupKey: 'device-group', randomPasswordKey: 'random-device-password', clockDrift: '0' })) {
    await storage.setItem(`${prefix}${owner.username}.${key}`, value)
  }
}
function fixture(t) {
  const state = { now: 1000, refreshes: 0, restores: 0, signIns: 0, clears: 0, requests: [], signOuts: 0, trusts: 0, forgotten: 0, saved: false, restarts: 0, preserveCheckpoint: false }
  let current = { ...user }
  let refresh = async () => ({ ...current, accessToken: 'synthetic-rotated', expiresAt: state.now + 300 })
  let signIn = async () => ({ kind: 'done', user: current })
  let restore = async () => null
  let trust = async () => { state.saved = true; return true }
  let transport = async url => response(url.endsWith('/session') ? { ...session, expiresAt: state.now + 300 } : url.endsWith('/device') ? null : resume, url.endsWith('/device') ? 204 : 200)
  const auth = {
    signIn: async () => { state.signIns++; return signIn() }, confirm: async () => signIn(),
    restore: async () => { state.restores++; return restore() },
    refresh: async () => { state.refreshes++; return refresh() },
    clear: (_forSignOut, preserveCheckpoint = false) => { state.clears++; state.preserveCheckpoint = preserveCheckpoint },
    signOut: async () => { state.signOuts++ }, restart: () => { state.restarts++ },
    isTrusted: () => state.saved, trust: async () => { state.trusts++; return trust() }, forgetLocal: () => { state.forgotten++; state.saved = false },
  }
  const client = new OwnerSessionClient(config, auth, async (url, options) => { state.requests.push({ url, options }); return transport(url, options) }, () => state.now)
  t.after(() => client.clear('expired'))
  return {
    client, state,
    setUser(value) { current = value }, setTransport(value) { transport = value }, setRefresh(value) { refresh = value },
    setSignIn(value) { signIn = value }, setRestore(value) { restore = value }, setTrust(value) { trust = value },
    start: async (remember = false) => { await client.signIn('owner@example.test', 'synthetic-password', remember) },
  }
}
function nativeFixture({ persistent = new Storage(), transactions = new Storage(), now = () => 1000 } = {}) {
  const storage = new DeviceStorage(config, persistent, transactions, now)
  const state = { navigations: [], requests: [], remembers: 0, fetches: [], owner: { ...user } }
  const token = owner => ({ payload: { token_use: owner.tokenUse ?? 'access', username: owner.username, sub: owner.sub, auth_time: owner.authTime, exp: owner.expiresAt, iss: owner.issuer, client_id: owner.clientId, device_key: owner.deviceKey }, toString: () => owner.accessToken })
  const sdk = {
    signIn: async () => { await populate(storage); return { isSignedIn: true, nextStep: { signInStep: 'DONE' } } },
    confirmSignIn: async () => ({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } }),
    fetchAuthSession: async options => { state.fetches.push(options); return { tokens: { accessToken: token(state.owner) } } },
    rememberDevice: async () => { state.remembers++ },
  }
  const environment = { transactions, navigate: url => state.navigations.push(url), transport: async (url, options) => { state.requests.push({ url, options }); return response({}) } }
  const auth = new NativeAuth(config, storage, environment, sdk)
  return { auth, storage, persistent, transactions, state, sdk, environment }
}

test('SDK writes stay memory-first and localStorage persists only explicitly promoted confirmed device proof', async () => {
  const persistent = new Storage()
  const storage = new DeviceStorage(config, persistent)
  await populate(storage)
  await storage.setItem('unknownSDKKey', 'synthetic-secret')
  assert.equal(persistent.length, 0)
  storage.promote(user.username, 'owner@example.test', session)
  const record = JSON.parse(persistent.getItem(storage.recordKey))
  assert.deepEqual(Object.keys(record).sort(), ['version', 'poolId', 'clientId', 'username', 'sub', 'loginId', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey'].sort())
  assert.equal(record.version, 2)
  assert.ok(!JSON.stringify(record).includes('synthetic-'))
  const reloaded = new DeviceStorage(config, persistent)
  reloaded.hydrate('owner@example.test')
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.deviceKey`), user.deviceKey)
  assert.equal(await reloaded.getItem(`${prefix}LastAuthUser`), null)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.refreshToken`), null)
  reloaded.hydrate('different-owner')
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.deviceKey`), null)
})

test('sealing is irreversible; late token writes never restore readable Auth state', async () => {
  const tab = new Storage()
  const storage = new DeviceStorage(config, new Storage(), tab, () => 1000)
  await populate(storage)
  storage.checkpoint(user.authTime)
  storage.seal(true)
  await storage.setItem(`${prefix}${user.username}.accessToken`, 'late-access')
  await storage.setItem(`${prefix}${user.username}.refreshToken`, 'late-rotating-refresh')
  assert.equal(await storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(await storage.getItem(`${prefix}${user.username}.refreshToken`), null)
  storage.checkpoint(user.authTime)
  assert.equal(tab.length, 0)
  assert.throws(() => storage.hydrate('owner@example.test'))
  assert.equal(storage.takeRevocationToken(), 'synthetic-refresh')
  await storage.setItem(`${prefix}${user.username}.refreshToken`, 'even-later')
  assert.equal(storage.takeRevocationToken(), null)
})

test('tab checkpoints contain only the configured canonical SDK session and never write bearer tokens to localStorage', async () => {
  const tab = new Storage(), persistent = new Storage()
  const storage = new DeviceStorage(config, persistent, tab, () => 1000)
  await populate(storage)
  for (const key of ['accountPassword', 'signInDetails', 'qrSeed', 'ownerMetadata', 'sourcePdf']) {
    await storage.setItem(`${prefix}${user.username}.${key}`, 'excluded-secret')
  }
  await storage.setItem(`${prefix}other-owner.accessToken`, 'other-owner-token')
  await storage.setItem('CognitoIdentityServiceProvider.otherclient.LastAuthUser', 'other-client')
  assert.equal(tab.length, 0)
  storage.checkpoint(user.authTime)
  const record = JSON.parse(tab.getItem(storage.sessionKey))
  assert.equal(record.authTime, user.authTime)
  assert.equal(record.expiresAt, user.authTime + 8 * 3600)
  assert.deepEqual(Object.keys(record.values).sort(), [
    prefix + 'LastAuthUser',
    ...['accessToken', 'idToken', 'refreshToken', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey', 'clockDrift'].map(key => `${prefix}${user.username}.${key}`),
  ].sort())
  assert.equal(persistent.length, 0)
  assert.ok(!JSON.stringify(record).includes('excluded-secret'))
  assert.ok(!JSON.stringify(record).includes('other-owner-token'))
  const reloaded = new DeviceStorage(config, persistent, tab, () => 1001)
  assert.equal(reloaded.restore(), true)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.accessToken`), user.accessToken)
  assert.equal(await reloaded.getItem(`${prefix}${user.username}.refreshToken`), 'synthetic-refresh')
  assert.equal(reloaded.confirmed(user.username, user.deviceKey), true)
  assert.equal(reloaded.isSaved(user.username, user.sub, user.deviceKey), false)
  assert.equal(persistent.length, 0)
})

test('malformed, wrong-client, extra-key, oversized and expired tab records are discarded', async () => {
  const tab = new Storage()
  const storage = new DeviceStorage(config, null, tab, () => 1000)
  await populate(storage)
  storage.checkpoint(user.authTime)
  const valid = JSON.parse(tab.getItem(storage.sessionKey))
  for (const value of [
    null, { ...valid, version: 2 }, { ...valid, clientId: 'wrong-client' }, { ...valid, poolId: 'wrong-pool' },
    { ...valid, owner: { sub: user.sub } }, { ...valid, expiresAt: valid.expiresAt + 1 },
    { ...valid, authTime: 1061, expiresAt: 1061 + 8 * 3600 },
    { ...valid, values: { ...valid.values, unknownKey: 'must-not-hydrate' } },
    { ...valid, values: { ...valid.values, [`${prefix}${user.username}.deviceKey`]: '' } },
    { ...valid, values: { ...valid.values, [`${prefix}${user.username}.accessToken`]: '\u754c'.repeat(25_000) } },
  ]) {
    tab.setItem(storage.sessionKey, JSON.stringify(value))
    const reloaded = new DeviceStorage(config, null, tab, () => 1000)
    assert.equal(reloaded.restore(), false)
    assert.equal(await reloaded.getItem(prefix + 'LastAuthUser'), null)
    assert.equal(tab.getItem(storage.sessionKey), null)
  }
  tab.setItem(storage.sessionKey, '{broken')
  assert.equal(new DeviceStorage(config, null, tab, () => 1000).restore(), false)
  tab.setItem(storage.sessionKey, JSON.stringify(valid))
  const boundary = new DeviceStorage(config, null, tab, () => valid.expiresAt)
  assert.equal(boundary.restore(), false)
  assert.equal(tab.getItem(storage.sessionKey), null)
})

test('rotation preserves the original eight-hour deadline and never checkpoints an extended auth_time', async () => {
  const tab = new Storage()
  let now = 1000
  const storage = new DeviceStorage(config, null, tab, () => now)
  await populate(storage)
  storage.checkpoint(user.authTime)
  now = user.authTime + 8 * 3600 - 1
  await storage.setItem(`${prefix}${user.username}.refreshToken`, 'rotated-refresh')
  storage.checkpoint(user.authTime)
  const record = JSON.parse(tab.getItem(storage.sessionKey))
  assert.equal(record.expiresAt, user.authTime + 8 * 3600)
  assert.equal(record.values[`${prefix}${user.username}.refreshToken`], 'rotated-refresh')
  assert.throws(() => storage.checkpoint(now))
  assert.equal(tab.getItem(storage.sessionKey), null)
  now++
  assert.throws(() => storage.checkpoint(user.authTime))
  assert.equal(tab.getItem(storage.sessionKey), null)
})

test('unavailable tab storage and over-size checkpoints retain only the usable memory session', async () => {
  const tab = new Storage()
  const storage = new DeviceStorage(config, null, tab, () => 1000)
  await populate(storage)
  storage.checkpoint(user.authTime)
  await storage.setItem(`${prefix}${user.username}.idToken`, '\u754c'.repeat(25_000))
  storage.checkpoint(user.authTime)
  assert.equal(tab.getItem(storage.sessionKey), null)
  assert.equal(await storage.getItem(`${prefix}${user.username}.accessToken`), user.accessToken)
  tab.setItem = () => { throw new Error('Storage unavailable') }
  await storage.removeItem(`${prefix}${user.username}.idToken`)
  storage.checkpoint(user.authTime)
  assert.equal(await storage.getItem(`${prefix}${user.username}.refreshToken`), 'synthetic-refresh')
})

test('reload sealing preserves only the last settled checkpoint; later writes and logout cannot resurrect it', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  const before = f.transactions.getItem(f.storage.sessionKey)
  f.auth.clear(false, true)
  assert.equal(f.transactions.getItem(f.storage.sessionKey), before)
  assert.equal(await f.storage.getItem(prefix + 'LastAuthUser'), null)
  await f.storage.setItem(`${prefix}${user.username}.refreshToken`, 'late-rotation')
  f.storage.checkpoint(user.authTime)
  assert.equal(f.transactions.getItem(f.storage.sessionKey), before)
  const reloaded = nativeFixture({ persistent: f.persistent, transactions: f.transactions })
  assert.equal((await reloaded.auth.restore()).accessToken, user.accessToken)
  assert.equal(reloaded.state.fetches.length, 1)
  assert.equal(reloaded.state.fetches[0].forceRefresh, false)
  await f.auth.signOut()
  assert.equal(f.transactions.getItem(f.storage.sessionKey), null)
  reloaded.auth.clear()
})

test('startup transaction cleanup removes only known Cognito challenge keys and preserves the authenticated checkpoint', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  const before = f.transactions.getItem(f.storage.sessionKey)
  for (const key of ['username', 'challengeName', 'signInSession', 'expiry']) f.transactions.setItem(`CognitoSignInState.${key}`, 'stale')
  f.transactions.setItem('CognitoSignInState.unrelated', 'keep')
  f.transactions.setItem('other-tab-data', 'keep')
  const reloaded = nativeFixture({ transactions: f.transactions })
  for (const key of ['username', 'challengeName', 'signInSession', 'expiry']) assert.equal(f.transactions.getItem(`CognitoSignInState.${key}`), null)
  assert.equal(f.transactions.getItem('CognitoSignInState.unrelated'), 'keep')
  assert.equal(f.transactions.getItem('other-tab-data'), 'keep')
  assert.equal(f.transactions.getItem(f.storage.sessionKey), before)
  assert.ok(await reloaded.auth.restore())
  f.auth.clear()
  reloaded.auth.clear()
})

test('missing tab session never asks the SDK to restore global state', async () => {
  const f = nativeFixture()
  assert.equal(await f.auth.restore(), null)
  assert.equal(f.state.fetches.length, 0)
})

test('SDK rotation checkpoints only settled results, and a late refresh after logout stays sealed', async () => {
  for (const logout of [false, true]) {
    const f = nativeFixture()
    await f.auth.signIn('owner@example.test', 'synthetic-password')
    const before = f.transactions.getItem(f.storage.sessionKey)
    const pending = deferred(), started = deferred()
    f.sdk.fetchAuthSession = async () => {
      await f.storage.setItem(`${prefix}${user.username}.accessToken`, 'partial-access')
      started.resolve()
      await pending.promise
      await f.storage.setItem(`${prefix}${user.username}.refreshToken`, 'rotated-refresh')
      return { tokens: { accessToken: { payload: { token_use: 'access', username: user.username, device_key: user.deviceKey, auth_time: user.authTime }, toString: () => 'rotated-access' } } }
    }
    const refreshing = f.auth.refresh()
    await started.promise
    assert.equal(f.transactions.getItem(f.storage.sessionKey), before)
    if (logout) {
      await f.auth.signOut()
      assert.equal(f.transactions.getItem(f.storage.sessionKey), null)
      assert.equal(JSON.parse(f.state.requests[0].options.body).Token, 'synthetic-refresh')
    }
    pending.resolve()
    if (logout) {
      await assert.rejects(refreshing, error => error.code === 'cancelled' && error.terminal)
      assert.equal(f.transactions.getItem(f.storage.sessionKey), null)
      assert.equal(await f.storage.getItem(`${prefix}${user.username}.refreshToken`), null)
    } else {
      await refreshing
      const record = JSON.parse(f.transactions.getItem(f.storage.sessionKey))
      assert.equal(record.values[`${prefix}${user.username}.refreshToken`], 'rotated-refresh')
      assert.equal(record.expiresAt, user.authTime + 8 * 3600)
    }
    f.auth.clear()
  }
})

test('saved proof remains until revocation, is pool/client scoped, and migrates the deployed v1 record', async () => {
  const persistent = new Storage()
  const storage = new DeviceStorage(config, persistent)
  await populate(storage)
  storage.promote(user.username, 'owner@example.test', session)
  const original = storage.saved()
  assert.equal(original.version, 2)
  storage.promote(user.username, 'owner@example.test', session)
  assert.deepEqual(storage.saved(), original)
  const legacy = { ...original, version: 1, expiresAt: '2020-01-01T00:00:00.000Z' }
  persistent.setItem(storage.recordKey, JSON.stringify(legacy))
  assert.deepEqual(storage.saved(), original)
  assert.equal(JSON.parse(persistent.getItem(storage.recordKey)).version, 2)
  assert.equal(new DeviceStorage({ ...config, poolId: 'us-east-1_other' }, persistent).saved(), null)
})

test('malformed, extra-field, and wrong-client saved proof is discarded instead of hydrated', async () => {
  const persistent = new Storage()
  const storage = new DeviceStorage(config, persistent)
  await populate(storage)
  storage.promote(user.username, 'owner@example.test', session)
  const valid = storage.saved()
  for (const value of [{ ...valid, clientId: 'other' }, { ...valid, version: 3 }, { ...valid, accessToken: 'must-not-persist' }, { ...valid, randomPasswordKey: '' }]) {
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

test('terminal restart removes only SDK transactions, immediately and after late challenge writes', async () => {
  const f = nativeFixture()
  f.transactions.setItem('unrelated-tab-data', 'keep')
  const pending = deferred(), started = deferred()
  f.sdk.signIn = async () => { started.resolve(); await pending.promise; f.transactions.setItem('CognitoSignInState.signInSession', 'late-transaction'); return { isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } } }
  const signingIn = f.auth.signIn('owner@example.test', 'synthetic-password')
  await started.promise
  f.transactions.setItem('CognitoSignInState.signInSession', 'transaction')
  f.auth.restart()
  assert.equal(f.transactions.getItem('CognitoSignInState.signInSession'), null)
  assert.equal(f.transactions.getItem('unrelated-tab-data'), 'keep')
  pending.resolve()
  await assert.rejects(signingIn, error => error.terminal)
  assert.equal(f.transactions.getItem('CognitoSignInState.signInSession'), null)
  assert.equal(f.transactions.getItem('unrelated-tab-data'), 'keep')
  assert.deepEqual(f.state.navigations, [config.origin + '/'])
})

test('logout immediately seals memory, starts current refresh-family revocation and goes to public homepage', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  await f.auth.trust(user, session)
  assert.ok(f.transactions.getItem(f.storage.sessionKey))
  await f.auth.signOut()
  assert.equal(await f.storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.equal(JSON.parse(f.state.requests[0].options.body).Token, 'synthetic-refresh')
  assert.equal(f.state.requests[0].options.keepalive, true)
  assert.equal(f.state.requests[0].url, 'https://cognito-idp.us-east-1.amazonaws.com')
  assert.equal(f.persistent.length, 1)
  assert.equal(f.transactions.length, 0)
  assert.equal(f.transactions.getItem(f.storage.sessionKey), null)
  assert.deepEqual(f.state.navigations, ['https://www.frankmanu.com/'])
})

test('terminal storage failure cannot prevent local logout or public-homepage navigation', async () => {
  const f = nativeFixture()
  await f.auth.signIn('owner@example.test', 'synthetic-password')
  f.transactions.removeItem = () => { throw new Error('Storage disabled') }
  await f.auth.signOut()
  assert.equal(await f.storage.getItem(`${prefix}${user.username}.accessToken`), null)
  assert.deepEqual(f.state.navigations, ['https://www.frankmanu.com/'])
})

test('standard tokens can trust a confirmed device; existing proof is not re-remembered', async () => {
  const f = nativeFixture()
  const signedIn = await f.auth.signIn('owner@example.test', 'synthetic-password')
  await f.auth.trust(signedIn.user, session)
  const original = f.persistent.getItem(f.storage.recordKey)
  await f.auth.trust(await f.auth.refresh(), session)
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

test('only backend session authorization can promote trust or open private data', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  f.setTransport(async () => { started.resolve(); return pending.promise })
  const starting = f.start(true)
  await started.promise
  assert.equal(f.client.getSnapshot().status, 'verifying')
  assert.equal(f.state.trusts, 0)
  pending.resolve(response({ error: { code: 'DEVICE_REVOKED', message: 'private-details' } }, 403))
  await starting
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.state.trusts, 0)
  assert.equal(f.client.getSnapshot().session, null)
  assert.ok(!JSON.stringify(f.client.getSnapshot()).includes('private-details'))
})

test('standard app-user tokens open private data and allow opt-in trust', async t => {
  const f = fixture(t)
  await f.start(true)
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.state.trusts, 1)
  assert.equal(f.client.getSnapshot().session.owner.sub, user.sub)
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
  pending.resolve({ ...user, accessToken: 'rotated-access', expiresAt: 1550 })
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

test('late sign-in success cannot restore a signed-out session or call owner API', async t => {
  const f = fixture(t), pending = deferred(), started = deferred()
  f.setSignIn(async () => { started.resolve(); return pending.promise })
  const signingIn = f.start(true)
  await started.promise
  await f.client.signOut()
  pending.resolve({ kind: 'done', user })
  await signingIn
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.state.trusts, 0)
  assert.equal(f.state.signOuts, 1)
})

test('device error codes clear local proof and private metadata; native Gateway errors fail closed', async t => {
  for (const code of ['DEVICE_NOT_FOUND', 'DEVICE_REVOKED', 'gateway401', 'gateway403']) {
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

test('device age does not expire trust locally; the memory session remains independently bounded', () => {
  const now = 10 * 365 * 86400
  const oldDevice = { ...device, createdAt: new Date(1000).toISOString() }
  const result = parseSession({ ...session, authenticatedAt: now - 10, expiresAt: now + 300, device: oldDevice }, user.sub, now, user.deviceKey)
  assert.equal(result.device.createdAt, oldDevice.createdAt)
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

test('startup without a tab session stays on ordinary idle login and skips the owner API', async t => {
  const f = fixture(t)
  await Promise.all([f.client.restore(), f.client.restore()])
  assert.equal(f.client.getSnapshot().status, 'login')
  assert.equal(f.client.getSnapshot().authBusy, false)
  assert.equal(f.client.getSnapshot().flow.kind, 'credentials')
  assert.equal(f.state.restores, 1)
  assert.equal(f.state.signIns, 0)
  assert.equal(f.state.requests.length, 0)
})

test('reload keeps the login card busy and opens no private UI until the backend reauthorizes the actual SDK user', async t => {
  const f = fixture(t), sdkPending = deferred(), backendPending = deferred(), backendStarted = deferred()
  f.setRestore(() => sdkPending.promise)
  f.setTransport(async () => { backendStarted.resolve(); return backendPending.promise })
  const restoring = f.client.restore()
  assert.equal(f.client.getSnapshot().status, 'login')
  assert.equal(f.client.getSnapshot().authBusy, true)
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.state.requests.length, 0)
  sdkPending.resolve({ ...user })
  await backendStarted.promise
  assert.equal(f.client.getSnapshot().status, 'verifying')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  assert.equal(f.state.trusts, 0)
  assert.equal(f.state.signIns, 0)
  backendPending.resolve(response(session))
  await restoring
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.client.getSnapshot().session.owner.sub, user.sub)
  assert.equal(f.client.getSnapshot().deviceTrusted, false)
  assert.equal(f.state.requests.length, 1)
  assert.equal(f.state.requests[0].url, config.apiUrl + '/v1/session')
  assert.equal(f.state.requests[0].options.headers.Authorization, 'Bearer ' + user.accessToken)
  await f.client.restore()
  assert.equal(f.state.restores, 1)
  assert.equal(f.state.requests.length, 1)
})

test('restoration validates client, issuer, identity, device, expiry, and authentication ceiling before owner requests', async t => {
  for (const invalid of [
    { ...user, sub: '' },
    { ...user, clientId: 'wrong-client' }, { ...user, issuer: 'https://wrong-pool.example.test' },
    { ...user, deviceKey: '' }, { ...user, username: '' }, { ...user, authTime: 1061 },
    { ...user, expiresAt: 1000 },
  ]) {
    const f = fixture(t)
    f.setRestore(async () => invalid)
    await f.client.restore()
    assert.equal(f.client.getSnapshot().status, 'expired')
    assert.equal(f.client.getSnapshot().session, null)
    assert.equal(f.state.requests.length, 0)
    assert.equal(f.state.trusts, 0)
  }
  const f = fixture(t)
  f.state.now = user.authTime + 8 * 3600
  f.setRestore(async () => ({ ...user, expiresAt: f.state.now + 300 }))
  await f.client.restore()
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.state.requests.length, 0)
})

test('restored sessions still obey owner/device revocation and owner-sub binding on the backend', async t => {
  for (const [result, expectedStatus] of [
    [response({ error: { code: 'DEVICE_REVOKED' } }, 403), 'expired'],
    [response({ ...session, owner: { sub: 'not-the-owner' } }), 'unavailable'],
    [response({ ...session, device: { ...device, key: 'wrong-device' } }), 'unavailable'],
    [response({ ...session, authenticatedAt: user.authTime + 1 }), 'expired'],
  ]) {
    const f = fixture(t)
    f.setRestore(async () => user)
    f.setTransport(async () => result)
    await f.client.restore()
    assert.equal(f.client.getSnapshot().status, expectedStatus)
    assert.equal(f.client.getSnapshot().session, null)
    assert.equal(f.client.getSnapshot().resume, null)
    assert.equal(f.state.trusts, 0)
  }
})

test('an edited tab expiry cannot extend actual token auth_time and invalid SDK sessions discard the checkpoint', async t => {
  for (const invalid of ['eight-hour', 'id-token', 'missing-device']) {
    const original = nativeFixture()
    await original.auth.signIn('owner@example.test', 'synthetic-password')
    let now = 1000
    if (invalid === 'eight-hour') {
      now = user.authTime + 8 * 3600
      const record = JSON.parse(original.transactions.getItem(original.storage.sessionKey))
      record.authTime = now
      record.expiresAt = now + 8 * 3600
      original.transactions.setItem(original.storage.sessionKey, JSON.stringify(record))
    }
    original.auth.clear(false, true)
    const reloaded = nativeFixture({ transactions: original.transactions, now: () => now })
    if (invalid === 'eight-hour') reloaded.state.owner.expiresAt = now + 300
    else reloaded.sdk.fetchAuthSession = async () => ({ tokens: { accessToken: { payload: { token_use: invalid === 'id-token' ? 'id' : 'access', username: user.username, auth_time: user.authTime }, toString: () => user.accessToken } } })
    const client = new OwnerSessionClient(config, reloaded.auth, async () => { assert.fail('Invalid restored SDK state must not reach owner data') }, () => now)
    t.after(() => client.clear('expired'))
    await client.restore()
    assert.equal(client.getSnapshot().status, 'expired')
    assert.equal(client.getSnapshot().session, null)
    assert.equal(original.transactions.getItem(original.storage.sessionKey), null)
  }
})

test('late SDK restoration or owner confirmation cannot reopen a suspended or logged-out page', async t => {
  for (const phase of ['sdk', 'backend']) {
    for (const terminal of ['logout', 'pagehide']) {
      const f = fixture(t), pending = deferred(), started = deferred()
      if (phase === 'sdk') f.setRestore(async () => { started.resolve(); return pending.promise })
      else {
        f.setRestore(async () => user)
        f.setTransport(async () => { started.resolve(); return pending.promise })
      }
      const restoring = f.client.restore()
      await started.promise
      if (terminal === 'logout') await f.client.signOut()
      else f.client.suspend()
      pending.resolve(phase === 'sdk' ? user : response(session))
      await restoring
      assert.equal(f.client.getSnapshot().status, terminal === 'logout' ? 'signing-out' : 'expired')
      assert.equal(f.client.getSnapshot().session, null)
      assert.equal(f.client.getSnapshot().resume, null)
      assert.equal(f.state.preserveCheckpoint, terminal === 'pagehide')
      assert.equal(f.state.requests.length, phase === 'sdk' ? 0 : 1)
    }
  }
})

test('pagehide seals private in-memory state while retaining a reload checkpoint; BFCache never reopens old metadata', async t => {
  const f = fixture(t)
  f.setRestore(async () => user)
  await f.client.restore()
  await f.client.loadResume()
  f.client.suspend()
  assert.equal(f.state.preserveCheckpoint, true)
  assert.equal(f.client.getSnapshot().status, 'expired')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  const requests = f.state.requests.length
  await f.client.checkSession()
  await f.client.restore()
  assert.equal(f.state.requests.length, requests)
  assert.equal(f.state.restores, 1)
  await f.client.signOut()
  assert.equal(f.state.preserveCheckpoint, false)
})

test('backend unavailability during restoration hides data and retry reauthorizes before private UI', async t => {
  const f = fixture(t)
  f.setRestore(async () => user)
  f.setTransport(async () => response({ error: { code: 'UNAVAILABLE' } }, 503))
  await f.client.restore()
  assert.equal(f.client.getSnapshot().status, 'unavailable')
  assert.equal(f.client.getSnapshot().session, null)
  assert.equal(f.client.getSnapshot().resume, null)
  f.setTransport(async () => response(session))
  await f.client.checkSession()
  assert.equal(f.client.getSnapshot().status, 'authenticated')
  assert.equal(f.state.signIns, 0)
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
    { ...session, device: { ...device, createdAt: new Date((1000 + 61) * 1000).toISOString() } },
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
