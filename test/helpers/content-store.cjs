const http = require('node:http')
const { createHash, randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')

const clone = (value) => (value === undefined ? undefined : structuredClone(value))
const xml = (value) => String(value).replace(/[<>&"']/g, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[character])

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/x-amz-json-1.0' })
  response.end(JSON.stringify(body))
}

function dynamoError(response, code, message, status = 400) {
  sendJson(response, status, { __type: code, message })
}

function s3Error(response, code, message, status = 400) {
  response.writeHead(status, { 'content-type': 'application/xml' })
  response.end(`<Error><Code>${xml(code)}</Code><Message>${xml(message)}</Message></Error>`)
}

function comparableAttribute(value) {
  if (!value) return value
  for (const type of ['SS', 'NS', 'BS']) {
    if (value[type]) return { [type]: new Set(value[type]) }
  }
  if (value.M) return { M: Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, comparableAttribute(item)])) }
  if (value.L) return { L: value.L.map(comparableAttribute) }
  return value
}

function matchesCondition(expression, item, names = {}, values = {}) {
  if (!expression) return true
  const condition = expression.trim()
  const absent = /^attribute_not_exists\(\s*([#\w]+)\s*\)$/.exec(condition)
  if (absent) return item?.[names[absent[1]] || absent[1]] === undefined
  const equal = /^([#\w]+)\s*=\s*(:\w+)$/.exec(condition)
  if (equal) {
    if (!Object.hasOwn(values, equal[2])) throw new Error('Missing expression value')
    return isDeepStrictEqual(comparableAttribute(item?.[names[equal[1]] || equal[1]]), comparableAttribute(values[equal[2]]))
  }
  throw new Error(`Unsupported condition expression: ${condition}`)
}

function decodeUpload(body, headers) {
  if (!String(headers['content-encoding'] || '').split(',').includes('aws-chunked')) return body
  const chunks = []
  let offset = 0
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) throw new Error('Incomplete aws-chunked header')
    const sizeText = body.subarray(offset, lineEnd).toString('ascii').split(';')[0]
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error('Invalid aws-chunked size')
    const size = Number.parseInt(sizeText, 16)
    if (size === 0) return Buffer.concat(chunks)
    const start = lineEnd + 2
    if (start + size + 2 > body.length || body.toString('ascii', start + size, start + size + 2) !== '\r\n') {
      throw new Error('Incomplete aws-chunked body')
    }
    chunks.push(body.subarray(start, start + size))
    offset = start + size + 2
  }
  throw new Error('Missing aws-chunked terminator')
}

/**
 * Narrow local AWS protocol fixture, not a production client or general emulator.
 * state.items: Map<slug, low-level DynamoDB item>.
 * state.objects: Map<key, {body: Buffer, contentType, cacheControl, versionId, etag}>.
 * state.requests: ordered protocol records, including failed requests; no credentials.
 * state.commits: successfully persisted complete metadata snapshots.
 * Fault controls affect one matching request. An ambiguous commit stores the item
 * before dropping the connection, modeling a lost successful response without retrying.
 */
async function startContentStore({
  bucket = 'atomic-test-bucket',
  table = 'atomic-test-articles',
  pageSize = 100,
} = {}) {
  const state = {
    items: new Map(),
    objects: new Map(),
    versions: new Map(),
    requests: [],
    commits: [],
    errors: [],
  }
  const uploadFailures = []
  const readFailures = []
  const commitFailures = []
  const commitBarriers = []
  const activeBarriers = new Set()
  let revalidationStatus = 200

  function seedObject(key, body, { contentType = 'application/octet-stream', cacheControl } = {}) {
    const bytes = Buffer.from(body)
    const object = {
      body: bytes,
      contentType,
      cacheControl,
      versionId: randomUUID(),
      etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
      lastModified: new Date().toISOString(),
    }
    state.objects.set(key, object)
    if (!state.versions.has(key)) state.versions.set(key, new Map())
    state.versions.get(key).set(object.versionId, object)
    return object
  }

  function seedArticle({ slug = 'atomic-article', revision = randomUUID(), body, assets = {}, item = {} } = {}) {
    const prefix = `articles/${slug}/revisions/${revision}/`
    const s3Key = `${prefix}page.mdx`
    seedObject(s3Key, body ?? '# Seeded published article\n', { contentType: 'text/mdx' })
    for (const [name, value] of Object.entries(assets)) {
      const asset = Buffer.isBuffer(value) || typeof value === 'string' ? { body: value } : value
      seedObject(`${prefix}${name}`, asset.body, {
        contentType: asset.contentType || 'application/octet-stream',
        cacheControl: asset.cacheControl || 'public,max-age=31536000,immutable',
      })
    }
    const metadata = {
      slug: { S: slug },
      title: { S: 'Seeded article' },
      description: { S: 'Local content fixture' },
      author: { S: 'Fixture author' },
      publishedAt: { S: '2026-01-15' },
      updatedAt: { S: '2026-01-15T00:00:00.000Z' },
      status: { S: 'PUBLISHED' },
      ...clone(item),
      s3Key: { S: s3Key },
    }
    state.items.set(slug, metadata)
    return { slug, s3Key, prefix, item: clone(metadata) }
  }

  function paginate(items, input) {
    const start = input.ExclusiveStartKey
      ? items.findIndex((item) => item.slug.S === input.ExclusiveStartKey.slug.S) + 1
      : 0
    const limit = Math.min(input.Limit || pageSize, pageSize)
    const page = items.slice(start, start + limit)
    return {
      Items: clone(page),
      Count: page.length,
      ScannedCount: page.length,
      ...(start + page.length < items.length && page.length
        ? { LastEvaluatedKey: { slug: clone(page[page.length - 1].slug) } }
        : {}),
    }
  }

  async function handleDynamo(request, response, rawBody) {
    const operation = String(request.headers['x-amz-target']).split('.').pop()
    const input = JSON.parse(rawBody.toString('utf8'))
    const record = { service: 'dynamodb', operation, input: clone(input) }
    state.requests.push(record)
    if (input.TableName !== table) return dynamoError(response, 'ResourceNotFoundException', 'Unknown fixture table')
    if (operation === 'DescribeTable') {
      return sendJson(response, 200, { Table: {
        TableStatus: 'ACTIVE', TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${table}`,
        TableId: 'local-migration-table', KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'slug', AttributeType: 'S' }],
      } })
    }
    if (operation === 'GetItem') {
      const item = state.items.get(input.Key.slug.S)
      return sendJson(response, 200, item ? { Item: clone(item) } : {})
    }
    if (operation === 'Scan') {
      if (input.FilterExpression || input.ProjectionExpression) throw new Error('Unsupported Scan expression')
      return sendJson(response, 200, paginate([...state.items.values()], input))
    }
    if (operation === 'Query') {
      if (input.IndexName !== 'byStatus' || input.FilterExpression) throw new Error('Unsupported Query shape')
      const items = [...state.items.values()].filter((item) => matchesCondition(
        input.KeyConditionExpression, item, input.ExpressionAttributeNames, input.ExpressionAttributeValues,
      )).sort((left, right) => left.publishedAt.S.localeCompare(right.publishedAt.S))
      if (input.ScanIndexForward === false) items.reverse()
      return sendJson(response, 200, paginate(items, input))
    }
    if (operation === 'UpdateItem') {
      const current = state.items.get(input.Key.slug.S)
      if (!input.ConditionExpression.split(' AND ').every(condition =>
        matchesCondition(condition, current, input.ExpressionAttributeNames, input.ExpressionAttributeValues))) {
        return dynamoError(response, 'ConditionalCheckFailedException', 'The conditional request failed')
      }
      const update = /^SET ([#\w]+) = (:\w+)$/.exec(input.UpdateExpression)
      if (!update || input.ReturnValues !== 'ALL_NEW') throw new Error('Unsupported fixture update')
      current[input.ExpressionAttributeNames[update[1]] || update[1]] = clone(input.ExpressionAttributeValues[update[2]])
      state.commits.push(clone(current))
      return sendJson(response, 200, { Attributes: clone(current) })
    }
    if (operation !== 'PutItem') throw new Error(`Unsupported DynamoDB operation: ${operation}`)
    const barrier = commitBarriers.shift()
    if (barrier) {
      barrier.reach(record)
      await barrier.pending
    }
    const failure = commitFailures.shift()
    if (failure?.mode === 'error') {
      record.outcome = 'error'
      return dynamoError(response, 'InternalServerError', 'Injected commit failure', 500)
    }
    const current = state.items.get(input.Item.slug.S)
    if (failure?.mode === 'conflict' || !matchesCondition(
      input.ConditionExpression, current, input.ExpressionAttributeNames, input.ExpressionAttributeValues,
    )) {
      record.outcome = 'conflict'
      return dynamoError(response, 'ConditionalCheckFailedException', 'The conditional request failed')
    }
    state.items.set(input.Item.slug.S, clone(input.Item))
    state.commits.push(clone(input.Item))
    record.outcome = failure?.mode === 'ambiguous' ? 'ambiguous' : 'committed'
    if (failure?.mode === 'ambiguous') {
      response.destroy()
      return
    }
    return sendJson(response, 200, {})
  }

  function handleS3(request, response, url, rawBody) {
    const pathname = decodeURIComponent(url.pathname)
    const prefix = `/${bucket}/`
    if (!pathname.startsWith(prefix) && pathname !== `/${bucket}`) {
      return s3Error(response, 'NoSuchBucket', 'Unknown fixture bucket', 404)
    }
    const key = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
    if (request.method === 'GET' && !key) {
      const bucketReply = (operation, body) => {
        state.requests.push({ service: 's3', operation })
        response.writeHead(200, { 'content-type': 'application/xml' })
        response.end(body)
      }
      if (url.searchParams.has('versioning')) {
        return bucketReply('GetBucketVersioning', '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>')
      }
      if (url.searchParams.has('location')) {
        return bucketReply('GetBucketLocation', '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></LocationConstraint>')
      }
      if (url.searchParams.has('acl')) {
        return bucketReply('GetBucketAcl', '<AccessControlPolicy><Owner><ID>local-fixture-owner</ID></Owner><AccessControlList></AccessControlList></AccessControlPolicy>')
      }
      if (url.searchParams.has('versions')) {
        const objectPrefix = url.searchParams.get('prefix') || ''
        const records = [...state.versions.entries()]
          .filter(([name]) => name.startsWith(objectPrefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([name, versions]) => [...versions.values()].reverse().map(object => ({ name, object })))
        const marker = url.searchParams.get('key-marker')
        const versionMarker = url.searchParams.get('version-id-marker')
        const start = marker ? records.findIndex(record => record.name === marker && record.object.versionId === versionMarker) + 1 : 0
        const page = records.slice(start, start + pageSize)
        const truncated = start + page.length < records.length
        const content = page.map(({ name, object }) =>
          `<Version><Key>${xml(name)}</Key><VersionId>${xml(object.versionId)}</VersionId><IsLatest>${state.objects.get(name)?.versionId === object.versionId}</IsLatest><LastModified>${object.lastModified}</LastModified><ETag>${xml(object.etag)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Version>`,
        ).join('')
        const last = page.at(-1)
        return bucketReply('ListObjectVersions', `<ListVersionsResult><Name>${xml(bucket)}</Name><Prefix>${xml(objectPrefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${content}${truncated ? `<NextKeyMarker>${xml(last.name)}</NextKeyMarker><NextVersionIdMarker>${xml(last.object.versionId)}</NextVersionIdMarker>` : ''}</ListVersionsResult>`)
      }
    }
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const objectPrefix = url.searchParams.get('prefix') || ''
      const after = url.searchParams.get('continuation-token') || ''
      const keys = [...state.objects.keys()].filter((value) => value.startsWith(objectPrefix) && value > after).sort()
      const limit = Math.min(Number(url.searchParams.get('max-keys') || pageSize), pageSize)
      const page = keys.slice(0, limit)
      state.requests.push({ service: 's3', operation: 'ListObjectsV2', prefix: objectPrefix })
      const contents = page.map((name) => {
        const object = state.objects.get(name)
        return `<Contents><Key>${xml(name)}</Key><Size>${object.body.length}</Size><ETag>${xml(object.etag)}</ETag><LastModified>2026-01-15T00:00:00.000Z</LastModified></Contents>`
      }).join('')
      const truncated = keys.length > page.length
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(objectPrefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(page[page.length - 1])}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`)
      return
    }
    if (!key) throw new Error(`Unsupported S3 bucket operation: ${request.method} ${url.search}`)
    const operation = { PUT: 'PutObject', GET: 'GetObject', HEAD: 'HeadObject' }[request.method]
    if (!operation) throw new Error(`Unsupported S3 operation: ${request.method}`)
    const record = { service: 's3', operation, key }
    state.requests.push(record)
    if (operation === 'PutObject') {
      record.ifNoneMatch = request.headers['if-none-match']
      record.ifMatch = request.headers['if-match']
      record.contentType = request.headers['content-type']
      record.cacheControl = request.headers['cache-control']
      const failureIndex = uploadFailures.findIndex((failure) => key.endsWith(`/${failure.name}`))
      if (failureIndex >= 0) {
        const [failure] = uploadFailures.splice(failureIndex, 1)
        record.outcome = 'error'
        return s3Error(response, failure.code, 'Injected upload failure', failure.status)
      }
      if (record.ifNoneMatch === '*' && state.objects.has(key)) {
        record.outcome = 'precondition-failed'
        return s3Error(response, 'PreconditionFailed', 'Object already exists', 412)
      }
      if (record.ifMatch !== undefined) {
        const current = state.objects.get(key)
        if (!current) {
          record.outcome = 'not-found'
          return s3Error(response, 'NoSuchKey', 'Object does not exist', 404)
        }
        if (record.ifMatch !== '*' && record.ifMatch !== current.etag) {
          record.outcome = 'precondition-failed'
          return s3Error(response, 'PreconditionFailed', 'Object ETag does not match', 412)
        }
      }
      const object = seedObject(key, decodeUpload(rawBody, request.headers), {
        contentType: record.contentType,
        cacheControl: record.cacheControl,
      })
      record.outcome = 'stored'
      response.writeHead(200, { etag: object.etag, 'x-amz-version-id': object.versionId })
      response.end()
      return
    }
    if (operation === 'GetObject') {
      if (request.headers.range !== undefined) record.range = request.headers.range
      const failureIndex = readFailures.findIndex((failure) => failure.key === key)
      if (failureIndex >= 0) {
        const [failure] = readFailures.splice(failureIndex, 1)
        record.outcome = 'error'
        return s3Error(response, failure.code, failure.message, failure.status)
      }
    }
    const versionId = url.searchParams.get('versionId')
    const object = versionId ? state.versions.get(key)?.get(versionId) : state.objects.get(key)
    if (!object) return s3Error(response, 'NoSuchKey', 'Object does not exist', 404)
    // Only a single explicit byte interval is supported; preserve full reads.
    if (operation === 'GetObject' && record.range !== undefined) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(record.range)
      const start = match ? Number(match[1]) : NaN
      const requestedEnd = match ? Number(match[2]) : NaN
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
          start > requestedEnd || start >= object.body.length) {
        return s3Error(response, 'InvalidRange', 'Requested range is not satisfiable', 416)
      }
      const end = Math.min(requestedEnd, object.body.length - 1)
      const body = object.body.subarray(start, end + 1)
      response.writeHead(206, {
        'content-type': object.contentType,
        'content-length': body.length,
        'content-range': `bytes ${start}-${end}/${object.body.length}`,
        etag: object.etag,
        'x-amz-version-id': object.versionId,
        ...(object.cacheControl ? { 'cache-control': object.cacheControl } : {}),
      })
      response.end(body)
      return
    }
    response.writeHead(200, {
      'content-type': object.contentType,
      'content-length': object.body.length,
      etag: object.etag,
      'x-amz-version-id': object.versionId,
      ...(object.cacheControl ? { 'cache-control': object.cacheControl } : {}),
    })
    response.end(operation === 'HeadObject' ? undefined : object.body)
  }

  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/api/revalidate' && request.method === 'POST') {
        state.requests.push({ service: 'site', operation: 'Revalidate', slug: url.searchParams.get('slug') })
        return sendJson(response, revalidationStatus, { revalidated: revalidationStatus === 200 })
      }
      if (request.headers['x-amz-target'] === 'AmazonSSM.GetParameter') {
        const input = JSON.parse(body.toString('utf8'))
        if (input.Name !== '/janeway/revalidate-secret' || input.WithDecryption !== true) {
          throw new Error('Unsupported fixture SSM parameter request')
        }
        state.requests.push({ service: 'ssm', operation: 'GetParameter', name: input.Name })
        return sendJson(response, 200, { Parameter: {
          Name: input.Name, Type: 'SecureString', Value: 'fixture-revalidation-secret', Version: 1,
        } })
      }
      if (request.headers['x-amz-target']) return await handleDynamo(request, response, body)
      return handleS3(request, response, url, body)
    } catch (error) {
      state.errors.push(error.message)
      if (!response.headersSent) return sendJson(response, 501, { message: error.message })
      response.destroy(error)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url,
    bucket,
    table,
    state,
    env: {
      ARTICLES_BUCKET: bucket,
      ARTICLES_TABLE: table,
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'fixture-access-key',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret-key',
      AWS_SESSION_TOKEN: 'fixture-session-token',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_ENDPOINT_URL: url,
      AWS_ENDPOINT_URL_S3: url,
      AWS_ENDPOINT_URL_DYNAMODB: url,
      AWS_ENDPOINT_URL_SSM: url,
      AWS_MAX_ATTEMPTS: '1',
      AWS_RETRY_MODE: 'standard',
    },
    seedObject,
    seedArticle,
    async readRevision(s3Key) {
      const prefix = s3Key.slice(0, s3Key.lastIndexOf('/') + 1)
      const names = [...state.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
      const files = {}
      for (const key of names) {
        const objectUrl = `${url}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
        const response = await fetch(objectUrl)
        if (!response.ok) throw new Error(`Fixture read failed: ${response.status} ${key}`)
        files[key.slice(prefix.length)] = Buffer.from(await response.arrayBuffer())
      }
      return files
    },
    failUpload(name = 'page.mdx', { status = 500, code = 'InternalError' } = {}) {
      uploadFailures.push({ name, status, code })
    },
    failRead(key, { status = 500, code = 'InternalError', message = 'Injected read failure' } = {}) {
      readFailures.push({ key, status, code, message })
    },
    failCommit({ mode = 'error' } = {}) {
      if (!['error', 'conflict', 'ambiguous'].includes(mode)) throw new Error(`Unknown commit failure mode: ${mode}`)
      commitFailures.push({ mode })
    },
    pauseNextCommit() {
      let reach
      let release
      const reached = new Promise((resolve) => { reach = resolve })
      const pending = new Promise((resolve) => { release = resolve })
      const barrier = { reach, pending, release }
      activeBarriers.add(barrier)
      commitBarriers.push(barrier)
      return {
        reached,
        release() {
          activeBarriers.delete(barrier)
          release()
        },
      }
    },
    setRevalidationStatus(status) {
      revalidationStatus = status
    },
    async close() {
      for (const barrier of activeBarriers) barrier.release()
      activeBarriers.clear()
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
}

module.exports = { startContentStore }
