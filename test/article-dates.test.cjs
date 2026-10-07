const test = require('node:test')
const assert = require('node:assert/strict')
const { parseArticle } = require('../scripts/lib/parse-article.js')

const slug = 'calendar-article'
const revision = '11111111-1111-4111-8111-111111111111'
const s3Key = `articles/${slug}/revisions/${revision}/page.mdx`
const now = '2026-10-07T12:34:56.000Z'

function sourceWith(fields = {}) {
  const metadata = {
    title: 'Calendar article',
    description: 'A deterministic metadata fixture',
    author: 'Article Author',
    date: '2024-02-29',
    ...fields,
  }
  return `---\n${Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n---\n\n# Article body\n`
}

function parse(fields, options = {}) {
  return parseArticle({ slug, s3Key, now, source: sourceWith(fields), ...options })
}

const dateForms = [
  ['unquoted', value => value],
  ['quoted', value => JSON.stringify(value)],
  ['explicit timestamp', value => `!!timestamp ${value}`],
]

for (const [label, scalar] of dateForms) {
  test(`accepts canonical ${label} dates without changing their calendar day`, () => {
    assert.equal(parse({ date: scalar('2024-02-29') }).publishedAt.S, '2024-02-29')
  })

  test(`rejects impossible ${label} dates before creating metadata`, () => {
    assert.throws(() => parse({ date: scalar('2024-02-30') }))
  })

  test(`rejects time-bearing ${label} dates instead of discarding the time`, () => {
    assert.throws(() => parse({ date: scalar('2024-02-29T00:00:00Z') }))
  })
}

test('validates Gregorian leap years and calendar ranges without a 1900 year offset', () => {
  for (const date of ['2000-02-29', '0096-02-29', '0099-12-31']) {
    assert.equal(parse({ date }).publishedAt.S, date)
  }
  for (const date of ['2023-02-29', '1900-02-29', '2100-02-29', '2024-04-31', '2024-00-10', '2024-13-10', '2024-01-00', '2024-01-32']) {
    assert.throws(() => parse({ date }))
  }
})

test('rejects noncanonical date formats', () => {
  for (const date of ['2024-2-29', '2024-02-9', '24-02-29', '02024-02-29', '02/29/2024', 'not-a-date']) {
    assert.throws(() => parse({ date }))
  }
})

test('rejects surrounding whitespace and multiline date values rather than normalizing them', () => {
  for (const date of ['" 2024-02-29"', '"2024-02-29 "', '"2024-02-29\\n"', '|\n  2024-02-29']) {
    assert.throws(() => parse({ date }))
  }
})

test('validates timestamp aliases without losing the original calendar scalar', () => {
  const source = date => `---
{title: Calendar article, description: Metadata fixture, author: Article Author, releaseDate: &release ${date}, date: *release}
---
# Article body
`
  assert.equal(parse(undefined, { source: source('2024-02-29') }).publishedAt.S, '2024-02-29')
  assert.throws(() => parse(undefined, { source: source('2024-02-30') }))
})

for (const key of ['title', 'description', 'author', 'date']) {
  test(`requires ${key} to be a nonblank string`, () => {
    for (const value of [undefined, '', 'null', '""', "''", '"   "', '"\\t\\n"', 'false', '42', '[]', '{}', '[text]']) {
      assert.throws(() => parse({ [key]: value }), undefined, String(value))
    }
  })
}


test('rejects invalid statuses, slugs and nonrevisioned or mismatched keys', () => {
  for (const status of ['scheduled', 'archived', '"   "', '42']) {
    assert.throws(() => parse({ status }))
  }
  for (const invalidSlug of ['', 'Calendar-article', 'calendar_article', '-calendar', 'calendar-', 'calendar--article', '../calendar']) {
    assert.throws(() => parse(undefined, { slug: invalidSlug }))
  }
  for (const invalidKey of [`articles/${slug}/page.mdx`, `articles/other-article/revisions/${revision}/page.mdx`, `articles/${slug}/revisions/invalid/page.mdx`]) {
    assert.throws(() => parse(undefined, { s3Key: invalidKey }))
  }
})
