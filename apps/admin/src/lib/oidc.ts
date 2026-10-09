import { Log, UserManager, type UserManagerSettings } from 'oidc-client-ts'
import { MemoryUserStore, TransactionStore } from './auth-storage'
import type { AdminConfig } from './config'

export interface AuthUser {
  access_token: string
  refresh_token?: string
  expires_at?: number
  token_type: string
  scope?: string
  profile: { sub: string; auth_time?: number; iss?: string; aud?: string | string[]; exp?: number }
}

export interface AuthPort {
  signIn(): Promise<void>
  callback(url: string): Promise<AuthUser>
  refresh(): Promise<AuthUser | null>
  clear(): void
  signOut(user: AuthUser | null): Promise<void>
}

export function oidcSettings(config: AdminConfig, transactions: TransactionStore, users: MemoryUserStore): UserManagerSettings {
  return {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${config.origin}/auth/callback/`,
    post_logout_redirect_uri: `${config.origin}/signed-out/`,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid email janeway-admin/access',
    disablePKCE: false,
    // Pin endpoint origins; no discovery response may redirect token-bearing calls.
    metadata: {
      issuer: config.authority,
      authorization_endpoint: `${config.cognitoDomain}/oauth2/authorize`,
      token_endpoint: `${config.cognitoDomain}/oauth2/token`,
      revocation_endpoint: `${config.cognitoDomain}/oauth2/revoke`,
      jwks_uri: `${config.authority}/.well-known/jwks.json`,
    },
    stateStore: transactions,
    userStore: users,
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    filterProtocolClaims: false,
    fetchRequestCredentials: 'omit',
    requestTimeoutInSeconds: 15,
    silentRequestTimeoutInSeconds: 15,
    staleStateAgeInSeconds: 600,
    redirectMethod: 'replace',
  }
}

export function createAuthPort(config: AdminConfig): AuthPort {
  Log.setLevel(Log.NONE)
  const transactions = new TransactionStore(window.sessionStorage)
  const users = new MemoryUserStore()
  const manager = new UserManager(oidcSettings(config, transactions, users))

  return {
    async signIn() {
      await transactions.clear()
      // oidc-client-ts generates state and the S256 PKCE verifier/challenge.
      // Code flow needs an explicit nonce to bind the returned ID token as well.
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
      await manager.signinRedirect({ nonce, prompt: 'login' })
    },
    async callback(url) {
      const callback = new URL(url)
      if (
        callback.origin !== config.origin || callback.pathname !== '/auth/callback/' || callback.hash ||
        callback.searchParams.getAll('state').length !== 1 || !callback.searchParams.get('state') ||
        callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code') ||
        callback.searchParams.has('error')
      ) {
        await transactions.clear()
        throw new Error('Invalid sign-in response')
      }
      try {
        return await manager.signinRedirectCallback(url)
      } finally {
        await transactions.clear()
      }
    },
    refresh: () => manager.signinSilent(),
    clear() {
      users.seal()
      manager.stopSilentRenew()
      void manager.removeUser().catch(() => {})
      void transactions.clear().catch(() => {})
    },
    async signOut(user) {
      // Cognito's logout endpoint clears its managed-login cookie; token
      // revocation is separate. Failure must not block local logout or navigation.
      if (user?.refresh_token) {
        try {
          await fetch(`${config.cognitoDomain}/oauth2/revoke`, {
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: config.clientId, token: user.refresh_token }),
            signal: AbortSignal.timeout(10_000),
          })
        } catch { /* The memory session is already gone; never restore it. */ }
      }
      const url = new URL('/logout', config.cognitoDomain)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('logout_uri', `${config.origin}/signed-out/`)
      window.location.replace(url.href)
    },
  }
}
