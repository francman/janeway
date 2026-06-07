#!/usr/bin/env node
/*
 * Reads the article frontmatter from MDX_PATH, validates it, and writes
 * shell-evalable exports (STATUS, ITEM_JSON) to stdout. Used by
 * publish-article.sh.
 *
 * Required env: SLUG, MDX_PATH, NOW.
 */
const fs = require('fs')
const matter = require('gray-matter')

const { data } = matter(fs.readFileSync(process.env.MDX_PATH, 'utf8'))
const norm = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)

const required = ['title', 'description', 'author', 'date']
for (const k of required) {
  const v = norm(data[k])
  if (!v || typeof v !== 'string') {
    process.stderr.write(`frontmatter missing required field: ${k}\n`)
    process.exit(1)
  }
}

const status = String(norm(data.status) || 'PUBLISHED').toUpperCase()
if (!['PUBLISHED', 'DRAFT'].includes(status)) {
  process.stderr.write(`invalid status "${status}" (must be PUBLISHED or DRAFT)\n`)
  process.exit(1)
}

const tags = Array.isArray(data.tags)
  ? data.tags.map((t) => String(t)).filter(Boolean)
  : []
const coverImage = typeof data.coverImage === 'string' ? data.coverImage : ''

const item = {
  slug: { S: process.env.SLUG },
  title: { S: norm(data.title) },
  description: { S: norm(data.description) },
  author: { S: norm(data.author) },
  publishedAt: { S: norm(data.date) },
  updatedAt: { S: process.env.NOW },
  status: { S: status },
  s3Key: { S: `articles/${process.env.SLUG}/page.mdx` },
}
if (tags.length) item.tags = { SS: tags }
if (coverImage) item.coverImage = { S: coverImage }

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
process.stdout.write(`STATUS=${sq(status)}\n`)
process.stdout.write(`ITEM_JSON=${sq(JSON.stringify(item))}\n`)
