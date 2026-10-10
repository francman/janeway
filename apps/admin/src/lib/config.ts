export interface AdminConfig {
  origin: string
  authority: string
  clientId: string
  loginId: string
  poolId: string
  apiUrl: string
}

function httpsOrigin(value: string | undefined, allowLoopback = false): string {
  if (!value || value.trim() !== value) throw new Error('Invalid public configuration')
  const url = new URL(value)
  const loopback = allowLoopback && url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid public configuration')
  }
  return url.origin
}

export function readAdminConfig(): AdminConfig {
  const origin = httpsOrigin(process.env.NEXT_PUBLIC_ADMIN_ORIGIN, true)
  const apiUrl = httpsOrigin(process.env.NEXT_PUBLIC_ADMIN_API_URL)
  const authority = process.env.NEXT_PUBLIC_COGNITO_AUTHORITY
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID
  const loginId = process.env.NEXT_PUBLIC_COGNITO_LOGIN_ID
  if (
    !authority || !/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[A-Za-z0-9]+$/.test(authority) ||
    !clientId || !/^[a-z0-9]{1,128}$/.test(clientId) ||
    !loginId || loginId !== loginId.trim().toLowerCase() || loginId.length > 128 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId) ||
    !/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(apiUrl)
  ) throw new Error('Invalid public configuration')
  return { origin, authority, clientId, loginId, poolId: authority.slice(authority.lastIndexOf('/') + 1), apiUrl }
}
