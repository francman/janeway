const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')
const { startContentStore } = require('./helpers/content-store.cjs')

const root = path.resolve(__dirname, '..')
const pointerKey = 'documents/resume/current.json'
const origin = 'https://resume-fixture.invalid'
const secret = 'private-pointer-error-sentinel'

function pointer(overrides = {}) {
  const sha256 = 'a'.repeat(64)
  return {
    schemaVersion: 1,
    publicationId: '11111111-1111-4111-8111-111111111111',
    key: `documents/resume/revisions/${sha256}/inline/frank-manu-resume.pdf`,
    sha256,
    bytes: 12345,
    publishedAt: '2026-10-09T12:34:56.000Z',
    ...overrides,
  }
}

async function withRoute(run, environment = {}) {
  const store = await startContentStore()
  const originalEnvironment = { ...process.env }
  try {
    Object.assign(process.env, store.env, { ARTICLES_IMAGE_CDN_URL: origin })
    delete process.env.AWS_PROFILE
    delete process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const modules = new Map()
    function load(relative) {
      if (modules.has(relative)) return modules.get(relative).exports
      const filename = path.join(root, relative)
      const sourceRequire = createRequire(filename)
      const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText
      const module = { exports: {} }
      modules.set(relative, module)
      const context = vm.createContext({
        module, exports: module.exports, process, console, Buffer, URL, TextDecoder, TextEncoder,
        Request, Response, Headers, AbortController, Uint8Array,
        require(name) {
          if (name === '@/lib/resume') return load('src/lib/resume.ts')
          return sourceRequire(name)
        },
      })
      new vm.Script(code, { filename }).runInContext(context)
      return module.exports
    }
    const route = load('src/app/resume.pdf/route.ts')
    await run({ store, route, publish(value) {
      store.seedObject(pointerKey, typeof value === 'string' ? value : JSON.stringify(value), {
        contentType: 'application/json',
      })
    } })
    assert.deepEqual(store.state.errors, [])
  } finally {
    try {
      await store.close()
    } finally {
      for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(originalEnvironment, name)) delete process.env[name]
      }
      Object.assign(process.env, originalEnvironment)
    }
  }
}

async function unavailable(response, forbidden = []) {
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('location'), null)
  const body = await response.text()
  for (const value of [secret, pointerKey, pointer().key, pointer().sha256,
    'NoSuchKey', 'InternalError', 'AccessDenied', 'fixture-access-key', ...forbidden]) {
    assert.ok(!body.includes(value), `Response leaked ${value}`)
  }
}

function redirected(response, value, expectedOrigin = origin) {
  assert.equal(response.status, 307)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('location'), `${expectedOrigin}/${value.key}`)
}

test('resume GET observes A to B immediately and ignores caller redirect input', async () => {
  await withRoute(async ({ route, publish }) => {
    const first = pointer()
    const sha256 = 'b'.repeat(64)
    const second = pointer({ sha256, key: `documents/resume/revisions/${sha256}/inline/frank-manu-resume.pdf`,
      publicationId: '22222222-2222-7222-b222-222222222222', publishedAt: '2024-02-29T23:59:59Z' })
    for (const current of [first, second, first]) {
      publish(current)
      redirected(await route.GET(new Request('https://site.invalid/resume.pdf?url=https://attacker.invalid/evil.pdf&key=evil', {
        method: 'GET', headers: { 'if-none-match': 'caller-etag', 'if-modified-since': 'Fri, 09 Oct 2026 12:34:56 GMT' },
      })), current)
    }
  })
})

test('missing, unavailable and malformed pointers fail closed and recover in the same module', async () => {
  await withRoute(async ({ store, route, publish }) => {
    await unavailable(await route.GET())
    publish(pointer())
    redirected(await route.GET(), pointer())
    for (const failure of [
      { status: 403, code: 'AccessDenied', message: secret },
      { status: 500, code: 'InternalError', message: secret },
    ]) {
      store.failRead(pointerKey, failure)
      await unavailable(await route.GET())
      redirected(await route.GET(), pointer())
    }
    for (const body of ['', '{', `{"secret":"${secret}"`, 'null', '[]', 'true', '42', '"https://attacker.invalid"']) {
      publish(body)
      await unavailable(await route.GET())
      publish(pointer())
      redirected(await route.GET(), pointer())
    }
    store.state.objects.delete(pointerKey)
    await unavailable(await route.GET())
    publish(pointer())
    redirected(await route.GET(), pointer())
  })
})

test('schema, immutable path, hash, UUID, byte count and UTC calendar validation fail closed', async () => {
  const invalid = [
    ['unknown field', pointer({ secret })],
    ['schema version', pointer({ schemaVersion: 2 })],
    ['schema version type', pointer({ schemaVersion: '1' })],
    ['UUID shape', pointer({ publicationId: 'not-a-uuid' })],
    ['UUID variant', pointer({ publicationId: '11111111-1111-4111-7111-111111111111' })],
    ['UUID type', pointer({ publicationId: 1 })],
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '123', null].map(bytes => [`bytes ${bytes}`, pointer({ bytes })]),
    ...['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'b'.repeat(64), null].map(sha256 => [`hash ${sha256}`, pointer({ sha256 })]),
    ...[
      'documents/resume/frank-manu-resume.pdf',
      pointer().key.replace('/inline/', '/download/'),
      pointer().key.replace('/inline/', '/inline/../inline/'),
      pointer().key.replace('/inline/', '/inline/%2e%2e/inline/'),
      pointer().key.replace('/inline/', '/inline\\'),
      pointer().key.replace('frank-manu-resume.pdf', 'other.pdf'),
      `${pointer().key}?download=1`, `${pointer().key}#fragment`,
      `https://attacker.invalid/${pointer().key}`, `//attacker.invalid/${pointer().key}`,
      `/${pointer().key}`, `${pointer().key}\r\nLocation: https://attacker.invalid`, null,
    ].map(key => [`key ${key}`, pointer({ key })]),
    ...[
      '2026-02-29T12:34:56.000Z', '2024-02-30T12:34:56.000Z',
      '2026-04-31T12:34:56Z', '2026-13-01T12:34:56Z', '2026-00-01T12:34:56Z',
      '2026-10-09T24:00:00Z', '2026-10-09T12:60:00Z', '2026-10-09T12:34:60Z',
      '2026-10-09T12:34:56+00:00', '2026-10-09T12:34:56', '2026-10-09',
      '2026-10-09T12:34:56.1Z', '2026-10-09T12:34:56.1234Z', 'not-a-date', null,
    ].map(publishedAt => [`date ${publishedAt}`, pointer({ publishedAt })]),
  ]
  for (const field of Object.keys(pointer())) {
    const missing = pointer()
    delete missing[field]
    invalid.push([`missing ${field}`, missing])
  }
  await withRoute(async ({ route, publish }) => {
    for (const [label, value] of invalid) {
      publish(value)
      try {
        await unavailable(await route.GET())
        publish(pointer())
        redirected(await route.GET(), pointer())
      } catch (error) {
        error.message = `${label}: ${error.message}`
        throw error
      }
    }
  })
})

test('pointer byte limit accepts 4096 bytes but rejects oversized valid JSON without caching failure', async () => {
  await withRoute(async ({ route, publish }) => {
    const body = JSON.stringify(pointer())
    for (const size of [4096, 4097, 16384, 4096]) {
      publish(body.padEnd(size, ' '))
      const response = await route.GET()
      if (size === 4096) redirected(response, pointer())
      else await unavailable(response)
    }
  })
})

for (const [label, environment] of [
  ['missing bucket', { ARTICLES_BUCKET: undefined }],
  ['empty bucket', { ARTICLES_BUCKET: '' }],
  ['missing CDN', { ARTICLES_IMAGE_CDN_URL: undefined }],
  ...['', 'not a URL', 'http://resume-fixture.invalid', '//resume-fixture.invalid',
    'https://user:password@resume-fixture.invalid', 'https://user@resume-fixture.invalid',
    `${origin}/documents`, `${origin}/?target=https://attacker.invalid`, `${origin}/#fragment`,
    `${origin}/?`, `${origin}/#`, `${origin}/x/..`, `${origin}\\documents`,
    ` ${origin}`, `${origin}\n`,
    'https://', 'javascript:alert(1)',
  ].map(value => [`CDN ${value}`, { ARTICLES_IMAGE_CDN_URL: value }]),
]) {
  test(`invalid configuration (${label}) never redirects`, async () => {
    await withRoute(async ({ route, publish }) => {
      publish(pointer())
      await unavailable(await route.GET(), ['password', 'attacker.invalid'])
    }, environment)
  })
}

test('a trusted HTTPS origin with a root slash produces the same immutable redirect', async () => {
  await withRoute(async ({ route, publish }) => {
    const value = pointer({ publicationId: 'ABCDEFAB-1234-1234-9234-123456789ABC',
      publishedAt: '2024-02-29T00:00:00.123Z', bytes: Number.MAX_SAFE_INTEGER })
    publish(value)
    redirected(await route.GET(), value)
  }, { ARTICLES_IMAGE_CDN_URL: `${origin}/` })
})
