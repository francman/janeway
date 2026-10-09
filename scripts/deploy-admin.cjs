'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')
const run = promisify(execFile)
const root = path.resolve(__dirname, '..')
const release = path.join(root, 'out/admin-release')

async function aws(args) {
  try {
    const { stdout } = await run('aws', [...args, '--region', 'us-east-1', '--output', 'json'], { maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout)
  } catch {
    throw new Error(`AWS ${args[0]} ${args[1]} failed; inspect deployment state before retrying`)
  }
}
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Deploy only through the protected GitHub workflow')
  assert.equal(process.env.GITHUB_REPOSITORY, 'francman/janeway')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/admin-deploy')
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.revision, process.env.GITHUB_SHA, 'Artifact must match the approved workflow commit')
  assert.equal(manifest.origin, 'https://frank.frankmanu.com')
  const zip = path.join(release, 'site.zip')
  assert.equal(fs.statSync(zip).size, manifest.bytes)
  assert.equal(createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), manifest.sha256, 'Artifact digest mismatch')
  const appId = process.env.ADMIN_AMPLIFY_APP_ID
  assert.match(appId || '', /^d[a-z0-9]{1,19}$/)
  const identity = await aws(['sts', 'get-caller-identity'])
  assert.equal(identity.Account, '486207805298')
  assert.match(identity.Arn, /^arn:aws:sts::486207805298:assumed-role\/janeway-admin-deploy-role-us-east-1\//)
  const deployment = await aws(['amplify', 'create-deployment', '--app-id', appId, '--branch-name', 'production'])
  assert.match(deployment.jobId || '', /^\d+$/)
  console.log(JSON.stringify({ jobId: deployment.jobId, revision: manifest.revision, sha256: manifest.sha256 }))
  const url = new URL(deployment.zipUploadUrl)
  assert.equal(url.protocol, 'https:')
  assert.ok(url.hostname.endsWith('.amazonaws.com'))
  let upload
  try {
    upload = await fetch(url, { method: 'PUT', body: fs.createReadStream(zip), duplex: 'half', redirect: 'error', headers: { 'Content-Type': 'application/zip', 'Content-Length': String(manifest.bytes) } })
  } catch {
    throw new Error('Artifact upload outcome unknown; no signed deployment URL was logged. Inspect the recorded job before retrying.')
  }
  if (!upload.ok) throw new Error(`Artifact upload returned HTTP ${upload.status}; deployment was not started`)
  await upload.arrayBuffer()
  await aws(['amplify', 'start-deployment', '--app-id', appId, '--branch-name', 'production', '--job-id', deployment.jobId])
  const deadline = Date.now() + 10 * 60_000
  let previous
  while (Date.now() < deadline) {
    const { job } = await aws(['amplify', 'get-job', '--app-id', appId, '--branch-name', 'production', '--job-id', deployment.jobId])
    const status = job.summary.status
    if (status !== previous) console.log(JSON.stringify({ jobId: deployment.jobId, status }))
    previous = status
    if (status === 'SUCCEED') return
    if (['FAILED', 'CANCELLED'].includes(status)) throw new Error(`Amplify job ${deployment.jobId} ${status}`)
    await new Promise(resolve => setTimeout(resolve, 10000))
  }
  throw new Error(`Amplify job ${deployment.jobId} still unresolved after the observation window; do not assume failure or blindly redeploy`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
