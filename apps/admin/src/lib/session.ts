import { ApiError, ownerRequest, parseResume, parseSession, type OwnerSession, type ResumeMetadata } from './api'
import type { AdminConfig } from './config'
import type { AuthPort, AuthUser } from './oidc'

export type SessionStatus = 'loading' | 'redirecting' | 'verifying' | 'authenticated' | 'signing-out' | 'signed-out' | 'expired' | 'denied' | 'unavailable' | 'error'
export interface SessionSnapshot {
  status: SessionStatus
  session: OwnerSession | null
  resume: ResumeMetadata | null
  resumeStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  requestId?: string
}

const MAX_SESSION_SECONDS = 8 * 60 * 60
const REFRESH_LEAD_SECONDS = 60
const initial: SessionSnapshot = { status: 'loading', session: null, resume: null, resumeStatus: 'idle' }

export class OwnerSessionClient {
  private snapshot: SessionSnapshot = initial
  private readonly listeners = new Set<() => void>()
  private user: AuthUser | null = null
  private generation = 0
  private deadline = 0
  private timer: NodeJS.Timeout | undefined
  private refreshing: Promise<AuthUser | null> | null = null
  private checking: Promise<void> | null = null
  private loadingResume: Promise<void> | null = null
  private starting: Promise<void> | null = null
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

  clear(status: SessionStatus, requestId?: string): void {
    this.generation++
    this.user = null
    this.deadline = 0
    clearTimeout(this.timer)
    for (const request of this.requests) request.abort()
    this.requests.clear()
    this.auth.clear()
    this.publish({ status, session: null, resume: null, resumeStatus: 'idle', requestId })
  }

  start(mode: 'workspace' | 'callback' | 'signed-out', callbackUrl?: string): Promise<void> {
    if (!this.starting) this.starting = this.initialize(mode, callbackUrl)
    return this.starting
  }

  private async initialize(mode: 'workspace' | 'callback' | 'signed-out', callbackUrl?: string): Promise<void> {
    if (mode === 'signed-out') { this.clear('signed-out'); return }
    if (mode === 'workspace') { await this.signIn(); return }
    const generation = this.generation
    this.publish({ status: 'verifying' })
    try {
      const user = await this.auth.callback(callbackUrl ?? '')
      if (generation !== this.generation) return
      this.validateUser(user)
      this.user = user
      this.deadline = Math.min(this.now() + MAX_SESSION_SECONDS, user.profile.auth_time! + MAX_SESSION_SECONDS)
      await this.checkSession()
    } catch {
      if (generation === this.generation) this.clear('error')
    }
  }

  async signIn(): Promise<void> {
    if (this.snapshot.status === 'redirecting') return
    this.clear('redirecting')
    const generation = this.generation
    try { await this.auth.signIn() }
    catch { if (generation === this.generation) this.clear('error') }
  }

  async signOut(): Promise<void> {
    let user = this.user
    const refreshing = this.refreshing
    this.clear('signing-out')
    // A refresh already in flight may rotate once. Revoke the newest result,
    // but the sealed store and generation guard cannot re-open local access.
    if (refreshing) {
      try { user = await refreshing ?? user } catch { /* Revoke the last known token. */ }
    }
    await this.auth.signOut(user)
  }

  private validateUser(user: AuthUser | null): asserts user is AuthUser {
    if (
      !user || !user.access_token || !user.refresh_token || user.token_type.toLowerCase() !== 'bearer' ||
      !user.scope?.split(' ').includes('janeway-admin/access') ||
      !Number.isFinite(user.expires_at) || user.expires_at! <= this.now() ||
      !user.profile.sub || user.profile.iss !== this.config.authority ||
      !(typeof user.profile.aud === 'string' ? user.profile.aud === this.config.clientId : user.profile.aud?.includes(this.config.clientId)) ||
      !Number.isSafeInteger(user.profile.auth_time) || user.profile.auth_time! <= 0 ||
      user.profile.auth_time! > this.now() + 60 || user.profile.auth_time! + MAX_SESSION_SECONDS <= this.now()
    ) throw new ApiError('expired')
  }

  private async accessToken(): Promise<string> {
    if (!this.user || this.now() >= this.deadline) {
      this.clear('expired')
      throw new ApiError('expired')
    }
    if (this.user.expires_at! > this.now() + REFRESH_LEAD_SECONDS) return this.user.access_token
    const generation = this.generation
    if (!this.refreshing) this.refreshing = this.auth.refresh()
    const refreshing = this.refreshing
    try {
      const user = await refreshing
      if (generation !== this.generation) throw new ApiError('expired')
      this.validateUser(user)
      if (user.profile.sub !== this.user?.profile.sub || user.profile.auth_time !== this.user?.profile.auth_time || this.now() >= this.deadline) {
        throw new ApiError('expired')
      }
      this.user = user
      return user.access_token
    } catch {
      if (generation === this.generation) this.clear('expired')
      throw new ApiError('expired')
    } finally {
      if (this.refreshing === refreshing) this.refreshing = null
    }
  }

  private async request(resource: 'session' | 'resume'): Promise<{ value: unknown; etag: string | null }> {
    const generation = this.generation
    const accessToken = await this.accessToken()
    if (generation !== this.generation) throw new ApiError('expired')
    const controller = new AbortController()
    this.requests.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await ownerRequest(this.config.apiUrl, resource, accessToken, controller.signal, this.transport)
      if (generation !== this.generation) throw new ApiError('expired')
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

  private async verifySession(): Promise<void> {
    if (!this.user) return
    const generation = this.generation
    if (this.snapshot.status === 'unavailable') this.publish({ status: 'verifying', requestId: undefined })
    try {
      const response = await this.request('session')
      if (generation !== this.generation || !this.user) return
      const session = parseSession(response.value, this.user.profile.sub, this.now())
      if (session.authenticatedAt !== this.user.profile.auth_time) throw new ApiError('expired')
      this.deadline = Math.min(this.deadline, session.authenticatedAt + MAX_SESSION_SECONDS)
      this.publish({ status: 'authenticated', session, requestId: undefined })
      this.schedule(session.expiresAt)
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error instanceof ApiError ? error : new ApiError('unavailable')
      if (failure.kind !== 'unavailable') this.clear(failure.kind, failure.requestId)
      else {
        this.publish({ status: 'unavailable', session: null, resume: null, resumeStatus: 'idle', requestId: failure.requestId })
        // Unavailability never extends the memory session or shows stale owner data.
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.clear('expired'), Math.max(0, Math.min(this.user!.expires_at!, this.deadline) - this.now()) * 1000)
      }
    }
  }

  private schedule(expiresAt: number): void {
    clearTimeout(this.timer)
    const tokenExpiry = Math.min(expiresAt, this.user!.expires_at!)
    const wakeAt = Math.min(tokenExpiry - REFRESH_LEAD_SECONDS, this.deadline)
    this.timer = setTimeout(() => {
      if (this.now() >= this.deadline) this.clear('expired')
      else void this.checkSession()
    }, Math.max(1, wakeAt - this.now()) * 1000)
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
      if (failure.kind !== 'unavailable') this.clear(failure.kind, failure.requestId)
      else this.publish({ resume: null, resumeStatus: 'unavailable', requestId: failure.requestId })
    }
  }
}
