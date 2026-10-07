'use strict'

const matter = require('gray-matter')
const { isRevisionKey } = require('../../src/lib/article-revision.js')

function parseArticle({ slug, source, s3Key, now }) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`invalid slug "${slug}" (must use lowercase words separated by hyphens)`)
  }
  if (!isRevisionKey(slug, s3Key)) throw new Error('Article metadata requires a revisioned s3Key')
  const { data } = matter(source)
  const norm = value => value instanceof Date ? value.toISOString().slice(0, 10) : value

  for (const key of ['title', 'description', 'author', 'date']) {
    const value = norm(data[key])
    if (!value || typeof value !== 'string') {
      throw new Error(`frontmatter missing required field: ${key}`)
    }
  }
  const status = String(norm(data.status) || 'PUBLISHED').toUpperCase()
  if (!['PUBLISHED', 'DRAFT'].includes(status)) {
    throw new Error(`invalid status "${status}" (must be PUBLISHED or DRAFT)`)
  }
  const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : []
  const item = {
    slug: { S: slug },
    title: { S: norm(data.title) },
    description: { S: norm(data.description) },
    author: { S: norm(data.author) },
    publishedAt: { S: norm(data.date) },
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
