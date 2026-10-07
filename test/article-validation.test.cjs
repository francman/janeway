const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { startContentStore } = require('./helpers/content-store.cjs')

const publisher = path.resolve(__dirname, '../scripts/publish-article.sh')
const slug = 'validated-article'
const s3Key = `articles/${slug}/revisions/11111111-1111-4111-8111-111111111111/page.mdx`

function source(date = '2024-02-29', body = '# Valid article', status = 'PUBLISHED') {
  return `---\ntitle: Validated article\ndescription: Publication validation fixture\nauthor: Fixture Author\ndate: ${date}\nstatus: ${status}\n---\n\n${body}\n`
}

async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'janeway-validation-'))
  const store = await startContentStore()
  const directory = path.join(cwd, slug)
  await fs.mkdir(directory)
  const emptyConfig = path.join(cwd, 'empty-aws-config')
  await fs.writeFile(emptyConfig, '')
  const guard = path.join(cwd, 'deny-network.cjs')
  await fs.writeFile(guard, `const deny = () => process.exit(91)\nfor (const module of ['node:http', 'node:https']) { const transport = require(module); transport.request = deny; transport.get = deny }\nglobalThis.fetch = deny\n`)
  t.after(async () => {
    await store.close()
    await fs.rm(cwd, { recursive: true, force: true })
    assert.deepEqual(store.state.errors, [])
  })
  const env = {
    PATH: process.env.PATH,
    HOME: cwd,
    ...store.env,
    AWS_CONFIG_FILE: emptyConfig,
    AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
    ARTICLES_IMAGE_CDN_URL: 'https://cdn.example.invalid',
    SITE_URL: '',
  }
  async function run(mdx, validateOnly = false) {
    await fs.writeFile(path.join(directory, 'page.mdx'), mdx)
    const childEnv = { ...env }
    if (validateOnly) {
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ARTICLES_BUCKET', 'ARTICLES_TABLE']) delete childEnv[key]
      childEnv.NODE_OPTIONS = `--require=${guard}`
    }
    const child = spawn('/bin/bash', [publisher, directory, ...(validateOnly ? ['--validate-only'] : [])], {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
    })
  }
  return { cwd, store, directory, run }
}

for (const [label, mdx] of [
  ['the combined invalid-date and malformed-MDX fixture', source('not-a-date', 'Unclosed expression {')],
  ['an invalid date with valid MDX', source('not-a-date')],
  ['malformed MDX with a valid date', source('2024-02-29', 'Unclosed expression {')],
  ['an unsupported runtime component', source('2024-02-29', '<MissingArticleComponent />')],
  ['a JavaScript expression that the compiler would otherwise strip', source('2024-02-29', '{missingRuntimeValue}')],
  ['an inline JavaScript expression', source('2024-02-29', 'Visible text {1 + 1} that must not disappear.')],
  ['a JavaScript JSX attribute', source('2024-02-29', '<img src={\"./figure.png\"} />')],
  ['spread JSX attributes', source('2024-02-29', '<img {...{src: \"./figure.png\"}} />')],
  ['an import that the compiler would otherwise strip', source('2024-02-29', 'import Missing from "./missing.js"\n\n# Article')],
  ['an export that the compiler would otherwise strip', source('2024-02-29', 'export const value = 42\n\n# Article')],
  ['an impossible date on a DRAFT replacement', source('2024-02-30', '# Private replacement', 'DRAFT')],
]) {
  test(`rejects ${label} without contacting AWS or changing a published revision`, async t => {
    const { store, directory, run } = await setup(t)
    const old = store.seedArticle({ slug, body: '# Previously published', assets: { 'cover.png': 'original image' } })
    const originalFiles = await store.readRevision(old.s3Key)
    const before = store.state.requests.length
    const result = await run(mdx)
    assert.notEqual(result.code, 0, result.stdout)
    assert.equal(result.signal, null, result.stderr)
    assert.ok(result.stderr.includes(path.join(directory, 'page.mdx')), result.stderr)
    assert.deepEqual(store.state.requests.slice(before), [])
    assert.deepEqual(store.state.items.get(slug), old.item)
    assert.deepEqual(await store.readRevision(old.s3Key), originalFiles)
  })
}

test('reports both independent validation failures for the combined fixture', async () => {
  const { validateArticle } = await import('../scripts/lib/validate-article.mjs')
  await assert.rejects(validateArticle({ slug, source: source('not-a-date', 'Unclosed expression {'), s3Key, now: '2026-10-07T00:00:00Z' }), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    return true
  })
})

test('offline validation accepts supported content without credentials, environment loading, or network', async t => {
  const { cwd, store, run } = await setup(t)
  await fs.writeFile(path.join(cwd, '.env.local'), 'exit 92\n')
  const mdx = source('2024-02-29', '{/* Author comment */}\n\n| Feature | Result |\n| --- | --- |\n| GFM | Supported |\n\n```js\nconst value = 42\n```\n\n![Illustration](./figure.png)\n\n<img src=\"./literal.png\" alt=\"Literal JSX\" />\n\n<details open><summary>Details</summary>Visible details</details>')
  const result = await run(mdx, true)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { slug, valid: true, publishedAt: '2024-02-29', status: 'PUBLISHED' })
  assert.deepEqual(store.state.requests, [])
  const invalid = await run(source('2024-02-29', '<MissingArticleComponent />'), true)
  assert.notEqual(invalid.code, 0)
  assert.notEqual(invalid.code, 91, invalid.stderr)
  assert.notEqual(invalid.code, 92, invalid.stderr)
  assert.equal(invalid.signal, null)
  assert.deepEqual(store.state.requests, [])
})

test('a validated publication commits canonical metadata and the captured source bytes', async t => {
  const { store, run } = await setup(t)
  const mdx = source('2024-02-29', '# Accepted article\n\n~~Old text~~ and new text.')
  const result = await run(mdx)
  assert.equal(result.code, 0, result.stderr)
  const publication = JSON.parse(result.stdout)
  const item = store.state.items.get(slug)
  assert.equal(item.publishedAt.S, '2024-02-29')
  assert.equal(item.status.S, 'PUBLISHED')
  assert.equal(item.s3Key.S, publication.s3Key)
  assert.deepEqual(await store.readRevision(publication.s3Key), { 'page.mdx': Buffer.from(mdx) })
})

test('shared production rendering preserves GFM, code blocks, and revisioned Markdown images', async () => {
  const { compileMDX } = await import('next-mdx-remote/rsc')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { mdxComponents } = await import('../src/components/mdx.mjs')
  const { mdxRemoteOptions } = await import('../src/lib/mdx-options.mjs')
  const { content } = await compileMDX({
    source: source('2024-02-29', '| Feature | Result |\n| --- | --- |\n| GFM | Supported |\n\n```js\nconst value = 42\n```\n\n![Illustration](./figure.png)'),
    components: mdxComponents({ slug, s3Key }),
    options: mdxRemoteOptions,
  })
  const html = renderToStaticMarkup(content)
  assert.match(html, /<table>/)
  assert.match(html, /<th>Feature<\/th>/)
  assert.match(html, /<pre[^>]*><code[^>]*>[\s\S]*42[\s\S]*<\/code><\/pre>/)
  assert.ok(html.includes(`${s3Key.slice(0, -'page.mdx'.length)}figure.png`), html)
  assert.match(html, /alt="Illustration"/)
})
