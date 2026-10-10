import { ApiError, ownerRequest, parseResume, parseSession, type DeviceErrorCode, type OwnerSession, type ResumeMetadata } from './api'
import type { AdminConfig } from './config'
import { AuthFailure, authFailure, type AuthErrorCode, type AuthPort, type AuthStep, type AuthUser } from './auth'

export type SessionStatus = 'loading' | 'login' | 'verifying' | 'authenticated' | 'signing-out' | 'expired' | 'denied' | 'unavailable' | 'error'
export interface SessionSnapshot {
  status: SessionStatus
  session: OwnerSession | null
  resume: ResumeMetadata | null
  resumeStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  flow: Exclude<AuthStep, { kind: 'done' }>
  authBusy: boolean
  authError?: AuthErrorCode
  notice?: 'password-reset' | 'trust-failed'
  deviceTrusted: boolean
  deviceStatus: 'idle' | 'forgetting' | 'error'
  deviceError?: DeviceErrorCode
  requestId?: string
}

const MAX_SESSION_SECONDS = 8 * 60 * 60
const REFRESH_LEAD_SECONDS = 60
export const initialSnapshot: SessionSnapshot = {
  status: 'loading', session: null, resume: null, resumeStatus: 'idle', flow: { kind: 'credentials' },
  authBusy: false, deviceTrusted: false, deviceStatus: 'idle',
}

export class OwnerSessionClient {
  private snapshot: SessionSnapshot = initialSnapshot
  private readonly listeners = new Set<() => void>()
  private user: AuthUser | null = null
  private generation = 0
  private deadline = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshing: Promise<AuthUser> | null = null
  private checking: Promise<void> | null = null
  private loadingResume: Promise<void> | null = null
  private trustRequested = false
  private readonly requests = new Set<AbortController>()

  constructor(
    private readonly config: AdminConfig,
    private readonly auth: AuthPort,
    private readonly transport: typeof fetch = fetch,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {}

  getSnapshot = (): SessionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(update: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  clear(status: SessionStatus, requestId?: string, deviceError?: DeviceErrorCode): void {
    this.generation++
    this.user = null
    this.deadline = 0
    this.trustRequested = false
    clearTimeout(this.timer)
    for (const request of this.requests) request.abort()
    this.requests.clear()
    this.auth.clear(status === 'signing-out')
    this.snapshot = { ...initialSnapshot, status, requestId, deviceError }
    for (const listener of this.listeners) listener()
  }

  start(): void {
    if (this.snapshot.status === 'loading') this.publish({ status: 'login' })
  }
  restart(freshMfa = false): void {
    if (freshMfa) this.auth.forgetLocal()
    this.clear('loading')
    this.auth.restart()
  }
  cancel(): void { this.restart() }

  async signIn(loginId: string, password: string, trust: boolean): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || this.snapshot.flow.kind !== 'credentials') return
    this.trustRequested = trust
    await this.authenticate(() => this.auth.signIn(loginId, password))
  }
  async confirm(value: string, attributes?: Record<string, string>): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || !['totp', 'new-password'].includes(this.snapshot.flow.kind)) return
    await this.authenticate(() => this.auth.confirm(value, attributes), true)
  }
  beginRecovery(): void {
    if (this.snapshot.status === 'login' && !this.snapshot.authBusy && this.snapshot.flow.kind === 'credentials') {
      this.publish({ flow: { kind: 'reset-request' }, authError: undefined, notice: undefined })
    }
  }
  async resetPassword(loginId: string): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || !['reset-request', 'reset-confirm'].includes(this.snapshot.flow.kind)) return
    await this.authenticate(() => this.auth.reset(loginId))
  }
  async completeReset(loginId: string, code: string, password: string): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || this.snapshot.flow.kind !== 'reset-confirm') return
    await this.authenticate(async () => {
      await this.auth.completeReset(loginId, code, password)
      return { kind: 'credentials' }
    })
    if (this.getSnapshot().status === 'login' && this.getSnapshot().flow.kind === 'credentials') this.publish({ notice: 'password-reset' })
  }

  private async authenticate(operation: () => Promise<AuthStep>, challenge = false): Promise<void> {
    const generation = this.generation
    this.publish({ authBusy: true, authError: undefined, notice: undefined })
    try {
      const result = await operation()
      if (generation !== this.generation) return
      clearTimeout(this.timer)
      if (result.kind === 'done') {
        this.validateUser(result.user)
        this.user = result.user
        this.deadline = Math.min(this.now() + MAX_SESSION_SECONDS, result.user.authTime + MAX_SESSION_SECONDS)
        this.publish({ status: 'verifying', flow: { kind: 'credentials' }, authBusy: false })
        await this.checkSession()
      } else {
        this.publish({ flow: result, authBusy: false })
        if (result.kind === 'totp' || result.kind === 'new-password') {
          this.timer = setTimeout(() => {
            this.clear('error')
            this.publish({ authError: 'transaction-expired' })
          }, 3 * 60 * 1000)
        }
      }
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError && error.kind === 'denied') {
        this.auth.forgetLocal()
        this.clear('denied')
        return
      }
      const failure = error instanceof ApiError ? new AuthFailure('transaction-expired', true) : authFailure(error, challenge)
      if (failure.terminal) {
        if (failure.code === 'device-confirmation') this.auth.forgetLocal()
        this.clear('error')
      }
      this.publish({ authBusy: false, authError: failure.code })
    }
  }
  async signOut(): Promise<void> {
    if (this.snapshot.status === 'signing-out') return
    this.clear('signing-out')
    await this.auth.signOut()
  }

  private validateUser(user: AuthUser): void {
    if (!user.scope.split(' ').includes('janeway-admin/access')) throw new ApiError('denied')
    if (
      !user.accessToken ||
      !Number.isSafeInteger(user.expiresAt) || user.expiresAt <= this.now() ||
      !user.sub || !user.username || !user.deviceKey || user.issuer !== this.config.authority || user.clientId !== this.config.clientId ||
      !['fresh', 'new-password', 'device', 'refresh'].includes(user.loginKind) ||
      !Number.isSafeInteger(user.authTime) || user.authTime <= 0 || user.authTime > this.now() + 60 ||
      user.authTime + MAX_SESSION_SECONDS <= this.now()
    ) throw new ApiError('expired')
  }

  private async accessToken(): Promise<string> {
    if (!this.user || this.now() >= this.deadline) {
      this.clear('expired')
      throw new ApiError('expired')
    }
    if (this.user.expiresAt > this.now() + REFRESH_LEAD_SECONDS) return this.user.accessToken
    const generation = this.generation
    if (!this.refreshing) this.refreshing = this.auth.refresh()
    const refreshing = this.refreshing
    try {
      const user = await refreshing
      if (generation !== this.generation) throw new ApiError('expired')
      this.validateUser(user)
      if (user.sub !== this.user?.sub || user.username !== this.user.username || user.deviceKey !== this.user.deviceKey || user.authTime !== this.user.authTime || this.now() >= this.deadline) throw new ApiError('expired')
      this.user = user
      return user.accessToken
    } catch {
      if (generation === this.generation) this.clear('expired')
      throw new ApiError('expired')
    } finally {
      if (this.refreshing === refreshing) this.refreshing = null
    }
  }

  private async request(resource: 'session' | 'resume' | 'device'): Promise<{ value: unknown; etag: string | null }> {
    const generation = this.generation
    const accessToken = await this.accessToken()
    if (generation !== this.generation) throw new ApiError('expired')
    const controller = new AbortController()
    this.requests.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await ownerRequest(this.config.apiUrl, resource, accessToken, controller.signal, this.transport)
      if (generation !== this.generation) throw new ApiError('expired')
      // Background tabs may defer timers. A late HTTP response must enforce the
      // clock boundary itself rather than waiting for the scheduled callback.
      if (resource !== 'device' && (!this.user || this.now() >= Math.min(this.deadline, this.user.expiresAt))) {
        this.clear('expired')
        throw new ApiError('expired')
      }
      return response
    } finally {
      clearTimeout(timeout)
      this.requests.delete(controller)
    }
  }

  checkSession = (): Promise<void> => {
    if (!this.checking) this.checking = this.verifySession().finally(() => { this.checking = null })
    return this.checking
  }
  private reject(failure: ApiError): void {
    if (failure.kind === 'denied') this.auth.forgetLocal()
    this.clear(failure.code ? 'expired' : failure.kind, failure.requestId, failure.code)
  }
  private async verifySession(): Promise<void> {
    if (!this.user) return
    const generation = this.generation
    if (this.snapshot.status === 'unavailable') this.publish({ status: 'verifying', requestId: undefined })
    try {
      const response = await this.request('session')
      if (generation !== this.generation || !this.user) return
      const session = parseSession(response.value, this.user.sub, this.now(), this.user.deviceKey)
      if (session.authenticatedAt !== this.user.authTime) throw new ApiError('expired')
      this.deadline = Math.min(this.deadline, session.authenticatedAt + MAX_SESSION_SECONDS)
      let deviceTrusted = this.auth.isTrusted(this.user)
      if (this.trustRequested) {
        this.trustRequested = false
        try { deviceTrusted = await this.auth.trust(this.user, session) }
        catch (error) {
          if (generation !== this.generation) return
          if (error instanceof AuthFailure && error.terminal) throw new ApiError('expired')
          this.publish({ notice: 'trust-failed' })
        }
      }
      if (generation !== this.generation) return
      if (this.now() >= this.deadline || this.now() >= session.expiresAt) throw new ApiError('expired')
      this.publish({ status: 'authenticated', session, deviceTrusted, requestId: undefined })
      this.schedule(session.expiresAt)
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error instanceof ApiError ? error : new ApiError('unavailable')
      if (failure.kind !== 'unavailable') this.reject(failure)
      else {
        this.publish({ status: 'unavailable', session: null, resume: null, resumeStatus: 'idle', requestId: failure.requestId })
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.clear('expired'), Math.max(0, Math.min(this.user!.expiresAt, this.deadline) - this.now()) * 1000)
      }
    }
  }

  private schedule(expiresAt: number): void {
    clearTimeout(this.timer)
    const tokenExpiry = Math.min(expiresAt, this.user!.expiresAt)
    const wakeAt = Math.min(tokenExpiry - REFRESH_LEAD_SECONDS, this.deadline)
    this.timer = setTimeout(() => {
      if (this.now() >= this.deadline) this.clear('expired')
      else void this.checkSession()
    }, Math.max(1, wakeAt - this.now()) * 1000)
  }

  async forgetDevice(): Promise<void> {
    if (this.snapshot.status !== 'authenticated' || this.snapshot.deviceStatus === 'forgetting') return
    const generation = this.generation
    this.publish({ deviceStatus: 'forgetting', requestId: undefined })
    try {
      await this.request('device')
      if (generation !== this.generation) return
      this.auth.forgetLocal()
      await this.signOut()
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error instanceof ApiError ? error : new ApiError('unavailable')
      if (failure.kind !== 'unavailable') this.reject(failure)
      else this.publish({ deviceStatus: 'error', requestId: failure.requestId })
    }
  }

  loadResume = (): Promise<void> => {
    if (!this.loadingResume) this.loadingResume = this.readResume().finally(() => { this.loadingResume = null })
    return this.loadingResume
  }
  private async readResume(): Promise<void> {
    if (this.snapshot.status !== 'authenticated') return
    const generation = this.generation
    this.publish({ resume: null, resumeStatus: 'loading', requestId: undefined })
    try {
      const response = await this.request('resume')
      if (generation !== this.generation || this.snapshot.status !== 'authenticated') return
      this.publish({ resume: parseResume(response.value, response.etag), resumeStatus: 'ready' })
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error instanceof ApiError ? error : new ApiError('unavailable')
      if (failure.kind !== 'unavailable') this.reject(failure)
      else this.publish({ resume: null, resumeStatus: 'unavailable', requestId: failure.requestId })
    }
  }
}
