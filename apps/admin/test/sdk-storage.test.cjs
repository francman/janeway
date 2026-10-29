const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createRequire } = require('node:module')
const { Amplify } = require('aws-amplify')
const { fetchAuthSession } = require('aws-amplify/auth')
const { cognitoUserPoolsTokenProvider } = require('aws-amplify/auth/cognito')

// Exercise the pinned SDK's real rotating-refresh/token-store path. Only the
// Cognito network response is synthetic; no private SDK imports or monkeypatches.
const filename = path.resolve(__dirname, '../src/lib/device-storage.ts')
const moduleValue = { exports: {} }
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
new vm.Script(code, { filename }).runInContext(vm.createContext({ module: moduleValue, exports: moduleValue.exports, TextEncoder }))
const { DeviceStorage } = moduleValue.exports
const authFilename = path.resolve(__dirname, '../src/lib/auth.ts')
const authModule = { exports: {} }
const authRequire = createRequire(authFilename)
const authCode = ts.transpileModule(fs.readFileSync(authFilename, 'utf8'), { fileName: authFilename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
new vm.Script(authCode, { filename: authFilename }).runInContext(vm.createContext({
  module: authModule, exports: authModule.exports, URL, setTimeout, clearTimeout,
  require: name => name === './device-storage' ? moduleValue.exports : authRequire(name),
}))
const { NativeAuth } = authModule.exports
const config = {
  poolId: 'us-east-1_fixture', clientId: 'fixtureclient', loginId: 'owner@example.test',
  authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', origin: 'https://admin.example.test',
}
const prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
const username = 'canonical-owner'
const jwt = claims => `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`
const claims = (authTime, expiresAt) => ({
  sub: 'owner-sub', username, token_use: 'access', exp: expiresAt, iat: expiresAt - 300, auth_time: authTime,
  iss: config.authority, client_id: config.clientId, scope: 'aws.cognito.signin.user.admin',
  device_key: 'us-east-1_device',
})
class Storage {
  values = new Map()
  get length() { return this.values.size }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
  key(index) { return [...this.values.keys()][index] ?? null }
  clear() { this.values.clear() }
}
function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function seed(storage, now) {
  const accessToken = jwt({ ...claims(now, now + 300), origin_jti: 'refresh-family' })
  await storage.setItem(prefix + 'LastAuthUser', username)
  for (const [key, value] of Object.entries({ accessToken, refreshToken: 'old-refresh', deviceKey: 'us-east-1_device', deviceGroupKey: 'group', randomPasswordKey: 'random-device-secret', clockDrift: '0' })) {
    await storage.setItem(`${prefix}${username}.${key}`, value)
  }
}

test('public Amplify refresh sends stored DeviceKey, rotates tokens in memory and preserves device metadata', async t => {
  const storage = new DeviceStorage(config, null)
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(storage)
  const now = Math.floor(Date.now() / 1000)
  await seed(storage, now)
  let calls = 0
  const next = jwt(claims(now, now + 300))
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(new URL(String(url)).origin, 'https://cognito-idp.us-east-1.amazonaws.com')
    assert.equal(options.headers['x-amz-target'] ?? options.headers['X-Amz-Target'] ?? new Headers(options.headers).get('x-amz-target'), 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken')
    const body = JSON.parse(options.body)
    assert.equal(body.DeviceKey, 'us-east-1_device')
    assert.equal(body.RefreshToken, 'old-refresh')
    return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: next, RefreshToken: 'new-refresh', ExpiresIn: 300, TokenType: 'Bearer' } }), { status: 200, headers: { 'Content-Type': 'application/x-amz-json-1.1' } })
  })
  const result = await fetchAuthSession({ forceRefresh: true })
  assert.equal(result.tokens.accessToken.toString(), next)
  assert.equal(calls, 1)
  assert.equal(await storage.getItem(`${prefix}${username}.refreshToken`), 'new-refresh')
  assert.equal(await storage.getItem(`${prefix}${username}.deviceKey`), 'us-east-1_device')
  assert.equal(await storage.getItem(`${prefix}${username}.randomPasswordKey`), 'random-device-secret')
  storage.seal()
})

test('real SDK in-flight token writes after sealing cannot repopulate the store', async t => {
  const storage = new DeviceStorage(config, null)
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(storage)
  const now = Math.floor(Date.now() / 1000)
  await seed(storage, now)
  const started = deferred(), pending = deferred()
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return pending.promise })
  const refreshing = fetchAuthSession({ forceRefresh: true })
  await started.promise
  storage.seal(true)
  assert.equal(storage.takeRevocationToken(), 'old-refresh')
  pending.resolve(new Response(JSON.stringify({ AuthenticationResult: { AccessToken: jwt(claims(now, now + 300)), RefreshToken: 'late-rotated-refresh', ExpiresIn: 300, TokenType: 'Bearer' } }), { status: 200, headers: { 'Content-Type': 'application/x-amz-json-1.1' } }))
  await refreshing
  // DefaultTokenStore re-reads LastAuthUser between awaited writes. It can write
  // under its fallback username after sealing, but that still hits THIS store.
  assert.equal(await storage.getItem(prefix + 'LastAuthUser'), null)
  for (const name of [username, 'username']) {
    assert.equal(await storage.getItem(`${prefix}${name}.accessToken`), null)
    assert.equal(await storage.getItem(`${prefix}${name}.refreshToken`), null)
  }
  assert.equal(storage.takeRevocationToken(), null)
  const current = await fetchAuthSession()
  assert.equal(current.tokens, undefined)
})

test('public NativeAuth restores a reloaded tab through Amplify, rotating expired access while retaining the original eight-hour ceiling', async t => {
  const tab = new Storage(), persistent = new Storage()
  const now = Math.floor(Date.now() / 1000), authTime = now - 600
  const previous = new DeviceStorage(config, persistent, tab, () => now)
  await seed(previous, authTime)
  previous.checkpoint(authTime)
  const before = tab.getItem(previous.sessionKey)
  previous.seal(false, true)
  assert.equal(tab.getItem(previous.sessionKey), before)
  const reloaded = new DeviceStorage(config, persistent, tab, () => now)
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(reloaded)
  let calls = 0
  let revocation
  const next = jwt(claims(authTime, now + 300))
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    const body = JSON.parse(options.body)
    assert.equal(body.RefreshToken, 'old-refresh')
    assert.equal(body.DeviceKey, 'us-east-1_device')
    assert.equal(body.ClientId, config.clientId)
    assert.equal(new Headers(options.headers).get('x-amz-target'), 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken')
    // In-flight SDK access writes must not replace the settled checkpoint.
    assert.equal(tab.getItem(reloaded.sessionKey), before)
    return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: next, RefreshToken: 'reloaded-rotated-refresh', ExpiresIn: 300, TokenType: 'Bearer' } }), { status: 200, headers: { 'Content-Type': 'application/x-amz-json-1.1' } })
  })
  const auth = new NativeAuth(config, reloaded, {
    transactions: tab, navigate: () => {},
    transport: async (_url, options) => { revocation = options; return new Response('{}', { status: 200 }) },
  })
  t.after(() => auth.clear())
  const restored = await auth.restore()
  assert.equal(restored.accessToken, next)
  assert.equal(restored.authTime, authTime)
  assert.equal(restored.deviceKey, 'us-east-1_device')
  assert.equal(calls, 1)
  const checkpoint = JSON.parse(tab.getItem(reloaded.sessionKey))
  assert.equal(checkpoint.expiresAt, authTime + 8 * 3600)
  assert.equal(checkpoint.values[`${prefix}${username}.refreshToken`], 'reloaded-rotated-refresh')
  assert.equal(checkpoint.values[`${prefix}${username}.randomPasswordKey`], 'random-device-secret')
  assert.equal(persistent.length, 0)
  await auth.signOut()
  assert.equal(tab.getItem(reloaded.sessionKey), null)
  assert.equal(await reloaded.getItem(prefix + 'LastAuthUser'), null)
  assert.equal(JSON.parse(revocation.body).Token, 'reloaded-rotated-refresh')
  assert.equal(revocation.keepalive, true)
})

test('real SDK refresh completing after pagehide keeps the old tab checkpoint and never repopulates sealed memory', async t => {
  const tab = new Storage()
  const now = Math.floor(Date.now() / 1000)
  const storage = new DeviceStorage(config, null, tab, () => now)
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(storage)
  await seed(storage, now)
  storage.checkpoint(now)
  const before = tab.getItem(storage.sessionKey)
  const started = deferred(), pending = deferred()
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return pending.promise })
  const auth = new NativeAuth(config, storage, { transactions: tab, navigate: () => {}, transport: fetch })
  const refreshing = auth.refresh()
  await started.promise
  auth.clear(false, true)
  assert.equal(tab.getItem(storage.sessionKey), before)
  pending.resolve(new Response(JSON.stringify({ AuthenticationResult: { AccessToken: jwt(claims(now, now + 300)), RefreshToken: 'late-rotated-refresh', ExpiresIn: 300, TokenType: 'Bearer' } }), { status: 200, headers: { 'Content-Type': 'application/x-amz-json-1.1' } }))
  await assert.rejects(refreshing, error => error.code === 'cancelled' && error.terminal)
  assert.equal(tab.getItem(storage.sessionKey), before)
  assert.equal(await storage.getItem(prefix + 'LastAuthUser'), null)
  assert.equal(await storage.getItem(`${prefix}${username}.refreshToken`), null)
  auth.clear()
  assert.equal(tab.getItem(storage.sessionKey), null)
})

test('public SDK restoration at the exact eight-hour boundary discards the tab checkpoint without refreshing', async t => {
  const tab = new Storage()
  const now = Math.floor(Date.now() / 1000)
  const original = new DeviceStorage(config, null, tab, () => now)
  await seed(original, now)
  original.checkpoint(now)
  original.seal(false, true)
  const boundary = new DeviceStorage(config, null, tab, () => now + 8 * 3600)
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(boundary)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('An expired checkpoint must never refresh'))
  const auth = new NativeAuth(config, boundary, { transactions: tab, navigate: () => {}, transport: fetch })
  assert.equal(await auth.restore(), null)
  assert.equal(tab.getItem(boundary.sessionKey), null)
  assert.equal((await fetchAuthSession()).tokens, undefined)
  auth.clear()
})
