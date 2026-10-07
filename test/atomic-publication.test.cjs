const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { startContentStore } = require('./helpers/content-store.cjs')

const publisher = path.resolve(__dirname, '../scripts/publish-article.sh')
const slug = 'atomic-article'
const revisionPattern = /^articles\/atomic-article\/revisions\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/page\.mdx$/
const immutableCache = 'public,max-age=31536000,immutable'

function articleFiles(label, status = 'PUBLISHED') {
  return {
    'page.mdx': Buffer.from(`---\ntitle: ${label} title\ndescription: ${label} description\nauthor: Regression Author\ndate: 2026-01-15\nstatus: ${status}\ntags: [atomic, regression]\ncoverImage: cover.png\n---\n\n# ${label} complete body\n\nThe entire ${label} revision is indivisible.\n\n![Cover](cover.png)\n\n![Chart](images/chart.svg)\n\nEnd of ${label} body.\n`),
    'cover.png': Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]), Buffer.from(label)]),
    'images/chart.svg': Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><title>${label} chart</title><text x="0" y="15">${label}</text></svg>\n`),
  }
}

function mutations(store, since = 0) {
  return store.state.requests.slice(since).filter((request) => ['PutObject', 'PutItem'].includes(request.operation))
}

function uploads(store) {
  return store.state.requests.filter((request) => request.operation === 'PutObject')
}

function commits(store) {
  return store.state.requests.filter((request) => request.operation === 'PutItem')
}

function output(result) {
  return `exit=${result.code} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
}

function committedRecord(result) {
  assert.equal(result.code, 0, output(result))
  const finalLine = result.stdout.trim().split('\n').at(-1)
  let record
  try {
    record = JSON.parse(finalLine)
  } catch {
    assert.fail(`Missing final JSON commit record\n${output(result)}`)
  }
  assert.equal(record.committed, true)
  assert.equal(record.slug, slug)
  assert.match(record.s3Key, revisionPattern)
  return record
}

function assertFailed(result) {
  assert.notEqual(result.code, 0, output(result))
  assert.ok(result.code !== null || result.signal, output(result))
  assert.doesNotMatch(result.stdout, /"committed"\s*:\s*true/)
}

async function setup(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'janeway-atomic-'))
  const store = await startContentStore()
  const children = new Set()
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL')
    await store.close()
    await rm(cwd, { recursive: true, force: true })
    assert.deepEqual(store.state.errors, [], 'Fixture encountered an unsupported protocol request')
  })
  const configFile = path.join(cwd, 'empty-aws-config')
  const credentialsFile = path.join(cwd, 'empty-aws-credentials')
  await writeFile(configFile, '')
  await writeFile(credentialsFile, '')
  const env = {
    PATH: process.env.PATH,
    HOME: cwd,
    TMPDIR: cwd,
    LANG: 'C.UTF-8',
    ...store.env,
    AWS_CONFIG_FILE: configFile,
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    SITE_URL: '',
    REVALIDATE_SECRET: 'fixture-revalidation-secret',
  }

  async function fixture(label, status = 'PUBLISHED') {
    const directory = path.join(cwd, label, slug)
    const files = articleFiles(label, status)
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true })
      await writeFile(path.join(directory, name), body)
    }
    return { directory, files, label, status }
  }

  function publish(fixture, { expectedKey, revalidate = false } = {}) {
    const args = [publisher, fixture.directory]
    if (expectedKey !== undefined) args.push('--expected-key', expectedKey)
    const child = spawn('/bin/bash', args, {
      cwd,
      env: { ...env, SITE_URL: revalidate ? store.url : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        children.delete(child)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        children.delete(child)
        resolve({ code, signal, stdout, stderr })
      })
    })
  }

  const oldFiles = articleFiles('old')
  oldFiles['old-only.txt'] = Buffer.from('An asset retained only by the previous revision.\n')
  function seedOld() {
    const { 'page.mdx': body, ...assets } = oldFiles
    return store.seedArticle({
      slug,
      body,
      assets,
      item: {
        title: { S: 'old title' },
        description: { S: 'old description' },
        author: { S: 'Regression Author' },
        tags: { SS: ['atomic', 'regression'] },
        coverImage: { S: 'cover.png' },
        untouched: { M: { nested: { S: 'preserve every previous attribute on failure' } } },
      },
    })
  }

  async function assertRevision(s3Key, files) {
    assert.deepEqual(await store.readRevision(s3Key), files, `Complete revision mismatch: ${s3Key}`)
  }

  async function assertOld(old) {
    assert.deepEqual(store.state.items.get(slug), old.item)
    await assertRevision(old.s3Key, oldFiles)
  }

  return { store, fixture, publish, seedOld, assertOld, assertRevision, oldFiles }
}

function assertMetadata(item, fixture, s3Key) {
  assert.equal(item.slug.S, slug)
  assert.equal(item.s3Key.S, s3Key)
  assert.equal(item.title.S, `${fixture.label} title`)
  assert.equal(item.description.S, `${fixture.label} description`)
  assert.equal(item.author.S, 'Regression Author')
  assert.equal(item.publishedAt.S, '2026-01-15')
  assert.equal(item.status.S, fixture.status)
  assert.deepEqual(new Set(item.tags.SS), new Set(['atomic', 'regression']))
  assert.equal(item.coverImage.S, 'cover.png')
  assert.ok(Number.isFinite(Date.parse(item.updatedAt.S)), 'updatedAt must remain a valid timestamp')
}

function assertRevisionHeaders(store, s3Key, files) {
  const prefix = s3Key.slice(0, -'page.mdx'.length)
  for (const name of Object.keys(files)) {
    const object = store.state.objects.get(`${prefix}${name}`)
    if (/\.(png|svg)$/.test(name)) assert.equal(object.cacheControl, immutableCache)
    if (name === 'page.mdx') assert.equal(object.cacheControl, 'private, no-store')
  }
}

async function reachCommit(barrier, publishing) {
  const result = await Promise.race([
    barrier.reached.then((request) => ({ request })),
    publishing.then((processResult) => ({ processResult })),
  ])
  assert.ok(result.request, `Publisher exited before reaching commit\n${result.processResult ? output(result.processResult) : ''}`)
  return result.request
}

test('a new publication commits complete metadata and immutable MDX/assets only after staging', async (t) => {
  const context = await setup(t)
  const { store, fixture, publish, assertRevision } = context
  const next = await fixture('first')
  const barrier = store.pauseNextCommit()
  const publishing = publish(next, { expectedKey: 'absent' })
  try {
    const request = await reachCommit(barrier, publishing)
    const candidate = request.input.Item.s3Key.S
    assert.match(candidate, revisionPattern)
    assert.equal(store.state.items.has(slug), false, 'No metadata may become visible during staging')
    await assertRevision(candidate, next.files)
    assertRevisionHeaders(store, candidate, next.files)
    barrier.release()
    const record = committedRecord(await publishing)
    assert.equal(record.previousKey, null)
    assert.equal(record.s3Key, candidate)
    assert.equal(record.status, 'PUBLISHED')
    assertMetadata(store.state.items.get(slug), next, candidate)
    assert.equal(store.state.commits.length, 1)
    assert.equal(commits(store).length, 1)
  } finally {
    barrier.release()
  }
})

for (const [failedName, status] of [
  ['page.mdx', 'PUBLISHED'],
  ['cover.png', 'PUBLISHED'],
  ['cover.png', 'DRAFT'],
]) {
  test(`a failed ${status} ${failedName} upload preserves the full previous body, assets, and metadata`, async (t) => {
    const { store, fixture, publish, seedOld, assertOld } = await setup(t)
    const old = seedOld()
    const next = await fixture('failed-upload', status)
    store.failUpload(failedName)
    const result = await publish(next)
    assertFailed(result)
    await assertOld(old)
    assert.equal(commits(store).length, 0)
    const failed = uploads(store).filter((entry) => entry.outcome === 'error')
    assert.equal(failed.length, 1, 'A mutation failure must not be automatically retried')
    assert.equal(uploads(store).filter((entry) => entry.key.endsWith(`/${failedName}`)).length, 1)
    assert.ok(result.stderr.includes(old.s3Key), 'Failure must report the original expected key')
    const attemptedPrefix = failed[0].key.slice(0, -failedName.length)
    assert.ok(result.stderr.includes(attemptedPrefix), 'Failure must identify the staged revision prefix')
  })
}

for (const status of ['PUBLISHED', 'DRAFT']) {
  test(`a failed ${status} commit cannot change the previously published revision`, async (t) => {
    const { store, fixture, publish, seedOld, assertOld, assertRevision } = await setup(t)
    const old = seedOld()
    const next = await fixture(`failed-${status.toLowerCase()}`, status)
    store.failCommit()
    const result = await publish(next)
    assertFailed(result)
    await assertOld(old)
    assert.equal(store.state.commits.length, 0)
    assert.equal(commits(store).length, 1)
    const candidate = commits(store)[0].input.Item.s3Key.S
    assert.notEqual(candidate, old.s3Key)
    assert.match(candidate, revisionPattern)
    await assertRevision(candidate, next.files)
    assertRevisionHeaders(store, candidate, next.files)
    assert.ok(result.stderr.includes(old.s3Key))
    assert.ok(result.stderr.includes(candidate.slice(0, -'page.mdx'.length)))
  })
}

test('a conditional commit conflict is terminal and retains both complete revisions', async (t) => {
  const { store, fixture, publish, seedOld, assertOld, assertRevision } = await setup(t)
  const old = seedOld()
  const next = await fixture('conflicted')
  store.failCommit({ mode: 'conflict' })
  const result = await publish(next)
  assertFailed(result)
  await assertOld(old)
  assert.equal(commits(store).length, 1)
  assert.equal(commits(store)[0].outcome, 'conflict')
  await assertRevision(commits(store)[0].input.Item.s3Key.S, next.files)
})

test('successive publications leave stale revision body and image reads coherent', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const first = await fixture('first-success')
  const firstRecord = committedRecord(await publish(first))
  assert.equal(firstRecord.previousKey, old.s3Key)
  assertMetadata(store.state.items.get(slug), first, firstRecord.s3Key)
  assertRevisionHeaders(store, firstRecord.s3Key, first.files)
  const second = await fixture('second-success')
  const secondRecord = committedRecord(await publish(second))
  assert.equal(secondRecord.previousKey, firstRecord.s3Key)
  assert.notEqual(secondRecord.s3Key, firstRecord.s3Key)
  assertMetadata(store.state.items.get(slug), second, secondRecord.s3Key)
  assertRevisionHeaders(store, secondRecord.s3Key, second.files)
  await assertRevision(secondRecord.s3Key, second.files)
  await assertRevision(firstRecord.s3Key, first.files)
  await assertRevision(old.s3Key, oldFiles)
  assert.equal(store.state.commits.length, 2)
  assert.equal(commits(store).length, 2)
  assert.equal(uploads(store).some((entry) => entry.key.startsWith(old.prefix)), false)
})

for (const existing of [true, false]) {
  test(`overlapping publishers cannot overwrite the winning ${existing ? 'existing' : 'new'} article revision`, async (t) => {
    const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
    const old = existing ? seedOld() : null
    const loser = await fixture('overlap-loser')
    const winner = await fixture('overlap-winner')
    const barrier = store.pauseNextCommit()
    const losingPublish = publish(loser)
    try {
      const request = await reachCommit(barrier, losingPublish)
      const losingKey = request.input.Item.s3Key.S
      await assertRevision(losingKey, loser.files)
      if (old) {
        assert.deepEqual(store.state.items.get(slug), old.item)
        await assertRevision(old.s3Key, oldFiles)
      } else {
        assert.equal(store.state.items.has(slug), false)
      }
      const winnerRecord = committedRecord(await publish(winner))
      const winningItem = structuredClone(store.state.items.get(slug))
      assert.equal(winnerRecord.previousKey, old?.s3Key ?? null)
      barrier.release()
      const losingResult = await losingPublish
      assertFailed(losingResult)
      assert.deepEqual(store.state.items.get(slug), winningItem)
      assertMetadata(winningItem, winner, winnerRecord.s3Key)
      await assertRevision(winnerRecord.s3Key, winner.files)
      await assertRevision(losingKey, loser.files)
      if (old) await assertRevision(old.s3Key, oldFiles)
      assert.equal(store.state.commits.length, 1)
      assert.equal(commits(store).length, 2, 'Loser must not rebase and commit again')
      assert.equal(commits(store).filter((entry) => entry.outcome === 'conflict').length, 1)
    } finally {
      barrier.release()
    }
  })
}

test('an explicitly guarded retry stages a fresh revision when its original base is unchanged', async (t) => {
  const { store, fixture, publish, seedOld, assertOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const next = await fixture('guarded-retry')
  store.failUpload('page.mdx')
  assertFailed(await publish(next))
  await assertOld(old)
  const failedKeys = uploads(store).map((entry) => entry.key)
  const record = committedRecord(await publish(next, { expectedKey: old.s3Key }))
  assert.equal(record.previousKey, old.s3Key)
  assert.equal(failedKeys.some((key) => key.startsWith(record.s3Key.slice(0, -'page.mdx'.length))), false)
  assertMetadata(store.state.items.get(slug), next, record.s3Key)
  await assertRevision(record.s3Key, next.files)
  await assertRevision(old.s3Key, oldFiles)
  assert.equal(store.state.commits.length, 1)
})

test('an explicit original-base guard rejects a newer pointer before any upload', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const stale = await fixture('stale-retry')
  const winner = await fixture('guard-winner')
  const winnerRecord = committedRecord(await publish(winner))
  const winningItem = structuredClone(store.state.items.get(slug))
  const since = store.state.requests.length
  assertFailed(await publish(stale, { expectedKey: old.s3Key }))
  assert.deepEqual(mutations(store, since), [])
  assert.deepEqual(store.state.items.get(slug), winningItem)
  await assertRevision(winnerRecord.s3Key, winner.files)
  await assertRevision(old.s3Key, oldFiles)
})

test('an absent-base guard rejects an existing article without staging', async (t) => {
  const { store, fixture, publish, seedOld, assertOld } = await setup(t)
  const old = seedOld()
  const next = await fixture('guard-absent')
  assertFailed(await publish(next, { expectedKey: 'absent' }))
  assert.deepEqual(mutations(store), [])
  await assertOld(old)
})

test('a successful DRAFT commit unpublishes without changing previously published bytes', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const draft = await fixture('private-draft', 'DRAFT')
  const record = committedRecord(await publish(draft))
  assert.equal(record.status, 'DRAFT')
  assert.equal(record.previousKey, old.s3Key)
  assertMetadata(store.state.items.get(slug), draft, record.s3Key)
  await assertRevision(record.s3Key, draft.files)
  await assertRevision(old.s3Key, oldFiles)
  assert.equal(store.state.commits.length, 1)
})

test('a lost commit response retains a coherent revision and cannot authorize an unsafe retry', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const uncertain = await fixture('uncertain')
  store.failCommit({ mode: 'ambiguous' })
  const uncertainResult = await publish(uncertain)
  assertFailed(uncertainResult)
  assert.equal(commits(store).length, 1, 'Lost acknowledgement must not trigger another commit attempt')
  assert.equal(store.state.commits.length, 1)
  const uncertainKey = store.state.items.get(slug).s3Key.S
  assertMetadata(store.state.items.get(slug), uncertain, uncertainKey)
  await assertRevision(uncertainKey, uncertain.files)
  await assertRevision(old.s3Key, oldFiles)
  assert.ok(uncertainResult.stderr.includes(old.s3Key))
  assert.ok(uncertainResult.stderr.includes(uncertainKey.slice(0, -'page.mdx'.length)))

  const winner = await fixture('post-uncertainty-winner')
  const winnerRecord = committedRecord(await publish(winner))
  assert.equal(winnerRecord.previousKey, uncertainKey)
  const winningItem = structuredClone(store.state.items.get(slug))
  const since = store.state.requests.length
  assertFailed(await publish(uncertain, { expectedKey: old.s3Key }))
  assert.deepEqual(mutations(store, since), [])
  assert.deepEqual(store.state.items.get(slug), winningItem)
  await assertRevision(winnerRecord.s3Key, winner.files)
  await assertRevision(uncertainKey, uncertain.files)
  await assertRevision(old.s3Key, oldFiles)
})

test('a revalidation failure is nonfatal after a complete committed revision', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const next = await fixture('revalidation-failed')
  store.setRevalidationStatus(503)
  const result = await publish(next, { revalidate: true })
  const record = committedRecord(result)
  assertMetadata(store.state.items.get(slug), next, record.s3Key)
  await assertRevision(record.s3Key, next.files)
  await assertRevision(old.s3Key, oldFiles)
  assert.equal(record.revalidated, false)
  assert.equal(store.state.commits.length, 1)
  assert.doesNotMatch(result.stderr + result.stdout, /fixture-revalidation-secret|fixture-secret-key/)
})

test('legacy mutable pointers require migration and are rejected before writes', async (t) => {
  const { store, fixture, publish, seedOld, assertRevision, oldFiles } = await setup(t)
  const old = seedOld()
  const legacyKey = `articles/${slug}/page.mdx`
  store.seedObject(legacyKey, Buffer.from('Legacy body must remain untouched.\n'))
  const legacyItem = { ...old.item, s3Key: { S: legacyKey } }
  store.state.items.set(slug, structuredClone(legacyItem))
  const next = await fixture('requires-migration')
  const result = await publish(next)
  assertFailed(result)
  assert.deepEqual(mutations(store), [])
  assert.deepEqual(store.state.items.get(slug), legacyItem)
  assert.deepEqual(store.state.objects.get(legacyKey).body, Buffer.from('Legacy body must remain untouched.\n'))
  await assertRevision(old.s3Key, oldFiles)
})

test('an attempted reuse of an immutable revision cannot overwrite its existing body or assets', async t => {
  const { S3Client } = require('@aws-sdk/client-s3')
  const { stageRevision } = require('../scripts/lib/publication.cjs')
  const { store, fixture, seedOld, assertOld } = await setup(t)
  const old = seedOld()
  const replacement = await fixture('forbidden-overwrite')
  const s3 = new S3Client({
    region: 'us-east-1', endpoint: store.url, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key' },
  })
  try {
    await assert.rejects(stageRevision({
      s3, bucket: store.bucket, slug, revision: old.s3Key.split('/')[3],
      files: Object.entries(replacement.files).map(([name, body]) => ({ name, body })),
    }))
    await assertOld(old)
  } finally { s3.destroy() }
})
