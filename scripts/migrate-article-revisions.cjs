#!/usr/bin/env node
'use strict'

/*
 * Preparation only, unless --apply is explicit. No dotenv/secret lookup is done:
 * export ARTICLES_BUCKET, ARTICLES_TABLE, AWS_REGION and optionally AWS_PROFILE.
 * Freeze ALL old publishers before preparing; keep them frozen through migration
 * and reader deployment. AWS cannot atomically snapshot S3 plus DynamoDB.
 *
 * node scripts/migrate-article-revisions.cjs --plan ./reviewed-plan.json
 * node scripts/migrate-article-revisions.cjs --apply ./reviewed-plan.json --publishers-frozen
 *
 * Keep the reviewed plan after ANY failure. Reapplying that exact plan verifies
 * partial destination objects and skips only exact completed metadata snapshots.
 * Never delete old files or uncertain staged revisions to force a retry.
 */
const fs = require('node:fs/promises')
const { createHash, randomUUID } = require('node:crypto')
const {
  S3Client, GetBucketAclCommand, GetBucketLocationCommand, GetBucketVersioningCommand,
  ListObjectVersionsCommand, GetObjectCommand, PutObjectCommand,
} = require('@aws-sdk/client-s3')
const { DynamoDBClient, DescribeTableCommand, ScanCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb')
const { stageRevision, revisionObjectInput, readCurrentItem } = require('./lib/publication.cjs')
const { isRevisionKey } = require('../src/lib/article-revision.js')

const PLAN_VERSION = 1
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[0-9a-f]{64}$/

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function equal(a, b) { return canonical(a) === canonical(b) }
function checksum(value) { return createHash('sha256').update(value).digest('hex') }
function digest(value) { return checksum(canonical(value)) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function keys(value, expected, label) {
  requireThat(object(value) && equal(Object.keys(value).sort(), [...expected].sort()), `Invalid ${label} fields`)
}

function nonempty(value) { return typeof value === 'string' && value.length > 0 }

function normalizeAttribute(attribute) {
  requireThat(object(attribute) && Object.keys(attribute).length === 1, 'Invalid DynamoDB AttributeValue')
  const [type] = Object.keys(attribute)
  const value = attribute[type]
  if (type === 'S') requireThat(typeof value === 'string', 'Invalid DynamoDB string')
  else if (type === 'N') requireThat(typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value), 'Invalid DynamoDB number')
  else if (type === 'BOOL') requireThat(typeof value === 'boolean', 'Invalid DynamoDB boolean')
  else if (type === 'NULL') requireThat(value === true, 'Invalid DynamoDB null')
  else if (type === 'B') {
    if (value instanceof Uint8Array) return { B: Buffer.from(value).toString('base64') }
    requireThat(typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value, 'Invalid DynamoDB binary')
  } else if (type === 'M') return { M: normalizeItem(value) }
  else if (type === 'L') {
    requireThat(Array.isArray(value), 'Invalid DynamoDB list')
    return { L: value.map(normalizeAttribute) }
  } else if (['SS', 'NS', 'BS'].includes(type)) {
    requireThat(Array.isArray(value) && value.length > 0, 'Invalid DynamoDB set')
    const normalized = value.map(element => normalizeAttribute({ [type[0]]: element })[type[0]]).sort()
    requireThat(new Set(normalized).size === normalized.length, 'Duplicate DynamoDB set member')
    return { [type]: normalized }
  } else throw new Error(`Unsupported DynamoDB AttributeValue type: ${type}`)
  return { [type]: value }
}

function normalizeItem(item) {
  requireThat(object(item), 'Invalid DynamoDB item/map')
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalizeAttribute(item[key])]))
}

function decodeAttribute(attribute) {
  if ('B' in attribute) return { B: Buffer.from(attribute.B, 'base64') }
  if ('BS' in attribute) return { BS: attribute.BS.map(value => Buffer.from(value, 'base64')) }
  if ('M' in attribute) return { M: decodeItem(attribute.M) }
  if ('L' in attribute) return { L: attribute.L.map(decodeAttribute) }
  return attribute
}

function decodeItem(item) {
  return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, decodeAttribute(value)]))
}

function validateItem(raw) {
  const item = normalizeItem(raw)
  const slug = item.slug?.S
  requireThat(typeof slug === 'string' && SLUG.test(slug), 'Invalid article slug in metadata')
  for (const name of ['title', 'description', 'author', 'publishedAt', 'updatedAt', 's3Key']) {
    requireThat(nonempty(item[name]?.S), `Article ${slug} has invalid ${name}`)
  }
  requireThat(['PUBLISHED', 'DRAFT'].includes(item.status?.S), `Article ${slug} has invalid status`)
  requireThat(item.s3Key.S === `articles/${slug}/page.mdx` || isRevisionKey(slug, item.s3Key.S), `Article ${slug} has an unsupported pointer`)
  return item
}

function endpoint(value) {
  if (!value) return null
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('Invalid AWS endpoint URL') }
  requireThat(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'Unsafe AWS endpoint URL')
  return parsed.toString()
}

function configFromEnv(env = process.env) {
  const config = {
    bucket: env.ARTICLES_BUCKET,
    table: env.ARTICLES_TABLE,
    region: env.AWS_REGION,
    profile: env.AWS_PROFILE || null,
    s3Endpoint: endpoint(env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL),
    dynamodbEndpoint: endpoint(env.AWS_ENDPOINT_URL_DYNAMODB || env.AWS_ENDPOINT_URL),
  }
  validateConfig(config)
  return config
}

function validateConfig(config) {
  keys(config, ['bucket', 'table', 'region', 'profile', 's3Endpoint', 'dynamodbEndpoint'], 'target configuration')
  requireThat(typeof config.bucket === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket), 'ARTICLES_BUCKET must be an explicit bucket name')
  requireThat(typeof config.table === 'string' && /^[A-Za-z0-9_.-]{3,255}$/.test(config.table), 'ARTICLES_TABLE must be an explicit table name')
  requireThat(typeof config.region === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.region), 'AWS_REGION must be explicit')
  requireThat(config.profile === null || nonempty(config.profile), 'Invalid AWS_PROFILE')
  for (const name of ['s3Endpoint', 'dynamodbEndpoint']) {
    requireThat(config[name] === null || endpoint(config[name]) === config[name], `Invalid ${name}`)
  }
}

async function targetIdentity({ s3, ddb, config }) {
  const table = (await ddb.send(new DescribeTableCommand({ TableName: config.table }))).Table
  requireThat(table?.TableStatus === 'ACTIVE' && nonempty(table.TableArn) && nonempty(table.TableId), 'Target table must be active and have a stable identity')
  const arn = table.TableArn.split(':')
  requireThat(arn[2] === 'dynamodb' && arn[3] === config.region && /^\d{12}$/.test(arn[4]) && arn.slice(5).join(':') === `table/${config.table}`, 'Target table ARN does not match configuration')
  requireThat(equal(table.KeySchema, [{ AttributeName: 'slug', KeyType: 'HASH' }]) && table.AttributeDefinitions?.some(value => value.AttributeName === 'slug' && value.AttributeType === 'S'), 'Target table must have the string slug primary key')
  const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: config.bucket }))
  requireThat(versioning.Status === 'Enabled', 'S3 bucket versioning must be Enabled')
  const location = await s3.send(new GetBucketLocationCommand({ Bucket: config.bucket }))
  const bucketRegion = !location.LocationConstraint ? 'us-east-1' : location.LocationConstraint === 'EU' ? 'eu-west-1' : location.LocationConstraint
  requireThat(bucketRegion === config.region, 'S3 bucket region does not match AWS_REGION')
  const acl = await s3.send(new GetBucketAclCommand({ Bucket: config.bucket }))
  requireThat(nonempty(acl.Owner?.ID), 'S3 bucket owner identity is unavailable')
  return { tableArn: table.TableArn, tableId: table.TableId, bucketOwner: acl.Owner.ID, bucketRegion }
}

async function scanItems({ ddb, config }) {
  const items = new Map()
  const cursors = new Set()
  let cursor
  do {
    const response = await ddb.send(new ScanCommand({ TableName: config.table, ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }))
    requireThat(Array.isArray(response.Items), 'Scan did not return complete metadata items')
    for (const raw of response.Items) {
      const item = validateItem(raw)
      requireThat(!items.has(item.slug.S), `Duplicate scan result for ${item.slug.S}`)
      items.set(item.slug.S, item)
    }
    cursor = response.LastEvaluatedKey
    if (cursor && !Object.keys(cursor).length) cursor = undefined
    if (cursor) {
      const fingerprint = canonical(normalizeItem(cursor))
      requireThat(!cursors.has(fingerprint), 'DynamoDB scan pagination did not advance')
      cursors.add(fingerprint)
    }
  } while (cursor)
  return [...items.values()].sort((a, b) => a.slug.S.localeCompare(b.slug.S))
}

function validateName(name) {
  requireThat(nonempty(name) && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && !part.startsWith('.')), `Unsafe article object path: ${name}`)
}

async function inventory({ s3, config }, prefix, legacy = false) {
  const rows = []
  const seen = new Set()
  const cursors = new Set()
  let cursor = {}
  for (;;) {
    const response = await s3.send(new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: prefix, ...cursor }))
    requireThat(typeof response.IsTruncated === 'boolean', 'S3 did not identify whether the object inventory is complete')
    for (const [deleted, versions] of [[false, response.Versions || []], [true, response.DeleteMarkers || []]]) {
      for (const version of versions) {
        requireThat(typeof version.Key === 'string' && version.Key.startsWith(prefix), 'S3 returned an object outside the requested prefix')
        // This namespace is migration-owned, not part of mutable legacy content.
        if (legacy && version.Key.startsWith(`${prefix}revisions/`)) continue
        requireThat(nonempty(version.VersionId) && typeof version.IsLatest === 'boolean' && version.LastModified instanceof Date && Number.isFinite(version.LastModified.valueOf()), 'S3 returned an incomplete object version')
        const id = canonical([version.Key, version.VersionId])
        requireThat(!seen.has(id), 'S3 returned a repeated object version')
        seen.add(id)
        const row = { key: version.Key, versionId: version.VersionId, isLatest: version.IsLatest, deleted, lastModified: version.LastModified.toISOString() }
        if (!deleted) {
          requireThat(Number.isSafeInteger(version.Size) && version.Size >= 0 && nonempty(version.ETag), 'S3 returned incomplete object identity')
          row.size = version.Size
          row.etag = version.ETag
        }
        rows.push(row)
      }
    }
    if (!response.IsTruncated) break
    requireThat(nonempty(response.NextKeyMarker), 'S3 object inventory pagination did not advance')
    cursor = { KeyMarker: response.NextKeyMarker, ...(response.NextVersionIdMarker ? { VersionIdMarker: response.NextVersionIdMarker } : {}) }
    const fingerprint = canonical(cursor)
    requireThat(!cursors.has(fingerprint), 'S3 object inventory pagination repeated a cursor')
    cursors.add(fingerprint)
  }
  rows.sort((a, b) => canonical([a.key, a.versionId]).localeCompare(canonical([b.key, b.versionId])))
  validateInventory(rows, prefix)
  return rows
}

function validateInventory(rows, prefix) {
  requireThat(Array.isArray(rows), 'Invalid object inventory')
  const identities = new Set()
  const latest = new Map()
  for (const row of rows) {
    keys(row, row.deleted ? ['key', 'versionId', 'isLatest', 'deleted', 'lastModified'] : ['key', 'versionId', 'isLatest', 'deleted', 'lastModified', 'size', 'etag'], 'object inventory entry')
    requireThat(typeof row.key === 'string' && row.key.startsWith(prefix) && nonempty(row.versionId) && typeof row.isLatest === 'boolean' && typeof row.deleted === 'boolean' && typeof row.lastModified === 'string' && Number.isFinite(Date.parse(row.lastModified)), 'Invalid object inventory identity')
    if (!row.deleted) requireThat(Number.isSafeInteger(row.size) && row.size >= 0 && nonempty(row.etag), 'Invalid object size/ETag')
    const id = canonical([row.key, row.versionId])
    requireThat(!identities.has(id), 'Duplicate object version in inventory')
    identities.add(id)
    latest.set(row.key, (latest.get(row.key) || 0) + Number(row.isLatest))
  }
  requireThat([...latest.values()].every(count => count === 1), 'Object inventory must contain exactly one latest version per key')
}

async function readObject({ s3, config }, record) {
  requireThat(record.versionId !== 'null', `Source ${record.key} does not have an immutable VersionId`)
  const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: record.key, VersionId: record.versionId }))
  requireThat(response.VersionId === record.versionId && response.DeleteMarker !== true, `VersionId mismatch for ${record.key}`)
  requireThat(response.Body, `Missing object body for ${record.key}`)
  const body = Buffer.from(await response.Body.transformToByteArray())
  requireThat(body.length === record.size && response.ContentLength === record.size && response.ETag === record.etag, `Object identity mismatch for ${record.key}`)
  return { response, body }
}

function updatedItem(entry) { return { ...entry.item, s3Key: { S: entry.s3Key } } }

function conditionFor(entry) {
  const names = { '#pointer': 's3Key' }
  const values = { ':next': { S: entry.s3Key } }
  const conditions = Object.keys(entry.item).sort().map((name, index) => {
    names[`#a${index}`] = name
    values[`:v${index}`] = decodeAttribute(entry.item[name])
    return `#a${index} = :v${index}`
  })
  const condition = conditions.join(' AND ')
  requireThat(Buffer.byteLength(condition) <= 4096, `Article ${entry.slug} has too many metadata attributes for a safe DynamoDB condition`)
  return { UpdateExpression: 'SET #pointer = :next', ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values }
}

function sealPlan(payload) { return { ...payload, checksum: digest(payload) } }

function validatePlan(plan) {
  keys(plan, ['schemaVersion', 'createdAt', 'requiresFrozenPublishers', 'target', 'entries', 'skipped', 'checksum'], 'plan')
  const { checksum: expected, ...payload } = plan
  requireThat(typeof expected === 'string' && SHA256.test(expected) && digest(payload) === expected, 'Plan checksum mismatch; do not reuse a partial or edited plan')
  requireThat(plan.schemaVersion === PLAN_VERSION && plan.requiresFrozenPublishers === true && typeof plan.createdAt === 'string' && Number.isFinite(Date.parse(plan.createdAt)), 'Unsupported or incomplete migration plan')
  keys(plan.target, ['config', 'identity'], 'target')
  validateConfig(plan.target.config)
  keys(plan.target.identity, ['tableArn', 'tableId', 'bucketOwner', 'bucketRegion'], 'target identity')
  requireThat(Object.values(plan.target.identity).every(nonempty), 'Incomplete target identity')
  requireThat(Array.isArray(plan.entries) && Array.isArray(plan.skipped), 'Invalid migration entries')
  const slugs = new Set()
  for (const entry of plan.entries) {
    keys(entry, ['slug', 'item', 'revision', 's3Key', 'prefix', 'sourcePrefix', 'inventory', 'files'], 'migration entry')
    const item = validateItem(entry.item)
    requireThat(equal(item, entry.item) && entry.slug === item.slug.S && !slugs.has(entry.slug), 'Invalid/duplicate metadata snapshot')
    slugs.add(entry.slug)
    requireThat(entry.sourcePrefix === `articles/${entry.slug}/` && item.s3Key.S === `${entry.sourcePrefix}page.mdx`, 'Migration source is not a legacy pointer')
    requireThat(entry.prefix === `${entry.sourcePrefix}revisions/${entry.revision}/` && entry.s3Key === `${entry.prefix}page.mdx` && isRevisionKey(entry.slug, entry.s3Key), 'Invalid migration revision destination')
    validateInventory(entry.inventory, entry.sourcePrefix)
    requireThat(entry.inventory.every(row => !row.key.startsWith(`${entry.sourcePrefix}revisions/`)), 'Legacy inventory includes the reserved revisions namespace')
    const current = entry.inventory.filter(row => row.isLatest && !row.deleted)
    requireThat(Array.isArray(entry.files) && entry.files.length === current.length, 'Incomplete source file manifest')
    const names = new Set()
    for (const file of entry.files) {
      keys(file, ['name', 'key', 'versionId', 'size', 'sha256', 'contentType'], 'source file')
      validateName(file.name)
      requireThat(!names.has(file.name), 'Duplicate source file')
      names.add(file.name)
      const version = current.find(row => row.key === file.key)
      requireThat(file.key === `${entry.sourcePrefix}${file.name}` && version && file.versionId === version.versionId && file.versionId !== 'null' && file.size === version.size && typeof file.sha256 === 'string' && SHA256.test(file.sha256) && (file.contentType === null || nonempty(file.contentType)), 'Invalid source file manifest')
    }
    requireThat(names.has('page.mdx'), `Article ${entry.slug} is missing page.mdx`)
    conditionFor(entry)
  }
  for (const item of plan.skipped) {
    const normalized = validateItem(item)
    requireThat(equal(normalized, item) && isRevisionKey(item.slug.S, item.s3Key.S) && !slugs.has(item.slug.S), 'Invalid/duplicate skipped revision row')
    slugs.add(item.slug.S)
  }
  return plan
}

async function validateRevisionRow(clients, item) {
  const prefix = item.s3Key.S.slice(0, -'page.mdx'.length)
  const rows = await inventory(clients, prefix)
  const current = rows.filter(row => row.isLatest && !row.deleted)
  requireThat(current.some(row => row.key === item.s3Key.S && row.versionId !== 'null'), `Committed article ${item.slug.S} has no immutable page.mdx`)
  requireThat(rows.every(row => row.isLatest && !row.deleted && row.versionId !== 'null'), `Committed article ${item.slug.S} has mutable or deleted revision objects`)
  for (const row of current) validateName(row.key.slice(prefix.length))
}

async function preparePlan({ s3, ddb, config }) {
  validateConfig(config)
  const clients = { s3, ddb, config }
  const identity = await targetIdentity(clients)
  const items = await scanItems(clients)
  const entries = []
  const skipped = []
  for (const item of items) {
    const slug = item.slug.S
    if (isRevisionKey(slug, item.s3Key.S)) {
      await validateRevisionRow(clients, item)
      skipped.push(item)
      continue
    }
    const revision = randomUUID()
    const sourcePrefix = `articles/${slug}/`
    const prefix = `${sourcePrefix}revisions/${revision}/`
    const entry = { slug, item, revision, s3Key: `${prefix}page.mdx`, prefix, sourcePrefix, inventory: await inventory(clients, sourcePrefix, true), files: [] }
    requireThat((await inventory(clients, prefix)).length === 0, `Migration destination is not empty: ${prefix}`)
    for (const record of entry.inventory.filter(row => row.isLatest && !row.deleted)) {
      const name = record.key.slice(sourcePrefix.length)
      validateName(name)
      const { response, body } = await readObject(clients, record)
      entry.files.push({ name, key: record.key, versionId: record.versionId, size: body.length, sha256: checksum(body), contentType: response.ContentType || null })
    }
    entries.push(entry)
  }
  // Scan is consistent per item, not an atomic table snapshot. A second full
  // scan detects observable changes; the publisher freeze remains essential.
  requireThat(equal(await scanItems(clients), items), 'Metadata changed while preparing the plan; freeze publishers and prepare a new plan')
  for (const entry of entries) {
    await assertSourceInventory(clients, entry)
    requireThat((await inventory(clients, entry.prefix)).length === 0, `Migration destination is not empty: ${entry.prefix}`)
  }
  requireThat(equal(await targetIdentity(clients), identity), 'Target identity changed during preparation')
  return validatePlan(sealPlan({ schemaVersion: PLAN_VERSION, createdAt: new Date().toISOString(), requiresFrozenPublishers: true, target: { config, identity }, entries, skipped }))
}

async function assertSourceInventory(clients, entry) {
  requireThat(equal(await inventory(clients, entry.sourcePrefix, true), entry.inventory), `Legacy source inventory changed for ${entry.slug}; do not apply this plan`)
}

async function rowState(clients, entry) {
  const raw = await readCurrentItem({ ddb: clients.ddb, table: clients.config.table, slug: entry.slug })
  requireThat(raw, `Metadata disappeared for ${entry.slug}`)
  const current = normalizeItem(raw)
  if (equal(current, entry.item)) return 'legacy'
  if (equal(current, updatedItem(entry))) return 'migrated'
  throw new Error(`Entire metadata snapshot changed for ${entry.slug}; refusing this plan`)
}

async function assertTarget(clients, entry, complete) {
  const rows = await inventory(clients, entry.prefix)
  const existing = new Set()
  for (const record of rows) {
    const name = record.key.slice(entry.prefix.length)
    const file = entry.files.find(candidate => candidate.name === name)
    requireThat(file && record.isLatest && !record.deleted && record.versionId !== 'null' && !existing.has(name), `Unexpected or overwritten migration target: ${record.key}`)
    existing.add(name)
    const { response, body } = await readObject(clients, record)
    const expected = revisionObjectInput({ bucket: clients.config.bucket, prefix: entry.prefix, file: { name, body, ...(file.contentType ? { contentType: file.contentType } : {}) } })
    requireThat(body.length === file.size && checksum(body) === file.sha256 && response.ContentType === expected.ContentType && response.CacheControl === expected.CacheControl && !Object.keys(response.Metadata || {}).length && !response.ContentEncoding && !response.ContentDisposition && !response.ContentLanguage && !response.Expires && !response.WebsiteRedirectLocation, `Migration target bytes/metadata differ: ${record.key}`)
  }
  requireThat(!complete || existing.size === entry.files.length, `Committed/staged migration target is incomplete: ${entry.prefix}`)
  return existing
}

async function sourceFiles(clients, entry) {
  const files = []
  for (const file of entry.files) {
    const record = entry.inventory.find(row => row.key === file.key && row.versionId === file.versionId)
    const { response, body } = await readObject(clients, record)
    requireThat(checksum(body) === file.sha256 && (response.ContentType || null) === file.contentType, `Immutable source checksum/metadata changed: ${file.key}`)
    files.push({ name: file.name, body, ...(file.contentType ? { contentType: file.contentType } : {}) })
  }
  return files
}

async function applyPlan({ s3, ddb, config, plan, publishersFrozen = false }) {
  validatePlan(plan)
  validateConfig(config)
  requireThat(publishersFrozen === true, 'Apply requires an explicit publishers-frozen acknowledgement')
  requireThat(equal(config, plan.target.config), 'Current target configuration does not match the reviewed plan')
  const clients = { s3, ddb, config }
  requireThat(equal(await targetIdentity(clients), plan.target.identity), 'Current target identity does not match the reviewed plan')
  // Validate EVERY row before any write, not just the first migration entry.
  const scanned = await scanItems(clients)
  const expectedSlugs = [...plan.entries.map(entry => entry.slug), ...plan.skipped.map(item => item.slug.S)].sort()
  requireThat(equal(scanned.map(item => item.slug.S).sort(), expectedSlugs), 'Article inventory changed after preparation')
  for (const item of plan.skipped) {
    requireThat(equal(scanned.find(row => row.slug.S === item.slug.S), item), `Skipped metadata snapshot changed for ${item.slug.S}`)
    await validateRevisionRow(clients, item)
  }
  for (const entry of plan.entries) {
    const state = await rowState(clients, entry)
    await assertSourceInventory(clients, entry)
    await assertTarget(clients, entry, state === 'migrated')
  }
  const results = []
  for (const entry of plan.entries) {
    try {
      const state = await rowState(clients, entry)
      await assertSourceInventory(clients, entry)
      const existing = await assertTarget(clients, entry, state === 'migrated')
      if (state === 'migrated') {
        results.push({ slug: entry.slug, s3Key: entry.s3Key, committed: true, resumed: true })
        continue
      }
      const files = await sourceFiles(clients, entry)
      await assertSourceInventory(clients, entry)
      requireThat(await rowState(clients, entry) === 'legacy', `Metadata changed before staging ${entry.slug}`)
      if (!existing.size) {
        await stageRevision({ s3, bucket: config.bucket, slug: entry.slug, files, revision: entry.revision })
      } else {
        // Shared stageRevision requires page.mdx. Recovery may already have it,
        // so use the exact same object inputs for missing files only.
        for (const file of files) {
          if (!existing.has(file.name)) await s3.send(new PutObjectCommand(revisionObjectInput({ bucket: config.bucket, prefix: entry.prefix, file })))
        }
      }
      await assertTarget(clients, entry, true)
      await assertSourceInventory(clients, entry)
      requireThat(await rowState(clients, entry) === 'legacy', `Metadata changed before committing ${entry.slug}`)
      // DynamoDB cannot compare a root item's complete attribute-name set.
      // Compare every captured attribute atomically and update ONLY s3Key:
      // concurrent added attributes survive rather than being silently lost.
      const response = await ddb.send(new UpdateItemCommand({
        TableName: config.table, Key: { slug: { S: entry.slug } },
        ...conditionFor(entry), ReturnValues: 'ALL_NEW',
      }))
      const actual = response.Attributes && normalizeItem(response.Attributes)
      const expected = updatedItem(entry)
      requireThat(actual && Object.entries(expected).every(([name, value]) => equal(actual[name], value)), `Uncertain migration commit result for ${entry.slug}; retain all objects and the plan`)
      results.push({ slug: entry.slug, s3Key: entry.s3Key, previousKey: entry.item.s3Key.S, status: entry.item.status.S, committed: true, resumed: false, preservedAddedAttributes: Object.keys(actual).filter(name => !Object.hasOwn(expected, name)) })
    } catch (error) {
      throw new Error(`Migration stopped for ${entry.slug}; retain reviewed plan and prefix ${entry.prefix}. No automatic retry or cleanup. ${error.message}`, { cause: error })
    }
  }
  return { applied: true, planChecksum: plan.checksum, results, skipped: plan.skipped.map(item => item.slug.S) }
}

async function writePlan(path, plan) {
  validatePlan(plan)
  const file = await fs.open(path, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(plan, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
}

function argumentsFrom(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  let mode = 'prepare'
  let path = 'article-revision-plan.json'
  let selected = false
  let publishersFrozen = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--publishers-frozen') {
      requireThat(!publishersFrozen, 'Duplicate --publishers-frozen')
      publishersFrozen = true
    } else if (arg === '--plan' || arg === '--apply') {
      requireThat(!selected && nonempty(argv[index + 1]) && !argv[index + 1].startsWith('--'), 'Specify exactly one --plan <file> or --apply <file>')
      selected = true
      mode = arg === '--apply' ? 'apply' : 'prepare'
      path = argv[++index]
    } else throw new Error(`Unknown migration argument: ${arg}`)
  }
  requireThat(mode === 'apply' || !publishersFrozen, '--publishers-frozen is an apply acknowledgement, not a preparation option')
  requireThat(mode !== 'apply' || publishersFrozen, '--apply requires --publishers-frozen')
  return { mode, path, publishersFrozen }
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFrom(argv)
  if (options.help) {
    process.stdout.write('Prepare (read-only AWS): node scripts/migrate-article-revisions.cjs [--plan <new-file.json>]\nApply: node scripts/migrate-article-revisions.cjs --apply <reviewed-file.json> --publishers-frozen\nRequired exported env: ARTICLES_BUCKET, ARTICLES_TABLE, AWS_REGION; optional AWS_PROFILE and AWS_ENDPOINT_URL[_S3|_DYNAMODB].\nFreeze legacy publishers before preparing. Review the complete plan; keep publishers frozen until the new reader is deployed.\nOnly apply mutates AWS. No secrets are looked up, and no source objects are changed or deleted.\n')
    return
  }
  const config = configFromEnv()
  let plan
  if (options.mode === 'apply') {
    plan = validatePlan(JSON.parse(await fs.readFile(options.path, 'utf8')))
    requireThat(equal(config, plan.target.config), 'Current target configuration does not match the reviewed plan')
  } else {
    try {
      await fs.lstat(options.path)
      throw new Error(`Refusing to overwrite plan path: ${options.path}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const s3 = new S3Client({ region: config.region, maxAttempts: 1, ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}) })
  const ddb = new DynamoDBClient({ region: config.region, maxAttempts: 1, ...(config.dynamodbEndpoint ? { endpoint: config.dynamodbEndpoint } : {}) })
  try {
    if (options.mode === 'apply') {
      process.stdout.write(`${JSON.stringify(await applyPlan({ s3, ddb, config, plan, publishersFrozen: options.publishersFrozen }))}\n`)
    } else {
      plan = await preparePlan({ s3, ddb, config })
      await writePlan(options.path, plan)
      process.stdout.write(`${JSON.stringify({ prepared: true, plan: options.path, checksum: plan.checksum, articles: plan.entries.length, skipped: plan.skipped.length, applied: false })}\n`)
    }
  } finally {
    s3.destroy()
    ddb.destroy()
  }
}

module.exports = { preparePlan, applyPlan, validatePlan, writePlan, configFromEnv, normalizeItem, canonical, main }
if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Migration error: ${error.message}\n`)
    process.exitCode = 1
  })
}
