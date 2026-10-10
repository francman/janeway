import { Amplify } from 'aws-amplify'
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito'
import { signIn, confirmSignIn, fetchAuthSession, resetPassword, confirmResetPassword, rememberDevice, type SignInOutput } from 'aws-amplify/auth'
import type { AdminConfig } from './config'
import type { OwnerSession } from './api'
import { DeviceStorage } from './device-storage'

export interface AuthUser {
  accessToken: string
  sub: string
  username: string
  authTime: number
  expiresAt: number
  issuer: string
  clientId: string
  scope: string
  deviceKey: string
  loginKind: string
}
export type AuthStep =
  | { kind: 'credentials' }
  | { kind: 'new-password'; attributes: string[] }
  | { kind: 'totp'; secret?: string; uri?: string }
  | { kind: 'reset-request' }
  | { kind: 'reset-confirm'; destination?: string }
  | { kind: 'done'; user: AuthUser }
export type AuthErrorCode = 'credentials' | 'code-mismatch' | 'code-expired' | 'transaction-expired' | 'password-policy' | 'rate-limit' | 'network' | 'unsupported' | 'device-confirmation' | 'trust-failed' | 'cancelled'
export class AuthFailure extends Error {
  constructor(readonly code: AuthErrorCode, readonly terminal = false) { super(code) }
}

// Map service classes, never display a raw exception (it may contain identity data).
export function authFailure(error: unknown, challenge = false): AuthFailure {
  if (error instanceof AuthFailure) return error
  const name = (error as { name?: string } | null)?.name
  if (name === 'CodeMismatchException') return new AuthFailure('code-mismatch')
  // Cognito also uses ExpiredCodeException for a TOTP already used in this time
  // window. Keep the transaction; request the NEXT code, not a new password login.
  if (name === 'ExpiredCodeException') return new AuthFailure('code-expired')
  if (name === 'ResourceNotFoundException') return new AuthFailure('device-confirmation', true)
  if (name === 'InvalidPasswordException' || name === 'PasswordHistoryPolicyViolationException') return new AuthFailure('password-policy')
  if (name === 'TooManyRequestsException' || name === 'LimitExceededException') return new AuthFailure('rate-limit')
  if (name === 'SignInException' || (challenge && name === 'NotAuthorizedException')) return new AuthFailure('transaction-expired', true)
  if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') return new AuthFailure('credentials')
  if (name === 'SoftwareTokenMFANotFoundException' || name === 'UserNotConfirmedException') return new AuthFailure('unsupported', true)
  return new AuthFailure('network')
}

export interface AuthPort {
  signIn(loginId: string, password: string): Promise<AuthStep>
  confirm(value: string, attributes?: Record<string, string>): Promise<AuthStep>
  reset(loginId: string): Promise<AuthStep>
  completeReset(loginId: string, code: string, password: string): Promise<void>
  refresh(): Promise<AuthUser>
  trust(user: AuthUser, session: OwnerSession): Promise<boolean>
  isTrusted(user: AuthUser): boolean
  forgetLocal(): void
  clear(forSignOut?: boolean): void
  restart(): void
  signOut(): Promise<void>
}

const sdk = { signIn, confirmSignIn, fetchAuthSession, resetPassword, confirmResetPassword, rememberDevice }
export type NativeSdk = typeof sdk
export interface AuthEnvironment {
  transactions: Pick<Storage, 'clear'>
  navigate(url: string): void
  transport: typeof fetch
}

// The provider and sign-in transaction are global SDK state. Install ONE store
// for the document and NEVER swap/reopen it while any async SDK write can exist.
// A terminal retry deliberately reloads the document via an explicit UI action.
export class NativeAuth implements AuthPort {
  private closed = false
  private loginId = ''
  private active: Promise<unknown> = Promise.resolve()

  constructor(private readonly config: AdminConfig, private readonly storage: DeviceStorage, private readonly environment: AuthEnvironment, private readonly api: NativeSdk = sdk) {
    this.environment.transactions.clear()
  }

  private clearTransactions(): void {
    try { this.environment.transactions.clear() }
    catch { /* Storage can become unavailable; never let it block sealing or navigation. */ }
  }

  private async run<T>(operation: () => Promise<T>, challenge = false): Promise<T> {
    if (this.closed) throw new AuthFailure('cancelled', true)
    // Serialize all SDK work, including rememberDevice's implicit session read.
    const work = this.active.then(async () => {
      if (this.closed) throw new AuthFailure('cancelled', true)
      try {
        const value = await operation()
        if (this.closed) throw new AuthFailure('cancelled', true)
        return value
      } finally {
        if (this.closed) this.clearTransactions()
      }
    })
    this.active = work.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.clear(); reject(new AuthFailure('network', true)) }, 30_000)
      })])
    } catch (error) { throw authFailure(error, challenge) }
    finally { clearTimeout(timer) }
  }

  private async user(forceRefresh = false): Promise<AuthUser> {
    const { tokens } = await this.api.fetchAuthSession({ forceRefresh })
    const token = tokens?.accessToken
    const claims = token?.payload
    if (!token || !claims || claims.token_use !== 'access' || typeof claims.username !== 'string' || typeof claims.device_key !== 'string') {
      throw new AuthFailure('device-confirmation', true)
    }
    // Amplify returns DONE even when its automatic ConfirmDevice failed.
    // A signed device_key alone does not prove successful confirmation.
    if (!this.storage.confirmed(claims.username, claims.device_key)) throw new AuthFailure('device-confirmation', true)
    return {
      accessToken: token.toString(), sub: String(claims.sub ?? ''), username: claims.username,
      authTime: Number(claims.auth_time), expiresAt: Number(claims.exp), issuer: String(claims.iss ?? ''),
      clientId: String(claims.client_id ?? ''), scope: String(claims.scope ?? ''),
      deviceKey: claims.device_key, loginKind: String(claims.janeway_login_kind ?? ''),
    }
  }

  private async step(output: SignInOutput): Promise<AuthStep> {
    const next = output.nextStep
    switch (next.signInStep) {
      case 'DONE': return { kind: 'done', user: await this.user() }
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': return { kind: 'new-password', attributes: next.missingAttributes ?? [] }
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE': return { kind: 'totp' }
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': return { kind: 'totp', secret: next.totpSetupDetails.sharedSecret, uri: next.totpSetupDetails.getSetupUri('Janeway', this.loginId).toString() }
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
        if (next.allowedMFATypes?.includes('TOTP')) return this.step(await this.api.confirmSignIn({ challengeResponse: 'TOTP' }))
        break
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
        if (next.allowedMFATypes?.includes('TOTP')) return this.step(await this.api.confirmSignIn({ challengeResponse: 'TOTP' }))
        break
      case 'RESET_PASSWORD': return { kind: 'reset-request' }
    }
    throw new AuthFailure('unsupported', true)
  }

  signIn(loginId: string, password: string): Promise<AuthStep> {
    return this.run(async () => {
      this.loginId = loginId.trim().toLowerCase()
      this.storage.hydrate(this.loginId)
      return this.step(await this.api.signIn({ username: this.loginId, password, options: { authFlowType: 'USER_SRP_AUTH' } }))
    })
  }
  confirm(value: string, attributes?: Record<string, string>): Promise<AuthStep> {
    return this.run(async () => this.step(await this.api.confirmSignIn({ challengeResponse: value, options: { userAttributes: attributes } })), true)
  }
  reset(loginId: string): Promise<AuthStep> {
    return this.run(async () => {
      this.loginId = loginId
      const result = await this.api.resetPassword({ username: loginId })
      return result.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE'
        ? { kind: 'reset-confirm', destination: result.nextStep.codeDeliveryDetails.destination }
        : { kind: 'credentials' }
    })
  }
  completeReset(loginId: string, code: string, password: string): Promise<void> {
    return this.run(async () => {
      await this.api.confirmResetPassword({ username: loginId, confirmationCode: code, newPassword: password })
      this.storage.forget()
    })
  }
  refresh(): Promise<AuthUser> { return this.run(() => this.user(true)) }
  isTrusted(user: AuthUser): boolean { return this.storage.isSaved(user.username, user.sub, user.deviceKey) }
  trust(user: AuthUser, session: OwnerSession): Promise<boolean> {
    return this.run(async () => {
      if (this.isTrusted(user)) return true
      if (!['fresh', 'new-password'].includes(user.loginKind)) throw new AuthFailure('trust-failed')
      try {
        await this.api.rememberDevice()
        if (this.closed) throw new AuthFailure('cancelled', true)
        this.storage.promote(user.username, this.loginId, session)
        return true
      } catch (error) {
        if (this.closed) throw new AuthFailure('cancelled', true)
        throw new AuthFailure('trust-failed')
      }
    })
  }
  forgetLocal(): void { this.storage.forget() }
  clear(forSignOut = false): void {
    this.closed = true
    this.storage.seal(forSignOut)
    this.loginId = ''
    this.clearTransactions()
  }
  restart(): void {
    this.clear()
    this.environment.navigate(`${this.config.origin}/`)
  }
  async signOut(): Promise<void> {
    this.clear(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // SDK requests cannot be cancelled. Wait only a bounded time for a refresh
      // already in flight; its sealed write can update the revocation-only cell.
      await Promise.race([this.active, new Promise<void>(resolve => { timer = setTimeout(resolve, 6_000) })])
      clearTimeout(timer)
      const token = this.storage.takeRevocationToken()
      if (token) {
        // Documented Cognito API, not an OAuth/hosted-login endpoint. SDK signOut
        // requires readable tokens; reopening its global store here is unsafe.
        await this.environment.transport(new URL(this.config.authority).origin, {
          method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
          headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.RevokeToken' },
          body: JSON.stringify({ ClientId: this.config.clientId, Token: token }), signal: AbortSignal.timeout(4_000),
        })
      }
    } catch { /* Revocation is attempted, never claimed as confirmed on failure. */ }
    finally {
      clearTimeout(timer)
      this.storage.takeRevocationToken()
      this.clearTransactions()
      this.environment.navigate('https://www.frankmanu.com/')
    }
  }
}

let installed: NativeAuth | undefined
export function createAuthPort(config: AdminConfig): AuthPort {
  if (installed) return installed
  let persistent: Storage | null = null
  try { persistent = window.localStorage } catch { /* Default sign-in needs no local storage. */ }
  const storage = new DeviceStorage(config, persistent)
  // configure() resets the singleton's storage. Inject immediately afterward,
  // synchronously and before ANY Auth API; never configure again in this tab.
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.poolId, userPoolClientId: config.clientId } } })
  cognitoUserPoolsTokenProvider.setKeyValueStorage(storage)
  installed = new NativeAuth(config, storage, { transactions: window.sessionStorage, navigate: url => window.location.replace(url), transport: fetch })
  return installed
}
