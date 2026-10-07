#!/usr/bin/env node
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { S3Client } = require('@aws-sdk/client-s3')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm')
const { isRevisionKey } = require('../../src/lib/article-revision.js')
const { stageRevision, readCurrentItem, commitRevision } = require('./publication.cjs')

async function collectFiles(directory, relative = '') {
  const files = []
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Article symlinks are not supported: ${name}`)
    if (entry.isDirectory()) files.push(...await collectFiles(directory, name))
    else if (entry.isFile()) files.push({ name, body: await fs.readFile(path.join(directory, name)) })
    else throw new Error(`Unsupported article file: ${name}`)
  }
  return files
}

async function revalidate(slug, region) {
  const site = process.env.SITE_URL
  if (!site) return null
  try {
    let secret = process.env.REVALIDATE_SECRET
    if (!secret) {
      const ssm = new SSMClient({ region, maxAttempts: 1 })
      try {
        const result = await ssm.send(new GetParameterCommand({
          Name: process.env.REVALIDATE_SECRET_PARAM || '/janeway/revalidate-secret',
          WithDecryption: true,
        }))
        secret = result.Parameter?.Value
      } finally { ssm.destroy() }
    }
    if (!secret) throw new Error('No revalidation secret available')
    const url = new URL(`${site.replace(/\/$/, '')}/api/revalidate`)
    url.searchParams.set('slug', slug)
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await response.body?.cancel()
    return true
  } catch {
    console.error('Cache refresh failed after commit (non-fatal); the complete revision remains committed. Retry revalidation, not publication.')
    return false
  }
}

async function main(args = process.argv.slice(2)) {
  const validateOnly = args.length === 2 && args[1] === '--validate-only'
  if (!validateOnly && (![1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--expected-key'))) {
    throw new Error('usage: publish-article.sh <article-dir> [--validate-only | --expected-key <previous-s3Key|absent>]')
  }
  const directory = path.resolve(args[0])
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`Not an article directory: ${directory}`)
  const slug = path.basename(directory)
  const bucket = process.env.ARTICLES_BUCKET
  const table = process.env.ARTICLES_TABLE
  const region = process.env.AWS_REGION || 'us-east-1'
  const revision = randomUUID()
  const prefix = `articles/${slug}/revisions/${revision}/`
  const s3Key = `${prefix}page.mdx`
  // Capture bytes once: parsed metadata and uploaded MDX always describe the same snapshot.
  const files = await collectFiles(directory)
  const mdx = files.find(file => file.name === 'page.mdx')
  if (!mdx) throw new Error(`missing ${path.join(directory, 'page.mdx')}`)
  let item
  try {
    const { validateArticle } = await import('./validate-article.mjs')
    item = await validateArticle({ slug, source: mdx.body.toString('utf8'), s3Key, now: new Date().toISOString() })
  } catch (error) { throw new Error(`${path.join(directory, 'page.mdx')}: ${error.message}`) }
  if (validateOnly) {
    console.log(JSON.stringify({ slug, valid: true, publishedAt: item.publishedAt.S, status: item.status.S }))
    return
  }
  if (!bucket || !table) throw new Error('ARTICLES_BUCKET and ARTICLES_TABLE must be set')
  const requestedKey = args.length === 3 ? (args[2] === 'absent' ? null : args[2]) : undefined
  if (requestedKey !== undefined && requestedKey !== null && !isRevisionKey(slug, requestedKey)) {
    throw new Error('--expected-key must be this article\'s immutable pointer or "absent"')
  }
  // Mutating requests are not automatically retried after ambiguous network failures.
  const s3 = new S3Client({ region, maxAttempts: 1 })
  const ddb = new DynamoDBClient({ region, maxAttempts: 1 })
  let expectedKey
  let phase = 'preflight'
  try {
    const previous = await readCurrentItem({ ddb, table, slug })
    expectedKey = previous ? previous.s3Key?.S : null
    if (previous && !isRevisionKey(slug, expectedKey)) {
      throw new Error('Legacy or invalid current pointer: freeze publishing and run the reviewed revision migration first')
    }
    if (requestedKey !== undefined && requestedKey !== expectedKey) {
      throw new Error(`Publication conflict: expected ${requestedKey ?? 'absent'}, current pointer is ${expectedKey ?? 'absent'}. No files uploaded.`)
    }
    phase = 'staging'
    console.error(`Staging immutable revision s3://${bucket}/${prefix}`)
    await stageRevision({ s3, bucket, slug, files, revision })
    phase = 'commit'
    await commitRevision({ ddb, table, item, expectedKey })
    phase = 'committed'
    const revalidated = await revalidate(slug, region)
    console.log(JSON.stringify({ slug, s3Key, previousKey: expectedKey, status: item.status.S, committed: true, revalidated }))
  } catch (error) {
    if (phase === 'staging' || phase === 'commit') {
      const conflict = error.name === 'ConditionalCheckFailedException'
      console.error(`Staged prefix: s3://${bucket}/${prefix}`)
      console.error(`Original expected key: ${expectedKey ?? 'absent'}`)
      console.error(phase === 'staging' || conflict
        ? 'This attempt did not commit. The previous committed revision was not modified.'
        : 'Commit outcome is uncertain. Inspect the current DynamoDB s3Key before retrying; retain this revision if it may have committed.')
      const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"
      console.error(`Guarded retry after inspecting state: ./scripts/publish-article.sh ${quote(directory)} --expected-key ${quote(expectedKey ?? 'absent')}`)
      if (conflict) throw new Error('Publication conflict: another writer changed the article. Do not rebase or overwrite it automatically.')
    }
    throw error
  } finally {
    s3.destroy()
    ddb.destroy()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
