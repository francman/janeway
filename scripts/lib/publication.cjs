'use strict'

const { randomUUID } = require('node:crypto')
const { extname } = require('node:path')
const { PutObjectCommand } = require('@aws-sdk/client-s3')
const { GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb')
const { isRevisionKey } = require('../../src/lib/article-revision.js')

const contentTypes = {
  '.mdx': 'text/mdx; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
}

function validateFile(file) {
  if (!file || typeof file.name !== 'string' || file.name.includes('\\') ||
    file.name.split('/').some(part => !part || part.startsWith('.')) ||
    !Buffer.isBuffer(file.body)) {
    throw new Error(`Invalid revision file: ${file?.name ?? '(missing name)'}`)
  }
}

function revisionObjectInput({ bucket, prefix, file }) {
  validateFile(file)
  const slug = prefix.split('/')[1]
  if (!bucket || !isRevisionKey(slug, `${prefix}page.mdx`)) {
    throw new Error('Invalid immutable revision destination')
  }
  return {
    Bucket: bucket,
    Key: `${prefix}${file.name}`,
    Body: file.body,
    IfNoneMatch: '*',
    ContentType: file.contentType || contentTypes[extname(file.name).toLowerCase()] || 'application/octet-stream',
    CacheControl: /\.mdx$/i.test(file.name) ? 'private, no-store' : 'public,max-age=31536000,immutable',
  }
}

async function stageRevision({ s3, bucket, slug, files, revision = randomUUID() }) {
  const prefix = `articles/${slug}/revisions/${revision}/`
  const s3Key = `${prefix}page.mdx`
  if (!isRevisionKey(slug, s3Key)) throw new Error('Invalid article slug or revision UUID')
  if (!Array.isArray(files) || !files.some(file => file.name === 'page.mdx')) {
    throw new Error('A revision must contain page.mdx')
  }
  const names = new Set()
  for (const file of files) {
    validateFile(file)
    if (names.has(file.name)) throw new Error(`Duplicate revision file: ${file.name}`)
    names.add(file.name)
  }
  for (const file of files) {
    await s3.send(new PutObjectCommand(revisionObjectInput({ bucket, prefix, file })))
  }
  return { s3Key, prefix }
}

async function readCurrentItem({ ddb, table, slug }) {
  const response = await ddb.send(new GetItemCommand({
    TableName: table, Key: { slug: { S: slug } }, ConsistentRead: true,
  }))
  return response.Item
}

async function commitRevision({ ddb, table, item, expectedKey }) {
  const slug = item?.slug?.S
  if (!isRevisionKey(slug, item?.s3Key?.S)) throw new Error('Commit requires an immutable revision pointer')
  if (expectedKey !== null && !isRevisionKey(slug, expectedKey)) {
    throw new Error('Legacy or invalid current pointer: run the reviewed migration before publishing')
  }
  await ddb.send(new PutItemCommand({
    TableName: table,
    Item: item,
    ConditionExpression: expectedKey === null ? 'attribute_not_exists(#slug)' : '#key = :expected',
    ExpressionAttributeNames: expectedKey === null ? { '#slug': 'slug' } : { '#key': 's3Key' },
    ...(expectedKey === null ? {} : { ExpressionAttributeValues: { ':expected': { S: expectedKey } } }),
  }))
}

module.exports = { stageRevision, revisionObjectInput, readCurrentItem, commitRevision }
