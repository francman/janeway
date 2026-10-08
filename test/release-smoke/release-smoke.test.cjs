const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runSmoke } = require('../../scripts/release-smoke.cjs')
const { startFixture, sourceAliases, legacyDirectory, revisionDirectory, rawSourceMarker } = require('./fixture.cjs')

const enginePath = path.resolve(__dirname, '../../scripts/release-smoke.cjs')
const requiredChecks = [
  'home', 'writings', 'article-content', 'article-metadata', 'article-image',
  'source-boundary', 'missing-article', 'mobile-layout',
]

function check(result, name, status) {
  const entry = result.checks.find((candidate) => candidate.name === name)
  assert.ok(entry, `Missing check ${name}`)
  assert.equal(entry.status, status, `${name}: ${entry.detail}`)
}

async function artifacts(outDir, result) {
  const reportText = await readFile(path.join(outDir, 'report.json'), 'utf8')
  const summary = await readFile(path.join(outDir, 'summary.md'), 'utf8')
  const report = JSON.parse(reportText)
  assert.equal(report.status, result.status)
  assert.equal(reportText.includes(rawSourceMarker), false, 'Raw MDX body leaked into JSON evidence')
  assert.equal(summary.includes(rawSourceMarker), false, 'Raw MDX body leaked into summary evidence')
  for (const entry of result.checks) check(report, entry.name, entry.status)
  return report
}

function readonlyRequests(fixture) {
  assert.deepEqual(fixture.state.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)), [])
}

function passing(result, fixture) {
  assert.equal(result.status, 'passed', JSON.stringify(result.checks))
  for (const name of requiredChecks) check(result, name, 'passed')
  check(result, 'aws-configuration', 'skipped')
  assert.equal(result.checks.some((entry) => entry.status === 'failed'), false)
  readonlyRequests(fixture)
  for (const directory of [legacyDirectory, revisionDirectory]) {
    for (const alias of sourceAliases) {
      assert.ok(fixture.state.requests.some((request) => request.origin === 'cdn' && request.path === `${directory}/${alias}` && request.status === 403), `Source denial was not observed: ${directory}/${alias}`)
    }
  }
  assert.ok(fixture.state.requests.some((request) => request.path === `/writings/${fixture.config.article.slug}` && /twitterbot/i.test(request.userAgent)), 'Article metadata must be fetched with the crawler user agent')
}

function spawnCli(args, env, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 60000)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      children.delete(child)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      if (timedOut) reject(new Error(`CLI exceeded deadline: ${stderr}`))
      else resolve({ code, signal, stdout, stderr })
    })
  })
}

test('deployed public contract against real HTTP and Chromium', { timeout: 300000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'janeway-release-smoke-'))
  const children = new Set()
  let fixture
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL')
    try {
      if (fixture) await fixture.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  fixture = await startFixture()
  let runNumber = 0
  const options = (outDir) => ({
    siteUrl: fixture.siteUrl,
    cdnUrl: fixture.cdnUrl,
    config: fixture.config,
    outDir,
    appRevision: 'operator-supplied-app-review-context',
    infraRevision: 'operator-supplied-infra-review-context',
    timeoutMs: 10000,
  })

  async function run(fault = null) {
    fixture.reset(fault)
    const outDir = path.join(root, `run-${++runNumber}`)
    const result = await runSmoke(options(outDir))
    await artifacts(outDir, result)
    check(result, 'aws-configuration', 'skipped')
    readonlyRequests(fixture)
    return { result, outDir }
  }

  await t.test('healthy HTML, decoded image, denied source aliases and mobile layout pass', async () => {
    const { result } = await run()
    passing(result, fixture)
  })

  await t.test('bootstrap may replace server-rendered images before the page load completes', async () => {
    const { result } = await run('bootstrap-replaces-dom')
    passing(result, fixture)
  })

  const cases = [
    { name: 'homepage error shell cannot pass from a marker in script data', fault: 'home-error-shell', failed: 'home' },
    { name: 'HTTP 200 error shell is not article content', fault: 'error-shell', failed: 'article-content' },
    { name: 'wrong article Open Graph identity fails', fault: 'wrong-og-identity', failed: 'article-metadata' },
    { name: 'image content-type cannot disguise invalid image bytes', fault: 'invalid-image', failed: 'article-image' },
    { name: 'missing article HTTP 200 is a soft 404', fault: 'soft-404', failed: 'missing-article' },
    { name: 'loaded below-fold mobile image overlaps its title', fault: 'image-title-overlap', failed: 'mobile-layout' },
    { name: 'mobile horizontal viewport overflow fails', fault: 'horizontal-overflow', failed: 'mobile-layout' },
    { name: 'overlapping mobile cards fail even with separated images and titles', fault: 'cards-overlap', failed: 'mobile-layout' },
    { name: 'empty mobile list cannot vacuously pass geometry', fault: 'no-mobile-cards', failed: 'mobile-layout' },
    { name: 'source 404 is not an observed access denial', fault: 'source-not-found', failed: 'source-boundary' },
    ...[legacyDirectory, revisionDirectory].flatMap((directory) => sourceAliases.map((alias) => ({
      name: `exposed raw source fails: ${directory}/${alias}`,
      fault: `exposed-source:${directory}/${alias}`,
      failed: 'source-boundary',
      exposedPath: `${directory}/${alias}`,
    }))),
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      try {
        const { result } = await run(scenario.fault)
        assert.equal(result.status, 'failed', JSON.stringify(result.checks))
        check(result, scenario.failed, 'failed')
        if (scenario.exposedPath) {
          assert.ok(fixture.state.requests.some((request) => request.path === scenario.exposedPath && request.status === 200), 'The exposed source alias must actually be requested')
        }
      } finally {
        fixture.reset()
      }
    })
  }

  await t.test('restoring the healthy fixture passes again with fresh artifacts', async () => {
    const { result } = await run()
    passing(result, fixture)
  })

  await t.test('nonempty artifact directory is refused without networking or overwriting evidence', async () => {
    fixture.reset()
    const outDir = path.join(root, 'existing-evidence')
    await mkdir(outDir)
    const staleReport = '{"status":"passed","old":true}\n'
    const staleScreenshot = Buffer.from('prior screenshot evidence')
    await writeFile(path.join(outDir, 'report.json'), staleReport)
    await writeFile(path.join(outDir, 'mobile.png'), staleScreenshot)
    await assert.rejects(() => runSmoke(options(outDir)))
    assert.deepEqual(fixture.state.requests, [])
    assert.equal(await readFile(path.join(outDir, 'report.json'), 'utf8'), staleReport)
    assert.deepEqual(await readFile(path.join(outDir, 'mobile.png')), staleScreenshot)
  })

  await t.test('actual CLI exits one and writes failed artifacts for a broken article', async () => {
    fixture.reset('error-shell')
    try {
      const configPath = path.join(root, 'fixture-config.json')
      const outDir = path.join(root, 'cli-failure')
      await writeFile(configPath, JSON.stringify(fixture.config))
      // Only browser discovery/runtime variables are inherited, never credentials.
      const env = {
        SITE_URL: fixture.siteUrl,
        ARTICLES_IMAGE_CDN_URL: fixture.cdnUrl,
        APP_REVISION: 'operator-app-context',
        INFRA_REVISION: 'operator-infra-context',
      }
      for (const name of ['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
        if (process.env[name] !== undefined) env[name] = process.env[name]
      }
      const result = await spawnCli(['--config', configPath, '--out', outDir], env, children)
      assert.equal(result.signal, null, result.stderr)
      assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(rawSourceMarker), false)
      const report = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'))
      assert.equal(report.status, 'failed')
      check(report, 'article-content', 'failed')
      check(report, 'aws-configuration', 'skipped')
      await artifacts(outDir, report)
      readonlyRequests(fixture)
    } finally {
      fixture.reset()
    }
  })
})
