#!/usr/bin/env node
'use strict'

// Public, read-only deployment contract. No dotenv, credentials, AWS APIs, or
// deployed-SHA claims: supplied revisions are provenance for human review only.
const fs = require('node:fs/promises')
const path = require('node:path')
const cheerio = require('cheerio')

const CHECKS = [
  'home', 'writings', 'article-content', 'article-metadata', 'article-image',
  'source-boundary', 'missing-article', 'mobile-layout', 'aws-configuration',
]
const SOURCE_ALIASES = [
  'page.mdx', 'page.MdX', 'page.%6ddx', 'page%2emdx',
  'page.%256ddx', 'page%252emdx',
]
const BOT = 'Twitterbot/1.0'
const normalize = value => value.replace(/\s+/g, ' ').trim()

class ContractError extends Error {}
function requireThat(condition, message) {
  if (!condition) throw new ContractError(message)
}
function failureDetail(error) {
  // Browser/fetch exceptions can include response text, URLs, or headers. Only
  // our own invariant descriptions are safe to put in public CI artifacts.
  return error instanceof ContractError
    ? error.message
    : 'Operation failed: network/browser unavailable, timed out, or unusable response.'
}

function safeUrl(value) {
  requireThat(typeof value === 'string' && !/[?#]/.test(value), 'URL must not contain a query or fragment.')
  let url
  try { url = new URL(value) } catch { throw new ContractError('URL must be absolute.') }
  requireThat(!url.username && !url.password, 'URL must not contain credentials.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  requireThat(url.protocol === 'https:' || (url.protocol === 'http:' && loopback),
    'Only HTTPS public URLs or explicit HTTP loopback fixtures are allowed.')
  return url
}
function originUrl(value) {
  const url = safeUrl(value)
  requireThat(url.pathname === '/', 'Target and canonical URLs must be origins without a path.')
  return url.origin
}
function sitePath(origin, value) {
  requireThat(typeof value === 'string' && value.startsWith('/') && !value.startsWith('//'),
    'Configured page paths must be absolute paths on the site origin.')
  const url = safeUrl(new URL(value, origin).href)
  requireThat(url.origin === origin, 'Configured page path must stay on the site origin.')
  return url.href
}
function validateConfig(config, siteOrigin) {
  requireThat(config && typeof config === 'object', 'Smoke config must be an object.')
  originUrl(config.canonicalOrigin)
  for (const key of ['homepageMarker', 'writingsMarker']) {
    requireThat(typeof config[key] === 'string' && normalize(config[key]), `Config requires ${key}.`)
  }
  const article = config.article
  requireThat(article && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug), 'Config requires a safe article slug.')
  for (const key of ['title', 'description', 'author', 'publishedAt', 'bodyMarker', 'imageFilename']) {
    requireThat(typeof article[key] === 'string' && normalize(article[key]), `Config requires article.${key}.`)
  }
  requireThat(Number.isFinite(Date.parse(article.publishedAt)), 'Config requires a valid article publication date.')
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(article.imageFilename), 'Config requires an image filename, not a path.')
  sitePath(siteOrigin, config.missingPath)
  requireThat(config.mobile && typeof config.mobile === 'object', 'Config requires mobile layout selectors.')
  sitePath(siteOrigin, config.mobile.path)
  for (const key of ['cardSelector', 'imageSelector', 'titleSelector']) {
    requireThat(typeof config.mobile[key] === 'string' && config.mobile[key].trim(), `Config requires mobile.${key}.`)
  }
}

// Each request, including reading HTML, has one deadline. Redirects may only
// normalize a trailing slash on the same origin; source aliases never redirect.
async function publicRequest(url, timeoutMs, { html = false, redirects = true } = {}) {
  const original = safeUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let current = original
  try {
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetch(current, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': BOT, accept: html ? 'text/html' : '*/*' },
      })
      if (redirects && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        requireThat(location, 'Redirect is missing its destination.')
        const next = safeUrl(new URL(location, current).href)
        requireThat(next.origin === original.origin &&
          next.pathname.replace(/\/$/, '') === original.pathname.replace(/\/$/, ''),
        'Unexpected redirect target; only same-origin trailing-slash normalization is allowed.')
        current = next
        continue
      }
      const result = { status: response.status, url: current.href, headers: response.headers }
      if (html) {
        requireThat(/\btext\/html\b/i.test(response.headers.get('content-type') || ''), 'Expected an HTML response.')
        result.$ = cheerio.load(await response.text())
      } else {
        // Source responses are deliberately never read or emitted, even on 200.
        await response.body?.cancel()
      }
      return result
    }
    throw new ContractError('Too many redirects.')
  } finally {
    clearTimeout(timer)
  }
}
function expectStatus(response, status) {
  requireThat(response.status === status, `Expected HTTP ${status}; received HTTP ${response.status}.`)
}
function metaValues($, key) {
  return $('meta').filter((_, element) =>
    $(element).attr('name') === key || $(element).attr('property') === key,
  ).map((_, element) => $(element).attr('content') || '').get()
}
function exactMeta($, key, expected) {
  const values = metaValues($, key)
  requireThat(values.length > 0 && values.every(value => value === expected), `Metadata ${key} must match the configured article exactly.`)
}
function canonicalValues($) {
  return $('link').filter((_, element) =>
    ($(element).attr('rel') || '').toLowerCase().split(/\s+/).includes('canonical'),
  ).map((_, element) => $(element).attr('href') || '').get()
}

async function decodeImage(locator, timeoutMs) {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs })
  const decoded = await locator.evaluate(async (image, deadline) => {
    let timer
    try {
      return await Promise.race([
        image.decode().then(() => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).catch(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), deadline) }),
      ])
    } finally { clearTimeout(timer) }
  }, timeoutMs)
  requireThat(decoded, 'Rendered image did not decode into nonzero pixels before the deadline.')
}

async function screenshot(page, filename, outDir, report, timeoutMs) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
  await page.screenshot({ path: path.join(outDir, filename), fullPage: true, timeout: timeoutMs })
  report.screenshots.push(filename)
}

function markdown(report) {
  const escape = value => String(value).replace(/[|\r\n]/g, ' ')
  return [
    '# Public release smoke', '', `**Result: ${report.status.toUpperCase()}**`, '',
    ...(report.operationalError ? [`Operational failure: ${escape(report.operationalError)}`, ''] : []),
    `Site: ${report.siteUrl}`, `Article image CDN: ${report.cdnUrl}`, '',
    'This is a read-only public contract check, not deployed-revision attestation.',
    `Checker revision: ${escape(report.smokeRevision || 'not supplied')}`,
    `App revision (operator-supplied review context): ${escape(report.appRevision || 'not supplied')}`,
    `Infra revision (operator-supplied review context): ${escape(report.infraRevision || 'not supplied')}`, '',
    '| Check | Status | URL | Invariant / result |', '| --- | --- | --- | --- |',
    ...report.checks.map(check => `| ${check.name} | ${check.status} | ${escape(check.url || '')} | ${escape(check.detail)} |`), '',
    '## Source-boundary probes', '',
    ...report.sourceProbes.map(probe => `- ${probe.url}: ${probe.status === null ? 'request failed' : `HTTP ${probe.status}`}`), '',
    '## Screenshots', '', ...report.screenshots.map(file => `- [${file}](${file})`), '',
  ].join('\n')
}

async function runSmoke({ siteUrl, cdnUrl, config, outDir, appRevision, infraRevision, smokeRevision, timeoutMs = 15000 } = {}) {
  // Invalid input/nonempty output is a preflight error: do not overwrite prior
  // evidence or make network requests. Once accepted, every run writes reports.
  const siteOrigin = originUrl(siteUrl)
  const cdnOrigin = originUrl(cdnUrl)
  validateConfig(config, siteOrigin)
  requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'Timeout must be 1–120000 milliseconds.')
  requireThat(typeof outDir === 'string' && outDir.length > 0, 'A fresh output directory is required.')
  for (const revision of [appRevision, infraRevision, smokeRevision]) {
    requireThat(revision === undefined || typeof revision === 'string', 'Optional revisions must be strings.')
  }
  const outputDir = path.resolve(outDir)
  try {
    const entries = await fs.readdir(outputDir)
    requireThat(entries.length === 0, 'Output directory must be new or empty; existing evidence will not be overwritten.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.mkdir(outputDir, { recursive: true })
  }

  const articleUrl = `${siteOrigin}/writings/${config.article.slug}`
  const writingsUrl = `${siteOrigin}/writings`
  const missingUrl = sitePath(siteOrigin, config.missingPath)
  const mobileUrl = sitePath(siteOrigin, config.mobile.path)
  const canonical = `${originUrl(config.canonicalOrigin)}/writings/${config.article.slug}`
  const report = {
    status: 'failed', startedAt: new Date().toISOString(), siteUrl: siteOrigin, cdnUrl: cdnOrigin,
    appRevision: appRevision || null, infraRevision: infraRevision || null, smokeRevision: smokeRevision || null,
    revisionMeaning: 'App/infra revisions are operator-supplied review context, not observed deployed revisions.',
    checks: [], screenshots: [], sourceProbes: [],
  }
  const results = new Map()
  async function check(name, url, work) {
    try {
      const detail = await work()
      results.set(name, { name, status: 'passed', ...(url ? { url } : {}), detail })
    } catch (error) {
      results.set(name, { name, status: 'failed', ...(url ? { url } : {}), detail: failureDetail(error) })
    }
  }

  let browser
  let context
  let articlePage
  let articleReady = false
  let imageUrl
  let browserFailure = 'Browser is unavailable.'
  let unexpectedRedirect = false
  const imageResponses = new Map()
  try {
    await check('home', `${siteOrigin}/`, async () => {
      const response = await publicRequest(`${siteOrigin}/`, timeoutMs, { html: true })
      expectStatus(response, 200)
      requireThat(normalize(response.$('main h1').text()).includes(normalize(config.homepageMarker)), 'Homepage heading must contain the configured marker.')
      return 'HTTP 200 and homepage marker present; an older article need not remain on the homepage.'
    })
    await check('writings', writingsUrl, async () => {
      const response = await publicRequest(writingsUrl, timeoutMs, { html: true })
      expectStatus(response, 200)
      const $ = response.$
      requireThat(normalize($('main h1').text()).includes(normalize(config.writingsMarker)), 'Writings heading must contain the configured marker.')
      const found = $('a[href]').toArray().some(element => {
        if (normalize($(element).text()) !== normalize(config.article.title)) return false
        try { return new URL($(element).attr('href'), writingsUrl).href === articleUrl } catch { return false }
      })
      requireThat(found, 'Writings must link the configured title to the expected article URL.')
      return 'HTTP 200, writings marker, and expected article title link present.'
    })
    await check('article-metadata', articleUrl, async () => {
      const response = await publicRequest(articleUrl, timeoutMs, { html: true })
      expectStatus(response, 200)
      const $ = response.$
      const article = config.article
      const canonicals = canonicalValues($)
      requireThat(canonicals.length === 1 && canonicals[0] === canonical, 'Article must have exactly one canonical matching canonicalOrigin and its slug.')
      exactMeta($, 'description', article.description)
      exactMeta($, 'author', article.author)
      exactMeta($, 'og:url', canonical)
      exactMeta($, 'og:type', 'article')
      exactMeta($, 'og:title', article.title)
      exactMeta($, 'og:description', article.description)
      exactMeta($, 'article:author', article.author)
      exactMeta($, 'article:published_time', article.publishedAt)
      exactMeta($, 'twitter:card', 'summary')
      exactMeta($, 'twitter:title', article.title)
      exactMeta($, 'twitter:description', article.description)
      return 'Twitterbot initial HTML has the exact canonical, Open Graph article/date/author, and Twitter summary/title/description.'
    })
    await check('missing-article', missingUrl, async () => {
      const response = await publicRequest(missingUrl, timeoutMs, { html: true })
      expectStatus(response, 404)
      const $ = response.$
      const robots = [...metaValues($, 'robots'), response.headers.get('x-robots-tag') || ''].join(',')
      requireThat(/(?:^|[\s,;])noindex(?:$|[\s,;])/i.test(robots), 'Missing article must declare noindex.')
      requireThat(canonicalValues($).length === 0, 'Missing article must not have an article canonical.')
      requireThat(!metaValues($, 'og:type').includes('article'), 'Missing article must not declare Open Graph article type.')
      return 'HTTP 404, noindex, no canonical, and no Open Graph article type.'
    })

    try {
      const { chromium } = require('playwright')
      browser = await chromium.launch({ headless: true, timeout: timeoutMs })
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
      context.setDefaultTimeout(timeoutMs)
      context.setDefaultNavigationTimeout(timeoutMs)
      await context.routeWebSocket('**/*', socket => socket.close())
      await context.route('**/*', async route => {
        const request = route.request()
        let allowed = ['GET', 'HEAD'].includes(request.method())
        try {
          const url = new URL(request.url())
          allowed &&= !url.username && !url.password && [siteOrigin, cdnOrigin].includes(url.origin)
        } catch { allowed = false }
        if (!allowed) return route.abort('blockedbyclient')
        const headers = { ...request.headers() }
        delete headers.authorization
        delete headers['proxy-authorization']
        headers.cookie = ''
        let response
        try {
          // route.continue may let redirected requests bypass the route handler.
          // Fetch without redirects, then let Chromium render the real bytes.
          response = await route.fetch({ headers, maxRedirects: 0, timeout: timeoutMs })
          if ([301, 302, 303, 307, 308].includes(response.status())) {
            unexpectedRedirect = true
            await route.abort('blockedbyclient')
          } else {
            const responseHeaders = response.headers()
            delete responseHeaders['set-cookie']
            await route.fulfill({ response, headers: responseHeaders })
          }
        } catch {
          // The required navigation/image/layout checks observe failed loads.
          // Closing a page may itself abort an already-pending route.
          await route.abort('failed').catch(() => {})
        } finally {
          if (response) await response.dispose()
        }
      })
    } catch (error) {
      browserFailure = `Browser initialization failed. ${failureDetail(error)}`
      context = undefined
    }

    await check('article-content', articleUrl, async () => {
      requireThat(context, browserFailure)
      articlePage = await context.newPage()
      articlePage.on('response', response => imageResponses.set(response.url(), response.status()))
      const response = await articlePage.goto(articleUrl, { waitUntil: 'load' })
      requireThat(response && response.status() === 200, 'Rendered article navigation must return HTTP 200.')
      requireThat(new URL(articlePage.url()).origin === siteOrigin &&
        new URL(articlePage.url()).pathname.replace(/\/$/, '') === `/writings/${config.article.slug}`,
      'Rendered article navigation reached an unexpected URL.')
      articleReady = true
      await screenshot(articlePage, 'article.png', outputDir, report, timeoutMs)
      const title = articlePage.locator('h1').first()
      requireThat(await title.isVisible() && normalize(await title.innerText()) === normalize(config.article.title), 'Rendered article must have its expected visible h1 title.')
      const body = articlePage.locator('[data-mdx-content]').first()
      requireThat(await body.isVisible() && normalize(await body.innerText()).includes(normalize(config.article.bodyMarker)),
        'Rendered article body marker must be inside visible [data-mdx-content], not an error shell.')
      requireThat(!unexpectedRedirect, 'Browser encountered an unexpected redirect target.')
      return 'HTTP 200, visible article h1, and real rendered MDX body marker present.'
    })
    await check('article-image', articleUrl, async () => {
      requireThat(articleReady, 'Article browser navigation is unusable; image contract cannot be established.')
      const candidates = await articlePage.locator('[data-mdx-content] img').evaluateAll(images =>
        images.map(image => image.currentSrc || image.src),
      )
      let imageIndex = -1
      for (let index = 0; index < candidates.length; index++) {
        let candidate
        try { candidate = safeUrl(candidates[index]) } catch { continue }
        const prefix = `/articles/${config.article.slug}/revisions/`
        if (candidate.origin !== cdnOrigin || !candidate.pathname.startsWith(prefix)) continue
        const parts = candidate.pathname.slice(prefix.length).split('/')
        if (parts.length !== 2 || !/^[a-zA-Z0-9_-]+$/.test(parts[0]) || parts[1] !== config.article.imageFilename) continue
        imageUrl = candidate.href
        imageIndex = index
        break
      }
      requireThat(imageIndex >= 0, 'Rendered MDX must contain the configured CDN image under its immutable article revision.')
      const image = articlePage.locator('[data-mdx-content] img').nth(imageIndex)
      await decodeImage(image, timeoutMs)
      const renderedUrl = await image.evaluate(element => element.currentSrc || element.src)
      if (renderedUrl !== imageUrl) {
        imageUrl = undefined
        throw new ContractError('Rendered image URL changed while loading; immutable source provenance is unusable.')
      }
      report.articleImageUrl = imageUrl
      requireThat(imageResponses.get(imageUrl) === 200, 'Actual rendered article image must return HTTP 200.')
      requireThat(!unexpectedRedirect, 'Browser encountered an unexpected redirect target.')
      return 'Actual rendered immutable CDN image returned HTTP 200 and decoded into nonzero pixels.'
    })
    await check('source-boundary', imageUrl, async () => {
      requireThat(imageUrl, 'Actual rendered immutable image URL is unavailable; source boundary cannot be established.')
      const directories = [imageUrl.slice(0, imageUrl.lastIndexOf('/') + 1), `${cdnOrigin}/articles/${config.article.slug}/`]
      let failures = 0
      for (const directory of directories) {
        for (const alias of SOURCE_ALIASES) {
          const url = directory + alias
          try {
            const response = await publicRequest(url, timeoutMs, { redirects: false })
            report.sourceProbes.push({ url, status: response.status })
            if (response.status !== 403) failures++
          } catch {
            report.sourceProbes.push({ url, status: null })
            failures++
          }
        }
      }
      requireThat(failures === 0, `${failures} source probes did not return exactly HTTP 403; see sourceProbes (response bodies were not read).`)
      return 'Immutable and legacy MDX canonical, mixed-case, encoded extension/dot, and nested-encoded aliases all returned exactly HTTP 403.'
    })
    await check('mobile-layout', mobileUrl, async () => {
      requireThat(context, browserFailure)
      const page = await context.newPage()
      await page.setViewportSize({ width: 390, height: 844 })
      // Wait for bootstrap assets before resolving lazy-image elements; hydration
      // can replace the server-rendered DOM after DOMContentLoaded.
      const response = await page.goto(mobileUrl, { waitUntil: 'load' })
      requireThat(response && response.status() === 200, 'Mobile page navigation must return HTTP 200.')
      requireThat(new URL(page.url()).origin === siteOrigin &&
        new URL(page.url()).pathname.replace(/\/$/, '') === new URL(mobileUrl).pathname.replace(/\/$/, ''),
      'Mobile navigation reached an unexpected URL.')
      const cards = page.locator(config.mobile.cardSelector)
      const count = await cards.count()
      try {
        requireThat(count > 0, 'Mobile layout must have at least one card.')
        for (let cardIndex = 0; cardIndex < count; cardIndex++) {
          const images = cards.nth(cardIndex).locator(config.mobile.imageSelector)
          const imageCount = await images.count()
          requireThat(imageCount > 0, `Mobile card ${cardIndex + 1} must contain an image.`)
          for (let imageIndex = 0; imageIndex < imageCount; imageIndex++) {
            await decodeImage(images.nth(imageIndex), timeoutMs)
          }
        }
      } finally {
        // Capture after lazy images are decoded, but before asserting geometry;
        // a failing geometry check still leaves an actionable full-page artifact.
        await screenshot(page, 'mobile.png', outputDir, report, timeoutMs)
      }
      const layout = await page.evaluate(({ cardSelector, imageSelector, titleSelector }) => {
        const box = element => {
          const rect = element.getBoundingClientRect()
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        }
        return {
          viewportWidth: window.innerWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          cards: Array.from(document.querySelectorAll(cardSelector), card => ({
            box: box(card), images: Array.from(card.querySelectorAll(imageSelector), box),
            titles: Array.from(card.querySelectorAll(titleSelector), box),
          })),
        }
      }, config.mobile)
      report.mobileLayout = layout
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
      const visible = box => box.width > 0 && box.height > 0
      requireThat(layout.documentWidth <= layout.viewportWidth + 1, 'Mobile page must not overflow the viewport horizontally.')
      for (let index = 0; index < layout.cards.length; index++) {
        const card = layout.cards[index]
        requireThat(visible(card.box) && card.titles.length > 0 && card.titles.every(visible) && card.images.every(visible),
          `Mobile card ${index + 1} must have visible images and titles.`)
        requireThat(card.box.x >= -1 && card.box.right <= layout.viewportWidth + 1,
          `Mobile card ${index + 1} must fit within the viewport.`)
        requireThat([...card.images, ...card.titles].every(box => box.x >= -1 && box.right <= layout.viewportWidth + 1),
          `Mobile card ${index + 1} images and titles must fit within the viewport.`)
        requireThat(card.images.every(image => card.titles.every(title => !overlaps(image, title))),
          `Mobile card ${index + 1} images must not overlap titles.`)
        for (let other = index + 1; other < layout.cards.length; other++) {
          requireThat(!overlaps(card.box, layout.cards[other].box), `Mobile cards ${index + 1} and ${other + 1} must not overlap.`)
        }
      }
      requireThat(!unexpectedRedirect, 'Browser encountered an unexpected redirect target.')
      return `${count} cards at 390×844: every image decoded; no image/title overlap, card overlap, or horizontal viewport overflow.`
    })
  } catch (error) {
    report.operationalError = failureDetail(error)
  } finally {
    if (browser) {
      try { await browser.close() } catch { report.operationalError = 'Browser cleanup failed.' }
    }
  }
  if (unexpectedRedirect) report.operationalError = 'Browser attempted a redirect; redirects were blocked without following their targets.'

  results.set('aws-configuration', {
    name: 'aws-configuration', status: 'skipped',
    detail: 'Public-only run: AWS IAM/bucket permissions and deployed app/infra revisions were not inspected; no credentials or AWS APIs used.',
  })
  report.checks = CHECKS.map(name => results.get(name) || {
    name, status: 'failed', detail: 'Required prerequisite was unusable; this contract was not established.',
  })
  report.status = !report.operationalError && report.checks.every(item => item.status !== 'failed') ? 'passed' : 'failed'
  report.finishedAt = new Date().toISOString()
  report.summary = markdown(report)
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(path.join(outputDir, 'summary.md'), report.summary)
  return report
}

async function main() {
  const args = process.argv.slice(2)
  let configPath = path.join(__dirname, 'release-smoke.production.json')
  let outDir = 'out/release-smoke'
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    requireThat(['--config', '--out'].includes(argument) && args[index + 1], 'Usage: node scripts/release-smoke.cjs [--config FILE] [--out FRESH_DIRECTORY]')
    if (argument === '--config') configPath = args[++index]
    else outDir = args[++index]
  }
  requireThat(process.env.SITE_URL && process.env.ARTICLES_IMAGE_CDN_URL, 'SITE_URL and ARTICLES_IMAGE_CDN_URL are required.')
  let config
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')) } catch { throw new ContractError('Smoke config could not be read as JSON.') }
  const report = await runSmoke({
    siteUrl: process.env.SITE_URL, cdnUrl: process.env.ARTICLES_IMAGE_CDN_URL, config, outDir,
    appRevision: process.env.APP_REVISION, infraRevision: process.env.INFRA_REVISION, smokeRevision: process.env.SMOKE_REVISION,
  })
  console.log(report.summary)
  process.exitCode = report.status === 'passed' ? 0 : 1
}

module.exports = { runSmoke }
if (require.main === module) {
  main().catch(error => {
    console.error(`Release smoke failed: ${failureDetail(error)}`)
    process.exitCode = 1
  })
}
