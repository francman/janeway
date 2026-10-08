const http = require('node:http')
const { deflateSync } = require('node:zlib')

const slug = 'release-contract-fixture'
const revision = '18a0dad1-937a-4cd9-8bc4-1a0a16b0691b'
const imageFilename = 'cover.png'
const legacyDirectory = `/articles/${slug}`
const revisionDirectory = `${legacyDirectory}/revisions/${revision}`
const sourceAliases = [
  'page.mdx',
  'page.MdX',
  'page.%6ddx',
  'page%2emdx',
  'page.%256ddx',
  'page%252emdx',
]
const rawSourceMarker = 'PRIVATE_RAW_MDX_MUST_NOT_APPEAR_IN_ARTIFACTS'

// Encode an actual RGBA PNG, including CRCs, rather than an image-shaped payload.
function pngChunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, bytes, checksum])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(2, 0)
header.writeUInt32BE(2, 4)
header[8] = 8
header[9] = 6
const pixels = Buffer.from([
  0, 20, 120, 220, 255, 20, 120, 220, 255,
  0, 20, 120, 220, 255, 20, 120, 220, 255,
])
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(pixels)),
  pngChunk('IEND', Buffer.alloc(0)),
])

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

async function close(server) {
  if (!server.listening) return
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await closed
}

async function startFixture() {
  const state = { fault: null, requests: [] }
  let siteUrl
  let cdnUrl
  let config

  function respond(req, res, status, contentType, body, extra = {}) {
    state.requests.push({
      origin: req.socket.localPort === site.address()?.port ? 'site' : 'cdn',
      method: req.method,
      path: req.url.split('?')[0],
      userAgent: req.headers['user-agent'] || '',
      status,
    })
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...extra })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const cdn = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === `${revisionDirectory}/${imageFilename}`) {
      return respond(req, res, 200, 'image/png', state.fault === 'invalid-image' && !req.url.includes('?card=') ? Buffer.from('not an image') : png)
    }
    for (const directory of [legacyDirectory, revisionDirectory]) {
      for (const alias of sourceAliases) {
        if (pathname !== `${directory}/${alias}`) continue
        const exposed = state.fault === `exposed-source:${directory}/${alias}`
        const wrongDenial = state.fault === 'source-not-found'
        return respond(req, res, exposed ? 200 : wrongDenial ? 404 : 403, 'text/plain', exposed ? rawSourceMarker : 'Denied')
      }
    }
    return respond(req, res, 404, 'text/plain', 'Unknown fixture CDN path')
  })

  function document(body, metadata = '') {
    if (state.fault === 'bootstrap-replaces-dom') {
      metadata += '<style id="boot-style">img { animation: boot .1s infinite alternate; } @keyframes boot { to { transform: translateX(2px); } }</style><script async src="/bootstrap.js"></script>'
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Release fixture</title>${metadata}<style>
      * { box-sizing: border-box; } body { margin: 0; font: 16px sans-serif; }
      main { max-width: 900px; width: 100%; margin: auto; padding: 20px; }
      ul { list-style: none; margin: 0; padding: 0; } li { position: relative; padding: 16px; min-height: 280px; margin-bottom: 24px; border: 1px solid #ddd; }
      img { display: block; width: 128px; height: 128px; object-fit: cover; } h2 { margin: 16px 0 0; }
    </style></head><body><main>${body}</main></body></html>`
  }

  function articleMetadata() {
    const article = config.article
    const canonical = `${siteUrl}/writings/${slug}`
    const ogUrl = state.fault === 'wrong-og-identity' ? `${siteUrl}/writings/unrelated-article` : canonical
    return `<link rel="canonical" href="${canonical}">
      <meta name="description" content="${article.description}">
      <meta name="author" content="${article.author}">
      <meta property="og:type" content="article">
      <meta property="og:url" content="${ogUrl}">
      <meta property="og:title" content="${article.title}">
      <meta property="og:description" content="${article.description}">
      <meta property="article:published_time" content="${article.publishedAt}">
      <meta property="article:author" content="${article.author}">
      <meta name="twitter:card" content="summary">
      <meta name="twitter:title" content="${article.title}">
      <meta name="twitter:description" content="${article.description}">`
  }

  const site = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === '/bootstrap.js') {
      setTimeout(() => respond(req, res, 200, 'application/javascript', "const main = document.querySelector('main'); main.replaceWith(main.cloneNode(true)); document.querySelector('#boot-style').remove();"), 500)
      return
    }
    if (pathname === '/') {
      const content = state.fault === 'home-error-shell'
        ? `<h1>Something went wrong</h1><script type="application/json">${JSON.stringify({ stale: config.homepageMarker })}</script>`
        : `<h1>${config.homepageMarker}</h1><a href="/writings">Writings</a>`
      return respond(req, res, 200, 'text/html', document(content))
    }
    if (pathname === '/writings') {
      return respond(req, res, 200, 'text/html', document(`<h1>${config.writingsMarker}</h1><ul><li><a href="/writings/${slug}">${config.article.title}</a></li></ul>`))
    }
    if (pathname === `/writings/${slug}`) {
      const content = state.fault === 'error-shell'
        ? '<h1>Something went wrong</h1><p>Please try again later.</p>'
        : `<h1>${config.article.title}</h1><div data-mdx-content><p>${config.article.bodyMarker}</p><img src="${cdnUrl}${revisionDirectory}/${imageFilename}" alt="Fixture article illustration" width="128" height="128"></div>`
      return respond(req, res, 200, 'text/html', document(content, articleMetadata()))
    }
    if (pathname === config.missingPath) {
      return respond(req, res, state.fault === 'soft-404' ? 200 : 404, 'text/html', document('<h1>Article not found</h1>', '<meta name="robots" content="noindex, nofollow">'))
    }
    if (pathname === config.mobile.path) {
      const faultStyle = state.fault === 'image-title-overlap'
        ? '<style>li:last-child.image-loaded img { position: absolute; top: 16px; left: 16px; } li:last-child.image-loaded h2 { margin-top: 0; }</style>'
        : state.fault === 'horizontal-overflow' ? '<style>li { width: calc(100vw + 80px); }</style>'
          : state.fault === 'cards-overlap' ? '<style>li + li { margin-top: -120px; }</style>' : ''
      const cards = state.fault === 'no-mobile-cards' ? '' : Array.from({ length: 4 }, (_, index) =>
        `<li><img loading="lazy" onload="this.closest('li').classList.add('image-loaded')" src="${cdnUrl}${revisionDirectory}/${imageFilename}?card=${index}" alt="Reading ${index}" width="128" height="128"><h2>Fixture reading ${index + 1}</h2><p>A complete reading card.</p></li>`,
      ).join('')
      return respond(req, res, 200, 'text/html', document(`${faultStyle}<h1>Readings</h1><ul role="list">${cards}</ul>`))
    }
    return respond(req, res, 404, 'text/plain', 'Unknown fixture site path')
  })

  try {
    cdnUrl = await listen(cdn)
    siteUrl = await listen(site)
    config = {
      canonicalOrigin: siteUrl,
      homepageMarker: 'Public fixture home',
      writingsMarker: 'Fixture writings',
      article: {
        slug,
        title: 'A complete deployed article',
        description: 'The public release fixture article description.',
        author: 'Release Fixture Author',
        publishedAt: '2026-01-15T00:00:00.000Z',
        bodyMarker: 'This paragraph proves the real MDX body rendered.',
        imageFilename,
      },
      missingPath: '/writings/release-smoke-not-found',
      mobile: { path: '/readings', cardSelector: 'main ul[role="list"] > li', imageSelector: 'img', titleSelector: 'h2' },
    }
  } catch (error) {
    await Promise.all([close(site), close(cdn)])
    throw error
  }

  return {
    siteUrl,
    cdnUrl,
    config,
    state,
    reset(fault = null) {
      state.fault = fault
      state.requests.length = 0
    },
    close: () => Promise.all([close(site), close(cdn)]),
  }
}

module.exports = { startFixture, sourceAliases, legacyDirectory, revisionDirectory, rawSourceMarker }
