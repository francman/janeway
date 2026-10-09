'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const origin = 'https://frank.frankmanu.com'
const api = process.env.ADMIN_API_URL
async function main() {
  assert.match(api || '', /^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/)
  for (const route of ['/', '/auth/callback/', '/signed-out/', '/writings/', '/metrics/']) {
    const response = await fetch(origin + route, { redirect: 'manual' })
    assert.equal(response.status, 200, `${route} must serve a real static route`)
    assert.match(response.headers.get('content-type') || '', /text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    const csp = response.headers.get('content-security-policy') || ''
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /object-src 'none'/)
    const scripts = csp.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1] || ''
    assert.ok(scripts.includes("'self'"))
    assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"))
    const html = await response.text()
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/i.test(match[1]) || !match[2]) continue
      const hash = createHash('sha256').update(match[2].replace(/\r\n?/g, '\n')).digest('base64')
      assert.ok(scripts.includes(`'sha256-${hash}'`), `${route} hydration must be permitted by its exact script hash`)
    }
    console.log(JSON.stringify({ route, status: response.status, securityHeaders: 'passed' }))
  }
  for (const route of ['/v1/session', '/v1/resume']) {
    for (const authorization of [undefined, 'Bearer invalid']) {
      const response = await fetch(api + route, { headers: authorization ? { Authorization: authorization } : {}, redirect: 'manual' })
      assert.equal(response.status, 401, `${route} must reject ${authorization ? 'invalid' : 'missing'} authentication`)
      await response.arrayBuffer()
    }
    console.log(JSON.stringify({ route, anonymousAndInvalidToken: 401 }))
  }
  for (const requestOrigin of [origin, 'https://untrusted.invalid']) {
    const response = await fetch(api + '/v1/resume', { method: 'OPTIONS', headers: { Origin: requestOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
    const allowed = response.headers.get('access-control-allow-origin')
    if (requestOrigin === origin) assert.equal(allowed, origin)
    else assert.equal(allowed, null)
    await response.arrayBuffer()
  }
  console.log('Live static routes, hydration CSP, anonymous API denial and exact-origin CORS passed. Owner/MFA/session browser acceptance is separate.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
