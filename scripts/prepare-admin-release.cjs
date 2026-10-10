'use strict'

const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const cheerio = require('cheerio')

const root = path.resolve(__dirname, '..')
const exported = path.join(root, 'apps/admin/out')
const release = path.join(root, 'out/admin-release')
const revision = process.env.GITHUB_SHA || process.env.ADMIN_REVISION
if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Set ADMIN_REVISION to the reviewed full commit before packaging')
const origin = process.env.NEXT_PUBLIC_ADMIN_ORIGIN
if (origin !== 'https://frank.frankmanu.com') throw new Error('Production admin origin must be canonical')
const connections = ['NEXT_PUBLIC_COGNITO_AUTHORITY', 'NEXT_PUBLIC_ADMIN_API_URL'].map(name => {
  const url = new URL(process.env[name] || '')
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`)
  return url.origin
})
const hashes = new Set()
let htmlFiles = 0
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Static export must not contain symlinks')
    if (entry.isDirectory()) inspect(file)
    else if (entry.name.endsWith('.html')) {
      htmlFiles++
      const $ = cheerio.load(fs.readFileSync(file, 'utf8'))
      $('script:not([src])').each((_, element) => {
        const text = $(element).text()
        if (text) hashes.add(`'sha256-${createHash('sha256').update(text).digest('base64')}'`)
      })
    }
  }
}
inspect(exported)
if (!htmlFiles || !hashes.size) throw new Error('Expected a complete hydrated static Next export')
const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${[...new Set(connections)].join(' ')}`,
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')
const headers = {
  'Content-Security-Policy': csp,
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, nosnippet',
  'Cache-Control': 'no-store',
}
const yaml = 'customHeaders:\n  - pattern: "**"\n    headers:\n' + Object.entries(headers).map(([key, value]) => `      - key: ${JSON.stringify(key)}\n        value: ${JSON.stringify(value)}\n`).join('')
if (Buffer.byteLength(yaml) > 25000) throw new Error('Generated security headers exceed Amplify limits')
fs.writeFileSync(path.join(exported, 'customHttp.yml'), yaml)
fs.mkdirSync(release, { recursive: true })
const zip = path.join(release, 'site.zip')
fs.rmSync(zip, { force: true })
execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: exported, stdio: 'inherit' })
const manifest = {
  schemaVersion: 1,
  revision,
  origin,
  bytes: fs.statSync(zip).size,
  sha256: createHash('sha256').update(fs.readFileSync(zip)).digest('hex'),
  htmlFiles,
  inlineScriptHashes: hashes.size,
}
fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
