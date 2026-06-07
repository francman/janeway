import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const region = process.env.AWS_REGION ?? 'us-east-1'
const paramName = process.env.REVALIDATE_SECRET_PARAM ?? '/janeway/revalidate-secret'

const ssm = new SSMClient({ region })

let cached: Promise<string | null> | null = null

export function getRevalidateSecret(): Promise<string | null> {
  if (!cached) cached = fetchSecret()
  return cached
}

async function fetchSecret(): Promise<string | null> {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    )
    return res.Parameter?.Value ?? null
  } catch (err) {
    console.warn('[revalidate-secret] SSM fetch failed:', err)
    return null
  }
}
