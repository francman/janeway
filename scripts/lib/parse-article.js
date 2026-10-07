'use strict'

const matter = require('gray-matter')
const { createRequire } = require('node:module')
const yaml = createRequire(require.resolve('gray-matter'))('js-yaml')
const { isRevisionKey } = require('../../src/lib/article-revision.js')

// Preserve YAML timestamp scalars: constructing a Date first would silently
// turn an impossible date such as February 30 into a valid date in March.
const timestamp = yaml.DEFAULT_SAFE_SCHEMA.compiledImplicit.find(type => type.tag === 'tag:yaml.org,2002:timestamp')
const schema = new yaml.Schema({
  include: [yaml.DEFAULT_SAFE_SCHEMA],
  implicit: [new yaml.Type(timestamp.tag, {
    kind: 'scalar',
    resolve: timestamp.resolve,
    construct: value => value,
  })],
})
const matterOptions = {
  engines: { yaml: source => yaml.safeLoad(source, { schema }) },
}

function parseArticle({ slug, source, s3Key, now }) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`invalid slug "${slug}" (must use lowercase words separated by hyphens)`)
  }
  if (!isRevisionKey(slug, s3Key)) throw new Error('Article metadata requires a revisioned s3Key')
  const { data } = matter(source, matterOptions)

  for (const key of ['title', 'description', 'author', 'date']) {
    const value = data[key]
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`frontmatter requires a nonblank string field: ${key}`)
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error('frontmatter date must be a valid calendar date in YYYY-MM-DD format')
  }
  const date = new Date(`${data.date}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== data.date) {
    throw new Error('frontmatter date must be a valid calendar date in YYYY-MM-DD format')
  }
  const status = String(data.status || 'PUBLISHED').toUpperCase()
  if (!['PUBLISHED', 'DRAFT'].includes(status)) {
    throw new Error(`invalid status "${status}" (must be PUBLISHED or DRAFT)`)
  }
  const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : []
  const item = {
    slug: { S: slug },
    title: { S: data.title },
    description: { S: data.description },
    author: { S: data.author },
    publishedAt: { S: data.date },
    updatedAt: { S: now },
    status: { S: status },
    s3Key: { S: s3Key },
  }
  if (tags.length) item.tags = { SS: tags }
  if (typeof data.coverImage === 'string' && data.coverImage) {
    item.coverImage = { S: data.coverImage }
  }
  return item
}

module.exports = { parseArticle }
