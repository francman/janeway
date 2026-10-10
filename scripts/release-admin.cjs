'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const { readProfile, releaseContext } = require('./deploy-admin.cjs')
const root = path.resolve(__dirname, '..')

function step(command, args, env) {
  const { promise, resolve, reject } = Promise.withResolvers()
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', (code, signal) => {
    if (code === 0) resolve()
    else {
      const error = new Error(`${path.basename(command)} ${args[0]} failed${signal ? ` (${signal})` : ` (exit ${code})`}; release stopped`)
      error.exitCode = code || 1
      reject(error)
    }
  })
  return promise
}

async function main() {
  const profile = readProfile(process.argv.slice(2))
  const { env: publicConfig } = await releaseContext(profile)
  const env = { ...process.env, ...publicConfig }
  // The packaging helper must record local HEAD, never an inherited CI revision.
  delete env.GITHUB_SHA
  console.log('Releasing the current admin working tree; recorded HEAD is informational, not a cleanliness/approval gate.')
  await step('npm', ['run', 'build:admin'], env)
  await step(process.execPath, ['scripts/prepare-admin-release.cjs'], env)
  await step(process.execPath, ['scripts/deploy-admin.cjs', '--profile', profile], env)
  await step(process.execPath, ['scripts/smoke-admin-public.cjs'], env)
}

main().catch(error => { console.error(error.message); process.exitCode = error.exitCode || 1 })
