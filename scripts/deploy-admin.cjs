'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const fs = require('node:fs')
const path = require('node:path')
const run = promisify(execFile)
const root = path.resolve(__dirname, '..')
const release = path.join(root, 'out/admin-release')
const account = '486207805298'
const region = 'us-east-1'
const branch = 'production'

function readProfile(args) {
  assert.equal(args.length, 2, 'Usage: --profile PROFILE (an existing AWS SSO profile)')
  assert.equal(args[0], '--profile', 'Specify --profile explicitly')
  assert.ok(args[1] && !args[1].startsWith('-') && args[1].trim() === args[1], 'Invalid profile name')
  return args[1]
}

async function aws(profile, args) {
  try {
    const { stdout } = await run('aws', [...args, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager'], {
      cwd: root, maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_CLI_AUTO_PROMPT: 'off' },
    })
    return JSON.parse(stdout)
  } catch (error) {
    // Never echo AWS stdout/stderr: create-deployment can contain a signed URL.
    const code = error.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] || 'COMMAND_FAILED'
    throw new Error(`AWS ${args[0]} ${args[1]} failed (${code}); inspect deployment state before retrying`)
  }
}


async function releaseContext(profile) {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root })
  const revision = stdout.trim()
  const identity = await aws(profile, ['sts', 'get-caller-identity'])
  assert.equal(identity.Account, account, 'AWS profile must select the production account')
  const { Stacks: [stack] } = await aws(profile, ['cloudformation', 'describe-stacks', '--stack-name', 'JanewayAdminStack'])
  const outputs = Object.fromEntries((stack.Outputs || []).map(output => [output.OutputKey, output.OutputValue]))
  const appId = outputs.AdminAppId
  assert.match(appId || '', /^d[a-z0-9]{1,19}$/)
  const { app } = await aws(profile, ['amplify', 'get-app', '--app-id', appId])
  assert.equal(app.name, 'janeway-admin')
  assert.equal(app.platform, 'WEB')
  assert.ok(!app.repository, 'Admin app must remain Git-disconnected')
  assert.equal(outputs.ResumeStagingBucketName, `janeway-resume-staging-${account}-${region}`)
  assert.equal(outputs.WritingDraftsBucketName, `janeway-writing-drafts-${account}-${region}`)
  const loginId = process.env.NEXT_PUBLIC_COGNITO_LOGIN_ID || 'frankmanu500@gmail.com'
  assert.ok(loginId === loginId.trim().toLowerCase() && loginId.length <= 128 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId), 'Invalid public owner email alias')
  const env = {
    ADMIN_REVISION: revision,
    ADMIN_AMPLIFY_APP_ID: appId,
    NEXT_PUBLIC_ADMIN_ORIGIN: 'https://frank.frankmanu.com',
    NEXT_PUBLIC_COGNITO_AUTHORITY: `https://cognito-idp.${region}.amazonaws.com/${outputs.UserPoolId}`,
    NEXT_PUBLIC_COGNITO_CLIENT_ID: outputs.DashboardClientId,
    NEXT_PUBLIC_COGNITO_LOGIN_ID: loginId,
    NEXT_PUBLIC_ADMIN_API_URL: outputs.AdminApiUrl.replace(/\/$/, ''),
    NEXT_PUBLIC_RESUME_PREVIEW_ORIGIN: `https://${outputs.ResumeStagingBucketName}.s3.${region}.amazonaws.com`,
    NEXT_PUBLIC_WRITING_PREVIEW_ORIGIN: `https://${outputs.WritingDraftsBucketName}.s3.${region}.amazonaws.com`,
    ADMIN_API_URL: outputs.AdminApiUrl.replace(/\/$/, ''),
  }
  return { revision, appId, env }
}

async function main(profile) {
  const { appId } = await releaseContext(profile)
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.match(manifest.revision || '', /^[a-f0-9]{40}$/)
  const revision = manifest.revision
  assert.equal(manifest.origin, 'https://frank.frankmanu.com')
  const zip = path.join(release, 'site.zip')
  assert.equal(fs.statSync(zip).size, manifest.bytes)
  assert.equal(createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), manifest.sha256, 'Artifact digest mismatch')
  console.log(JSON.stringify({ account, region, appId, branch, revision, sha256: manifest.sha256 }))
  let deployment
  try {
    deployment = await aws(profile, ['amplify', 'create-deployment', '--app-id', appId, '--branch-name', branch])
  } catch (error) {
    throw new Error(`${error.message}; create outcome unknown, jobId unavailable. Inspect production list-jobs for app ${appId}; do not blindly retry.`)
  }
  if (!/^\d+$/.test(deployment.jobId || '')) {
    throw new Error(`Create outcome unknown, jobId unavailable. Inspect production list-jobs for app ${appId}; do not blindly retry.`)
  }
  const jobId = deployment.jobId
  console.log(JSON.stringify({ appId, branch, jobId, revision, sha256: manifest.sha256 }))
  try {
    const url = new URL(deployment.zipUploadUrl)
    assert.equal(url.protocol, 'https:')
    assert.ok(url.hostname.endsWith('.amazonaws.com'))
    assert.ok(!url.username && !url.password)
    const upload = await fetch(url, { method: 'PUT', body: fs.createReadStream(zip), duplex: 'half', redirect: 'error', headers: { 'Content-Type': 'application/zip', 'Content-Length': String(manifest.bytes) } })
    if (!upload.ok) throw new Error('Upload rejected')
    await upload.arrayBuffer()
  } catch {
    throw new Error(`Artifact upload failed or outcome unknown for job ${jobId}; no signed URL was logged. Inspect this job before retrying; deployment was not started.`)
  }
  try {
    await aws(profile, ['amplify', 'start-deployment', '--app-id', appId, '--branch-name', branch, '--job-id', jobId])
  } catch (error) {
    throw new Error(`${error.message}; start outcome unknown for job ${jobId}. Inspect this job, do not create another deployment.`)
  }
  const deadline = Date.now() + 10 * 60_000
  let previous
  while (Date.now() < deadline) {
    let job
    try {
      ;({ job } = await aws(profile, ['amplify', 'get-job', '--app-id', appId, '--branch-name', branch, '--job-id', jobId]))
    } catch (error) {
      throw new Error(`${error.message}; inspect job ${jobId}, do not redeploy.`)
    }
    const status = job.summary.status
    if (status !== previous) console.log(JSON.stringify({ jobId, status }))
    previous = status
    if (status === 'SUCCEED') return
    if (['FAILED', 'CANCELLED'].includes(status)) throw new Error(`Amplify job ${jobId} ${status}; inspect this job before any new release`)
    await delay(10000)
  }
  throw new Error(`Amplify job ${jobId} unresolved after the observation window; inspect this job, do not blindly redeploy`)
}

module.exports = { readProfile, releaseContext }
if (require.main === module) {
  Promise.resolve().then(() => main(readProfile(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
