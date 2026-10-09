export interface AdminConfig {
  origin: string
  authority: string
  clientId: string
  cognitoDomain: string
  apiUrl: string
}

function httpsOrigin(value: string | undefined): string {
  if (!value || value.trim() !== value) throw new Error('Invalid public configuration')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid public configuration')
  }
  return url.origin
}

export function readAdminConfig(): AdminConfig {
  const origin = httpsOrigin(process.env.NEXT_PUBLIC_ADMIN_ORIGIN)
  const cognitoDomain = httpsOrigin(process.env.NEXT_PUBLIC_COGNITO_DOMAIN)
  const apiUrl = httpsOrigin(process.env.NEXT_PUBLIC_ADMIN_API_URL)
  const authority = process.env.NEXT_PUBLIC_COGNITO_AUTHORITY
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID
  if (
    !authority || !/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[A-Za-z0-9]+$/.test(authority) ||
    !clientId || !/^[a-z0-9]{1,128}$/.test(clientId) ||
    !/^https:\/\/[a-z0-9-]+\.auth\.us-east-1\.amazoncognito\.com$/.test(cognitoDomain) ||
    !/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(apiUrl)
  ) throw new Error('Invalid public configuration')
  return { origin, authority, clientId, cognitoDomain, apiUrl }
}
