const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')
const { startContentStore } = require('./helpers/content-store.cjs')

const root = path.resolve(__dirname, '..')

async function withReader(run) {
  const store = await startContentStore()
  const originalEnvironment = { ...process.env }
  Object.assign(process.env, store.env, { ARTICLES_IMAGE_CDN_URL: `${store.url}/${store.bucket}` })
  delete process.env.AWS_PROFILE
  const cached = new Map()
  function load(relative) {
    const filename = path.join(root, relative)
    const sourceRequire = createRequire(filename)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    const module = { exports: {} }
    const context = vm.createContext({ module, exports: module.exports, process, console,
      require(name) {
        if (name === 'next/cache') return { unstable_cache: (callback, keys) => async () => {
          const key = JSON.stringify(keys)
          if (!cached.has(key)) cached.set(key, Promise.resolve().then(callback))
          return cached.get(key)
        } }
        // Request-scoped React memoization is exercised by the real Next smoke.
        if (name === 'react') return { ...sourceRequire('react'), cache: callback => callback }
        if (name === '@/lib/article-revision') return sourceRequire(path.join(root, 'src/lib/article-revision.js'))
        return sourceRequire(name)
      },
    })
    new vm.Script(code, { filename }).runInContext(context)
    return module.exports
  }
  try {
    const articles = load('src/lib/articles.ts')
    const { mdxComponents } = load('src/components/mdx.tsx')
    await run({ store, articles, mdxComponents, expire: () => cached.clear() })
    assert.deepEqual(store.state.errors, [])
  } finally {
    await store.close()
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnvironment, key)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
  }
}

async function imageBytes(components) {
  const image = components.img({ src: './diagram.png', alt: 'Revision illustration' })
  const response = await fetch(image.props.src)
  assert.equal(response.status, 200)
  return { url: image.props.src, body: await response.text() }
}

test('old metadata and image closures keep their committed body/assets after a newer publish and cache expiry', async () => {
  await withReader(async ({ store, articles, mdxComponents, expire }) => {
    store.seedArticle({ slug: 'coherent-article', body: '# Original body', assets: { 'diagram.png': 'original image' }, item: { title: { S: 'Original title' } } })
    const original = await articles.getArticleBySlug('coherent-article')
    const originalImages = mdxComponents(original)
    assert.equal(await articles.getArticleMdx(original), '# Original body')
    assert.equal((await imageBytes(originalImages)).body, 'original image')

    store.seedArticle({ slug: 'coherent-article', body: '# Replacement body', assets: { 'diagram.png': 'replacement image' }, item: { title: { S: 'Replacement title' } } })
    expire()
    const replacement = await articles.getArticleBySlug('coherent-article')
    const replacementImages = mdxComponents(replacement)
    assert.equal(replacement.title, 'Replacement title')
    assert.equal(await articles.getArticleMdx(replacement), '# Replacement body')
    const replacementImage = await imageBytes(replacementImages)
    assert.equal(replacementImage.body, 'replacement image')

    // Force a cold old-body read, not merely a hit in the body cache.
    expire()
    assert.equal(original.title, 'Original title')
    assert.equal(await articles.getArticleMdx(original), '# Original body')
    const retainedImage = await imageBytes(originalImages)
    assert.equal(retainedImage.body, 'original image')
    assert.notEqual(retainedImage.url, replacementImage.url)
  })
})

test('a committed DRAFT is hidden while a previously cached published snapshot remains internally consistent', async () => {
  await withReader(async ({ store, articles, mdxComponents, expire }) => {
    store.seedArticle({ slug: 'draft-transition', body: '# Public body', assets: { 'diagram.png': 'public image' } })
    const publicSnapshot = await articles.getArticleBySlug('draft-transition')
    store.seedArticle({ slug: 'draft-transition', body: '# Private replacement', assets: { 'diagram.png': 'private image' }, item: { status: { S: 'DRAFT' } } })
    expire()
    assert.equal(await articles.getArticleBySlug('draft-transition'), null)
    assert.equal(JSON.stringify(await articles.getPublishedArticles()), '[]')
    assert.equal(await articles.getArticleMdx(publicSnapshot), '# Public body')
    assert.equal((await imageBytes(mdxComponents(publicSnapshot))).body, 'public image')
  })
})

for (const [label, invalidKey] of [
  ['legacy mutable prefix', 'articles/rejected-article/page.mdx'],
  ['another article revision', 'articles/different-article/revisions/11111111-1111-4111-8111-111111111111/page.mdx'],
]) {
  test(`rejects ${label} instead of reading an uncommitted body`, async () => {
    await withReader(async ({ store, articles, mdxComponents }) => {
      const seed = store.seedArticle({ slug: 'rejected-article', body: '# Valid committed body' })
      store.state.items.get(seed.slug).s3Key = { S: invalidKey }
      await assert.rejects(articles.getArticleBySlug(seed.slug))
      assert.throws(() => articles.getArticleMdx({ slug: seed.slug, s3Key: invalidKey }))
      assert.throws(() => mdxComponents({ slug: seed.slug, s3Key: invalidKey }))
    })
  })
}
