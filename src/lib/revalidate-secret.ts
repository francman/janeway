import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const region = process.env.AWS_REGION ?? 'us-east-1'
const paramName = process.env.REVALIDATE_SECRET_PARAM ?? '/janeway/revalidate-secret'

const ssm = new SSMClient({ region })

const CACHE_TTL_MS = 5 * 60 * 1000
let cached: { promise: Promise<string | null>; expiresAt: number } | null = null
let inFlight: Promise<string | null> | null = null

export function getRevalidateSecret(): Promise<string | null> {
  if (cached && performance.now() < cached.expiresAt) return cached.promise
  if (inFlight) return inFlight

  // An expired value must not authorize requests while its refresh is failing.
  cached = null
  const request = fetchSecret()
  inFlight = request.then(secret => {
    if (secret) {
      cached = { promise: request, expiresAt: performance.now() + CACHE_TTL_MS }
    }
    return secret
  }).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function fetchSecret(): Promise<string | null> {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    )
    return res.Parameter?.Value || null
  } catch {
    console.warn('[revalidate-secret] SSM fetch failed')
    return null
  }
}
