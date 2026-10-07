const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { format } = require('node:util')
const ts = require('typescript')
const { NextRequest } = require('next/server')

const root = path.resolve(__dirname, '..')
const ttl = 5 * 60 * 1000

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  let now = 0
  let send = async () => ({ Parameter: { Value: 'synthetic-original' } })
  const state = { requests: 0, warnings: [], invalidations: [] }
  let secretModule
  function load(relative) {
    const filename = path.join(root, relative)
    const sourceRequire = createRequire(filename)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const module = { exports: {} }
    const context = vm.createContext({
      module, exports: module.exports,
      process: { env: { AWS_REGION: 'us-east-1', REVALIDATE_SECRET_PARAM: '/fixture/revalidate-secret' } },
      performance: { now: () => now },
      console: { warn: (...args) => state.warnings.push(args) },
      require(name) {
        if (name === '@aws-sdk/client-ssm') return {
          SSMClient: class { send() { state.requests++; return send() } },
          GetParameterCommand: class { constructor(input) { this.input = input } },
        }
        if (name === '@/lib/revalidate-secret') return secretModule
        if (name === 'next/cache') return { revalidateTag: tag => state.invalidations.push(tag) }
        return sourceRequire(name)
      },
    })
    new vm.Script(code, { filename }).runInContext(context)
    return module.exports
  }
  secretModule = load('src/lib/revalidate-secret.ts')
  const route = load('src/app/api/revalidate/route.ts')
  return {
    state,
    get: secretModule.getRevalidateSecret,
    setTime(value) { now = value },
    setTransport(value) { send = value },
    async authorize(secret) {
      const response = await route.POST(new NextRequest('https://fixture.invalid/api/revalidate?slug=fixture-article', {
        method: 'POST', headers: { Authorization: `Bearer ${secret}` },
      }))
      return { status: response.status, body: await response.text() }
    },
  }
}

test('a failed lookup is not permanent and error payloads are not logged', async () => {
  const f = fixture()
  const sensitive = 'synthetic-value-that-must-not-be-logged'
  f.setTransport(async () => { throw new Error(sensitive) })
  assert.equal(await f.get(), null)
  f.setTransport(async () => ({ Parameter: { Value: 'synthetic-recovered' } }))
  assert.equal(await f.get(), 'synthetic-recovered')
  assert.equal(await f.get(), 'synthetic-recovered')
  assert.equal(f.state.requests, 2)
  assert.ok(!f.state.warnings.map(args => format(...args)).join('\n').includes(sensitive))
})

for (const [label, response] of [
  ['missing Parameter', {}],
  ['missing Value', { Parameter: {} }],
  ['empty Value', { Parameter: { Value: '' } }],
]) {
  test(`${label} fails closed but a later lookup can recover`, async () => {
    const f = fixture()
    f.setTransport(async () => response)
    assert.equal(await f.get(), null)
    f.setTransport(async () => ({ Parameter: { Value: 'synthetic-recovered' } }))
    assert.equal(await f.get(), 'synthetic-recovered')
    assert.equal(f.state.requests, 2)
  })
}

test('concurrent callers share a lookup and successful TTL starts when it completes', async () => {
  const f = fixture()
  const pending = deferred()
  f.setTransport(() => pending.promise)
  const callers = Array.from({ length: 12 }, () => f.get())
  assert.equal(f.state.requests, 1)
  f.setTime(2 * ttl)
  pending.resolve({ Parameter: { Value: 'synthetic-completed' } })
  assert.deepEqual(await Promise.all(callers), Array(12).fill('synthetic-completed'))
  f.setTransport(async () => ({ Parameter: { Value: 'synthetic-next' } }))
  f.setTime(3 * ttl - 1)
  assert.equal(await f.get(), 'synthetic-completed')
  assert.equal(f.state.requests, 1)
  f.setTime(3 * ttl)
  assert.equal(await f.get(), 'synthetic-next')
  assert.equal(f.state.requests, 2)
})

test('a shared failed lookup clears for the next concurrent recovery attempt', async () => {
  const f = fixture()
  const failed = deferred()
  f.setTransport(() => failed.promise)
  const first = Array.from({ length: 8 }, () => f.get())
  failed.reject(new Error('Synthetic SSM outage'))
  assert.deepEqual(await Promise.all(first), Array(8).fill(null))
  assert.equal(f.state.requests, 1)
  const recovery = deferred()
  f.setTransport(() => recovery.promise)
  const second = Array.from({ length: 8 }, () => f.get())
  assert.equal(f.state.requests, 2)
  recovery.resolve({ Parameter: { Value: 'synthetic-recovered' } })
  assert.deepEqual(await Promise.all(second), Array(8).fill('synthetic-recovered'))
})

test('the endpoint accepts the rotated secret at expiry and rejects the old one', async () => {
  const f = fixture()
  assert.equal((await f.authorize('synthetic-original')).status, 200)
  f.setTransport(async () => ({ Parameter: { Value: 'synthetic-rotated' } }))
  f.setTime(ttl - 1)
  assert.equal((await f.authorize('synthetic-original')).status, 200)
  assert.equal((await f.authorize('synthetic-rotated')).status, 401)
  assert.equal(f.state.requests, 1)
  f.setTime(ttl)
  const rotated = await f.authorize('synthetic-rotated')
  assert.equal(rotated.status, 200)
  const old = await f.authorize('synthetic-original')
  assert.equal(old.status, 401)
  assert.equal(f.state.requests, 2)
  assert.ok(!rotated.body.includes('synthetic-rotated'))
  assert.ok(!old.body.includes('synthetic-original'))
})

test('an expired refresh failure cannot authorize with the stale secret and later requests recover', async () => {
  const f = fixture()
  assert.equal((await f.authorize('synthetic-original')).status, 200)
  f.state.invalidations.length = 0
  f.setTime(ttl)
  f.setTransport(async () => { throw new Error('Synthetic outage') })
  assert.equal((await f.authorize('synthetic-original')).status, 401)
  assert.deepEqual(f.state.invalidations, [])
  f.setTransport(async () => ({ Parameter: { Value: 'synthetic-rotated' } }))
  assert.equal((await f.authorize('synthetic-rotated')).status, 200)
  assert.equal((await f.authorize('synthetic-original')).status, 401)
  assert.equal(f.state.requests, 3)
})

test('a request during expired-cache refresh waits instead of using stale authorization', async () => {
  const f = fixture()
  assert.equal((await f.authorize('synthetic-original')).status, 200)
  f.setTime(ttl)
  const refresh = deferred()
  f.setTransport(() => refresh.promise)
  let finished = false
  const stale = f.authorize('synthetic-original').then(result => { finished = true; return result })
  const current = f.authorize('synthetic-rotated')
  await new Promise(setImmediate)
  assert.equal(finished, false)
  assert.equal(f.state.requests, 2)
  refresh.resolve({ Parameter: { Value: 'synthetic-rotated' } })
  assert.equal((await stale).status, 401)
  assert.equal((await current).status, 200)
})
