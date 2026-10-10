const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { Amplify } = require('aws-amplify')
const { fetchAuthSession } = require('aws-amplify/auth')
const { cognitoUserPoolsTokenProvider } = require('aws-amplify/auth/cognito')

// Exercise the pinned SDK's real rotating-refresh/token-store path. Only the
// Cognito network response is synthetic; no private SDK imports or monkeypatches.
const filename = path.resolve(__dirname, '../src/lib/device-storage.ts')
const moduleValue = { exports: {} }
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
new vm.Script(code, { filename }).runInContext(vm.createContext({ module: moduleValue, exports: moduleValue.exports }))
const { DeviceStorage } = moduleValue.exports
const config = { poolId: 'us-east-1_fixture', clientId: 'fixtureclient' }
const prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
const username = 'canonical-owner'
const jwt = claims => `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`
function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function seed(storage, now) {
  const accessToken = jwt({ sub: 'owner-sub', username, token_use: 'access', exp: now + 300, iat: now, auth_time: now, origin_jti: 'refresh-family' })
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
  const next = jwt({ sub: 'owner-sub', username, token_use: 'access', exp: now + 300, iat: now, auth_time: now })
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
  pending.resolve(new Response(JSON.stringify({ AuthenticationResult: { AccessToken: jwt({ sub: 'owner-sub', username, token_use: 'access', exp: now + 300, iat: now, auth_time: now }), RefreshToken: 'late-rotated-refresh', ExpiresIn: 300, TokenType: 'Bearer' } }), { status: 200, headers: { 'Content-Type': 'application/x-amz-json-1.1' } }))
  await refreshing
  // DefaultTokenStore re-reads LastAuthUser between awaited writes. It can write
  // under its fallback username after sealing, but that still hits THIS store.
  assert.equal(await storage.getItem(prefix + 'LastAuthUser'), null)
  for (const name of [username, 'username']) {
    assert.equal(await storage.getItem(`${prefix}${name}.accessToken`), null)
    assert.equal(await storage.getItem(`${prefix}${name}.refreshToken`), null)
  }
  assert.equal(storage.takeRevocationToken(), 'late-rotated-refresh')
  const current = await fetchAuthSession()
  assert.equal(current.tokens, undefined)
})
