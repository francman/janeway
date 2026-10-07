'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  preparePlan, applyPlan, validatePlan, writePlan, configFromEnv, normalizeItem, canonical,
} = require('../scripts/migrate-article-revisions.cjs')

// Isolated SDK command transport: no credential provider, socket or AWS account
// is involved. Real stageRevision/revisionObjectInput and SDK command inputs are
// exercised. Unknown operations fail instead of pretending to have succeeded.
function fixture() {
  const config = configFromEnv({ ARTICLES_BUCKET: 'fixture-articles', ARTICLES_TABLE: 'fixture-articles', AWS_REGION: 'us-east-1', AWS_PROFILE: 'fixture-only' })
  const state = {
    items: new Map(), objects: new Map(), operations: [], puts: 0, updates: 0,
    serial: 0, versioning: 'Enabled', tableId: 'fixture-table-id', owner: 'fixture-bucket-owner',
    beforePut: null, beforeUpdate: null, afterUpdate: null, beforeGet: null, beforeScan: null,
  }
  function addObject(key, body, headers = {}) {
    const bytes = Buffer.from(body)
    const versions = state.objects.get(key) || []
    for (const version of versions) version.IsLatest = false
    const version = {
      Key: key, VersionId: `version-${++state.serial}`, IsLatest: true,
      LastModified: new Date(1700000000000 + state.serial),
      ETag: `"${createHash('md5').update(bytes).digest('hex')}"`, Size: bytes.length,
      bytes, ContentType: key.endsWith('.mdx') ? 'text/mdx' : 'image/png',
      Metadata: {}, ...headers,
    }
    versions.unshift(version)
    state.objects.set(key, versions)
    return version
  }
  function addDeleteMarker(key) {
    const versions = state.objects.get(key) || []
    for (const version of versions) version.IsLatest = false
    versions.unshift({ Key: key, VersionId: `version-${++state.serial}`, IsLatest: true, LastModified: new Date(1700000000000 + state.serial), deleted: true })
    state.objects.set(key, versions)
  }
  function addArticle(slug = 'legacy-article', extra = {}) {
    const item = {
      slug: { S: slug }, title: { S: 'Old title' }, description: { S: 'Description' },
      author: { S: 'Author' }, publishedAt: { S: '2026-01-15' }, updatedAt: { S: '2026-01-16T00:00:00Z' },
      status: { S: 'PUBLISHED' }, s3Key: { S: `articles/${slug}/page.mdx` },
      tags: { SS: ['cloud', 'local'] }, unknown: { M: { enabled: { BOOL: true }, bytes: { B: Buffer.from('binary') }, value: { N: '42' }, nested: { L: [{ NULL: true }, { S: 'kept' }] } } },
      binarySet: { BS: [Buffer.from('b'), Buffer.from('a')] }, ...extra,
    }
    state.items.set(slug, structuredClone(item))
    addObject(`articles/${slug}/page.mdx`, '# Old page\n![image](image.png)')
    addObject(`articles/${slug}/image.png`, 'old image bytes')
    return item
  }
  function fail(name, message = name) {
    return Object.assign(new Error(message), { name })
  }
  const s3 = {
    async send(command) {
      const name = command.constructor.name
      const input = command.input
      state.operations.push({ service: 's3', name, input })
      assert.equal(input.Bucket, config.bucket)
      if (name === 'GetBucketVersioningCommand') return { Status: state.versioning }
      if (name === 'GetBucketLocationCommand') return {}
      if (name === 'GetBucketAclCommand') return { Owner: { ID: state.owner } }
      if (name === 'ListObjectVersionsCommand') {
        const versions = [...state.objects.entries()].filter(([key]) => key.startsWith(input.Prefix)).sort(([a], [b]) => a.localeCompare(b)).flatMap(([, records]) => records)
        const start = input.KeyMarker ? versions.findIndex(row => row.Key === input.KeyMarker && row.VersionId === input.VersionIdMarker) + 1 : 0
        assert.ok(!input.KeyMarker || start > 0, 'inventory cursor must exist')
        const page = versions.slice(start, start + 2)
        const truncated = start + page.length < versions.length
        const summarize = row => {
          const result = { Key: row.Key, VersionId: row.VersionId, IsLatest: row.IsLatest, LastModified: row.LastModified }
          if (!row.deleted) Object.assign(result, { Size: row.Size, ETag: row.ETag })
          return result
        }
        return {
          Versions: page.filter(row => !row.deleted).map(summarize),
          DeleteMarkers: page.filter(row => row.deleted).map(summarize), IsTruncated: truncated,
          ...(truncated ? { NextKeyMarker: page.at(-1).Key, NextVersionIdMarker: page.at(-1).VersionId } : {}),
        }
      }
      if (name === 'GetObjectCommand') {
        if (state.beforeGet) await state.beforeGet(input)
        assert.ok(input.VersionId, 'migration must always pin object reads to VersionId')
        const version = state.objects.get(input.Key)?.find(row => row.VersionId === input.VersionId)
        if (!version || version.deleted) throw fail('NoSuchVersion')
        return {
          VersionId: version.VersionId, ContentLength: version.Size, ETag: version.ETag,
          ContentType: version.ContentType, CacheControl: version.CacheControl, Metadata: version.Metadata,
          ContentEncoding: version.ContentEncoding, ContentDisposition: version.ContentDisposition,
          ContentLanguage: version.ContentLanguage, Expires: version.Expires, WebsiteRedirectLocation: version.WebsiteRedirectLocation,
          Body: { async transformToByteArray() { return version.bytes } },
        }
      }
      if (name === 'PutObjectCommand') {
        assert.equal(input.IfNoneMatch, '*')
        assert.ok(input.Key.includes('/revisions/'), 'migration must never write legacy objects')
        if (state.beforePut) await state.beforePut(input)
        if (state.objects.get(input.Key)?.some(row => row.IsLatest && !row.deleted)) throw fail('PreconditionFailed')
        state.puts++
        addObject(input.Key, input.Body, { ContentType: input.ContentType, CacheControl: input.CacheControl })
        return {}
      }
      throw new Error(`Unexpected S3 operation: ${name}`)
    },
  }
  const ddb = {
    async send(command) {
      const name = command.constructor.name
      const input = command.input
      state.operations.push({ service: 'ddb', name, input })
      assert.equal(input.TableName, config.table)
      if (name === 'DescribeTableCommand') return { Table: { TableStatus: 'ACTIVE', TableArn: `arn:aws:dynamodb:${config.region}:123456789012:table/${config.table}`, TableId: state.tableId, KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'slug', AttributeType: 'S' }] } }
      if (name === 'ScanCommand') {
        assert.equal(input.ConsistentRead, true)
        if (state.beforeScan) await state.beforeScan(input)
        const items = [...state.items.values()].sort((a, b) => a.slug.S.localeCompare(b.slug.S))
        const start = input.ExclusiveStartKey ? items.findIndex(item => item.slug.S === input.ExclusiveStartKey.slug.S) + 1 : 0
        const page = items.slice(start, start + 1)
        return { Items: structuredClone(page), ...(start + 1 < items.length ? { LastEvaluatedKey: { slug: page[0].slug } } : {}) }
      }
      if (name === 'GetItemCommand') {
        assert.equal(input.ConsistentRead, true)
        return { Item: structuredClone(state.items.get(input.Key.slug.S)) }
      }
      if (name === 'UpdateItemCommand') {
        if (state.beforeUpdate) await state.beforeUpdate(input)
        const current = state.items.get(input.Key.slug.S)
        for (const condition of input.ConditionExpression.split(' AND ')) {
          const match = /^(#a\d+) = (:v\d+)$/.exec(condition)
          assert.ok(match, `Unsupported fake condition: ${condition}`)
          const attribute = input.ExpressionAttributeNames[match[1]]
          const expected = input.ExpressionAttributeValues[match[2]]
          if (!current || !Object.hasOwn(current, attribute) || canonical(normalizeItem({ value: current[attribute] })) !== canonical(normalizeItem({ value: expected }))) throw fail('ConditionalCheckFailedException')
        }
        assert.equal(input.UpdateExpression, 'SET #pointer = :next')
        assert.equal(input.ExpressionAttributeNames['#pointer'], 's3Key')
        assert.equal(input.ReturnValues, 'ALL_NEW')
        state.updates++
        current.s3Key = structuredClone(input.ExpressionAttributeValues[':next'])
        if (state.afterUpdate) await state.afterUpdate(input)
        return { Attributes: structuredClone(current) }
      }
      throw new Error(`Unexpected DynamoDB operation: ${name}`)
    },
  }
  addArticle()
  return { s3, ddb, config, state, addObject, addArticle, addDeleteMarker }
}

async function apply(f, plan, extra = {}) {
  return applyPlan({ ...f, plan, publishersFrozen: true, ...extra })
}
function writes(f) { return { puts: f.state.puts, updates: f.state.updates } }
function entry(plan) { return plan.entries[0] }
function current(f, slug = 'legacy-article') { return f.state.items.get(slug) }

function reseal(plan) {
  const { checksum: ignored, ...payload } = plan
  return { ...payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') }
}

test('prepare is read-only, paginates complete records/history, preserves binary and arbitrary metadata', async () => {
  const f = fixture()
  f.addArticle('another-article', { status: { S: 'DRAFT' } })
  f.addObject('articles/legacy-article/image.png', 'latest image bytes')
  f.addObject('articles/legacy-article/deleted.png', 'obsolete')
  f.addDeleteMarker('articles/legacy-article/deleted.png')
  const plan = await preparePlan(f)
  assert.deepEqual(writes(f), { puts: 0, updates: 0 })
  assert.equal(plan.entries.length, 2)
  const legacy = plan.entries.find(row => row.slug === 'legacy-article')
  assert.equal(legacy.inventory.length, 5)
  assert.equal(legacy.files.length, 2)
  assert.equal(legacy.item.unknown.M.bytes.B, Buffer.from('binary').toString('base64'))
  assert.equal(legacy.files.find(file => file.name === 'image.png').versionId, f.state.objects.get('articles/legacy-article/image.png')[0].VersionId)
  assert.ok(f.state.operations.some(op => op.name === 'ScanCommand' && op.input.ExclusiveStartKey))
  assert.ok(f.state.operations.some(op => op.name === 'ListObjectVersionsCommand' && op.input.VersionIdMarker))
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(plan))), plan)
})

test('apply changes only s3Key, retains old object bytes and arbitrary metadata, and safely skips exact committed rows', async () => {
  const f = fixture()
  const before = normalizeItem(current(f))
  const plan = await preparePlan(f)
  const result = await apply(f, plan)
  assert.equal(result.results[0].committed, true)
  assert.deepEqual(normalizeItem(current(f)), { ...before, s3Key: { S: entry(plan).s3Key } })
  assert.equal(f.state.objects.get('articles/legacy-article/image.png')[0].bytes.toString(), 'old image bytes')
  assert.equal(f.state.objects.get(`${entry(plan).prefix}image.png`)[0].bytes.toString(), 'old image bytes')
  assert.equal(f.state.objects.get(entry(plan).s3Key)[0].CacheControl, 'private, no-store')
  assert.equal(f.state.objects.get(`${entry(plan).prefix}image.png`)[0].CacheControl, 'public,max-age=31536000,immutable')
  const beforeRetry = writes(f)
  assert.equal((await apply(f, plan)).results[0].resumed, true)
  assert.deepEqual(writes(f), beforeRetry)
  assert.equal(current(f).unknown.M.bytes.B instanceof Uint8Array, true)
})

test('preparation validates and skips already revisioned rows', async () => {
  const f = fixture()
  const first = await preparePlan(f)
  await apply(f, first)
  const prepared = await preparePlan(f)
  assert.equal(prepared.entries.length, 0)
  assert.equal(prepared.skipped.length, 1)
  f.state.objects.delete(current(f).s3Key.S)
  await assert.rejects(preparePlan(f))
})

test('apply rejects checksum corruption, malformed/resealed partial manifests, target mismatch, and absent freeze acknowledgement before writes', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  const corrupt = structuredClone(plan)
  corrupt.entries[0].item.title.S = 'tampered'
  await assert.rejects(apply(f, corrupt))
  const incomplete = structuredClone(plan)
  incomplete.entries[0].files.pop()
  await assert.rejects(apply(f, reseal(incomplete)))
  await assert.rejects(apply(f, plan, { config: { ...f.config, profile: 'other-profile' } }))
  await assert.rejects(apply(f, plan, { publishersFrozen: false }))
  f.state.tableId = 'recreated-table'
  await assert.rejects(apply(f, plan))
  assert.deepEqual(writes(f), { puts: 0, updates: 0 })
})

test('prepare fails closed for unversioned sources, unsafe files and metadata changes during scan', async t => {
  await t.test('bucket versioning must be enabled', async () => {
    const f = fixture()
    f.state.versioning = 'Suspended'
    await assert.rejects(preparePlan(f))
  })
  await t.test('null current VersionId is not immutable', async () => {
    const f = fixture()
    f.state.objects.get('articles/legacy-article/page.mdx')[0].VersionId = 'null'
    await assert.rejects(preparePlan(f))
  })
  await t.test('dotfiles are not silently dropped', async () => {
    const f = fixture()
    f.addObject('articles/legacy-article/assets/.secret', 'not publishable')
    await assert.rejects(preparePlan(f))
  })
  await t.test('complete scan snapshot changes are rejected', async () => {
    const f = fixture()
    let scans = 0
    f.state.beforeScan = () => { if (++scans === 2) current(f).unplanned = { S: 'new attribute' } }
    await assert.rejects(preparePlan(f))
  })
})

test('apply validates every metadata row and article membership before any staging', async t => {
  await t.test('unknown added metadata on a later row aborts entire preflight', async () => {
    const f = fixture()
    f.addArticle('zz-last')
    const plan = await preparePlan(f)
    current(f, 'zz-last').added = { S: 'old publisher write' }
    await assert.rejects(apply(f, plan))
    assert.deepEqual(writes(f), { puts: 0, updates: 0 })
  })
  await t.test('new article is not omitted', async () => {
    const f = fixture()
    const plan = await preparePlan(f)
    f.addArticle('new-article')
    await assert.rejects(apply(f, plan))
    assert.deepEqual(writes(f), { puts: 0, updates: 0 })
  })
})

test('source overwrite, added file, delete marker and overwrite-then-restore all invalidate reviewed inventory', async t => {
  for (const change of ['overwrite', 'add', 'delete', 'restore']) {
    await t.test(change, async () => {
      const f = fixture()
      const plan = await preparePlan(f)
      if (change === 'add') f.addObject('articles/legacy-article/new.png', 'new')
      else if (change === 'delete') f.addDeleteMarker('articles/legacy-article/image.png')
      else {
        f.addObject('articles/legacy-article/image.png', 'changed')
        if (change === 'restore') f.addObject('articles/legacy-article/image.png', 'old image bytes')
      }
      await assert.rejects(apply(f, plan))
      assert.deepEqual(writes(f), { puts: 0, updates: 0 })
    })
  }
})

test('a pinned source checksum failure cannot commit or stage', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  const version = f.state.objects.get('articles/legacy-article/image.png')[0]
  version.bytes = Buffer.from('bad image bytes') // Same length and reported identity: transport corruption.
  await assert.rejects(apply(f, plan))
  assert.deepEqual(writes(f), { puts: 0, updates: 0 })
})

test('failed upload resumes the same reviewed revision without overwriting successful target objects', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  let calls = 0
  f.state.beforePut = () => { if (++calls === 2) throw new Error('injected upload failure') }
  await assert.rejects(apply(f, plan))
  assert.equal(current(f).s3Key.S, 'articles/legacy-article/page.mdx')
  assert.equal(f.state.puts, 1)
  const firstObject = [...f.state.objects.keys()].find(key => key.startsWith(entry(plan).prefix))
  const firstVersion = f.state.objects.get(firstObject)[0].VersionId
  f.state.beforePut = null
  await apply(f, plan)
  assert.equal(f.state.puts, 2)
  assert.equal(f.state.objects.get(firstObject).length, 1)
  assert.equal(f.state.objects.get(firstObject)[0].VersionId, firstVersion)
  assert.equal(current(f).s3Key.S, entry(plan).s3Key)
})

test('partial recovery also works when page.mdx already exists and only assets are missing', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  const source = f.state.objects.get('articles/legacy-article/page.mdx')[0]
  const staged = f.addObject(entry(plan).s3Key, source.bytes, { ContentType: source.ContentType, CacheControl: 'private, no-store' })
  await apply(f, plan)
  assert.equal(f.state.puts, 1)
  assert.equal(f.state.objects.get(entry(plan).s3Key).length, 1)
  assert.equal(f.state.objects.get(entry(plan).s3Key)[0].VersionId, staged.VersionId)
  assert.equal(f.state.objects.get(`${entry(plan).prefix}image.png`)[0].bytes.toString(), 'old image bytes')
})

test('recovery rejects differing target bytes, metadata, extra objects and overwritten target history', async t => {
  for (const change of ['bytes', 'metadata', 'extra', 'history']) {
    await t.test(change, async () => {
      const f = fixture()
      const plan = await preparePlan(f)
      f.state.beforeUpdate = () => { throw new Error('commit rejected') }
      await assert.rejects(apply(f, plan))
      f.state.beforeUpdate = null
      const key = `${entry(plan).prefix}image.png`
      const version = f.state.objects.get(key)[0]
      if (change === 'bytes') version.bytes = Buffer.from('bad image bytes')
      else if (change === 'metadata') version.CacheControl = 'public,max-age=0'
      else if (change === 'extra') f.addObject(`${entry(plan).prefix}unplanned.png`, 'extra')
      else f.addObject(key, version.bytes, { ContentType: version.ContentType, CacheControl: version.CacheControl })
      const before = writes(f)
      await assert.rejects(apply(f, plan))
      assert.deepEqual(writes(f), before)
      assert.equal(current(f).s3Key.S, 'articles/legacy-article/page.mdx')
    })
  }
})

test('changed/deleted captured metadata immediately before commit fails its full condition', async t => {
  for (const change of ['edit', 'delete']) {
    await t.test(change, async () => {
      const f = fixture()
      const plan = await preparePlan(f)
      f.state.beforeUpdate = () => {
        if (change === 'edit') current(f).unknown.M.value.N = '43'
        else delete current(f).unknown
      }
      await assert.rejects(apply(f, plan))
      assert.equal(current(f).s3Key.S, 'articles/legacy-article/page.mdx')
      assert.equal(f.state.updates, 0)
      assert.equal(f.state.puts, 2)
    })
  }
})

test('only-pointer UpdateItem preserves unknown attributes added in the final commit race', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  f.state.beforeUpdate = () => { current(f).concurrentAddition = { M: { note: { S: 'retain me' } } } }
  const result = await apply(f, plan)
  assert.equal(current(f).concurrentAddition.M.note.S, 'retain me')
  assert.deepEqual(result.results[0].preservedAddedAttributes, ['concurrentAddition'])
  assert.equal(current(f).s3Key.S, entry(plan).s3Key)
  f.state.beforeUpdate = null
  await assert.rejects(apply(f, plan))
})

test('source writes during staging prevent commit while retaining every old source and staged object', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  let injected = false
  f.state.beforePut = () => {
    if (!injected) {
      injected = true
      f.addObject('articles/legacy-article/page.mdx', '# A racing old publisher')
    }
  }
  await assert.rejects(apply(f, plan))
  assert.equal(f.state.updates, 0)
  assert.equal(current(f).s3Key.S, 'articles/legacy-article/page.mdx')
  assert.equal(f.state.objects.get('articles/legacy-article/page.mdx').length, 2)
  assert.ok(f.state.objects.has(entry(plan).s3Key))
})

test('ambiguous committed response is recovered only by exact metadata and complete immutable target', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  f.state.afterUpdate = () => { throw new Error('connection lost after commit') }
  await assert.rejects(apply(f, plan))
  assert.equal(current(f).s3Key.S, entry(plan).s3Key)
  f.state.afterUpdate = null
  const before = writes(f)
  assert.equal((await apply(f, plan)).results[0].resumed, true)
  assert.deepEqual(writes(f), before)
  f.state.objects.delete(`${entry(plan).prefix}image.png`)
  await assert.rejects(apply(f, plan))
  assert.deepEqual(writes(f), before)
})

test('a reviewed plan can resume earlier exact commits after a later article fails', async () => {
  const f = fixture()
  f.addArticle('zz-second', { status: { S: 'DRAFT' } })
  const plan = await preparePlan(f)
  f.state.beforeUpdate = input => { if (input.Key.slug.S === 'zz-second') throw new Error('second commit failed') }
  await assert.rejects(apply(f, plan))
  assert.equal(current(f).s3Key.S, plan.entries[0].s3Key)
  assert.equal(current(f, 'zz-second').s3Key.S, 'articles/zz-second/page.mdx')
  f.state.beforeUpdate = null
  const result = await apply(f, plan)
  assert.equal(result.results[0].resumed, true)
  assert.equal(result.results[1].committed, true)
  assert.equal(current(f, 'zz-second').status.S, 'DRAFT')
  assert.equal(f.state.puts, 4)
})

test('plan persistence is exclusive and refuses reuse of incomplete files', async () => {
  const f = fixture()
  const plan = await preparePlan(f)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'janeway-migration-'))
  try {
    const destination = path.join(directory, 'reviewed.json')
    await writePlan(destination, plan)
    assert.deepEqual(validatePlan(JSON.parse(await fs.readFile(destination, 'utf8'))), plan)
    await assert.rejects(writePlan(destination, plan), error => error.code === 'EEXIST')
    const incomplete = path.join(directory, 'incomplete.json')
    await fs.writeFile(incomplete, '{"schemaVersion":1')
    await assert.rejects(writePlan(incomplete, plan), error => error.code === 'EEXIST')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
