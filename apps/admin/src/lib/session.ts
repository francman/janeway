import { ApiError, ownerRequest, parseResume, parseSession, type DeviceErrorCode, type OwnerSession, type ResumeMetadata } from './api'
import type { AdminConfig } from './config'
import { AuthFailure, authFailure, type AuthErrorCode, type AuthPort, type AuthStep, type AuthUser } from './auth'
import {
  authorizeResumeUpload as requestUploadAuthorization,
  getResumePreview as requestResumePreview,
  validateResumeUpload as requestResumeValidation,
  type PreviewGrant, type UploadAuthorization, type ValidationReceipt,
} from './resume-upload'
import { getResumePublication as requestResumePublication, publishResume as requestResumePublicationCommit, type PublicationOutcome } from './resume-publication'
import * as writingRequests from './writing-drafts'
import { getMetrics, MetricsFailure } from './metrics'
import type { MetricsRange, MetricsSnapshot } from './metrics-definitions'
import * as writingPublication from './writing-publication'

export type SessionStatus = 'login' | 'verifying' | 'authenticated' | 'signing-out' | 'expired' | 'denied' | 'unavailable' | 'error'
export interface SessionSnapshot {
  status: SessionStatus
  session: OwnerSession | null
  resume: ResumeMetadata | null
  resumeStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  metrics: MetricsSnapshot
  flow: Exclude<AuthStep, { kind: 'done' }>
  authBusy: boolean
  authError?: AuthErrorCode
  notice?: 'trust-failed'
  deviceTrusted: boolean
  deviceStatus: 'idle' | 'forgetting' | 'error'
  deviceError?: DeviceErrorCode
  requestId?: string
}

const MAX_SESSION_SECONDS = 8 * 60 * 60
const REFRESH_LEAD_SECONDS = 60
export const initialSnapshot: SessionSnapshot = {
  status: 'login', session: null, resume: null, resumeStatus: 'idle', flow: { kind: 'credentials' },
  authBusy: false, deviceTrusted: false, deviceStatus: 'idle',
  metrics: { status: 'idle', data: null },
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
  private restoration: Promise<void> | null = null
  private metricsGeneration = 0
  private metricsRequest: AbortController | null = null
  private trustRequested = false
  private readonly requests = new Set<AbortController>()

  readonly loginId: string
  readonly stagingOrigin: string
  readonly publicationScope: string
  constructor(
    private readonly config: AdminConfig,
    private readonly auth: AuthPort,
    private readonly transport: typeof fetch = fetch,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    this.loginId = config.loginId
    this.stagingOrigin = config.previewOrigin
    this.publicationScope = `${config.authority}|${config.clientId}|${config.apiUrl}`
  }

  getSnapshot = (): SessionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(update: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  clear(status: SessionStatus, requestId?: string, deviceError?: DeviceErrorCode, preserveCheckpoint = false): void {
    this.generation++
    this.user = null
    this.deadline = 0
    this.trustRequested = false
    clearTimeout(this.timer)
    for (const request of this.requests) request.abort()
    this.requests.clear()
    this.auth.clear(status === 'signing-out', preserveCheckpoint)
    this.snapshot = { ...initialSnapshot, status, requestId, deviceError }
    for (const listener of this.listeners) listener()
  }

  suspend(): void { this.clear('expired', undefined, undefined, true) }

  restore = (): Promise<void> => {
    if (!this.restoration) this.restoration = this.restoreSession()
    return this.restoration
  }
  private async restoreSession(): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy) return
    const generation = this.generation
    this.publish({ authBusy: true, authError: undefined })
    try {
      const user = await this.auth.restore()
      if (generation !== this.generation) return
      if (!user) {
        this.publish({ authBusy: false })
        return
      }
      this.validateUser(user)
      this.user = user
      this.deadline = Math.min(this.now() + MAX_SESSION_SECONDS, user.authTime + MAX_SESSION_SECONDS)
      this.publish({ status: 'verifying', flow: { kind: 'credentials' }, authBusy: true })
      await this.checkSession()
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError) this.reject(error)
      else this.clear('expired')
    }
  }

  restart(freshMfa = false): void {
    if (freshMfa) this.auth.forgetLocal()
    this.clear('login')
    this.auth.restart()
  }

  async signIn(loginId: string, password: string, trust: boolean): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || this.snapshot.flow.kind !== 'credentials') return
    this.trustRequested = trust
    await this.authenticate(() => this.auth.signIn(loginId, password))
  }
  async confirm(value: string, attributes?: Record<string, string>): Promise<void> {
    if (this.snapshot.status !== 'login' || this.snapshot.authBusy || !['totp', 'new-password'].includes(this.snapshot.flow.kind)) return
    await this.authenticate(() => this.auth.confirm(value, attributes), true)
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
        this.publish({ status: 'verifying', flow: { kind: 'credentials' }, authBusy: true })
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
    if (
      !user.accessToken ||
      !Number.isSafeInteger(user.expiresAt) || user.expiresAt <= this.now() ||
      !user.sub || !user.username || !user.deviceKey || user.issuer !== this.config.authority || user.clientId !== this.config.clientId ||
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

  private async uploadOperation<T>(operation: (token: string, signal: AbortSignal, ownerSub: string) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const generation = this.generation
    const token = await this.accessToken()
    if (generation !== this.generation || !this.user || callerSignal?.aborted) throw new ApiError('expired')
    const ownerSub = this.user.sub
    const controller = new AbortController()
    this.requests.add(controller)
    const cancel = () => controller.abort()
    callerSignal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const value = await operation(token, controller.signal, ownerSub)
      if (generation !== this.generation || !this.user || this.now() >= Math.min(this.deadline, this.user.expiresAt)) throw new ApiError('expired')
      if (controller.signal.aborted) throw new ApiError('unavailable')
      return value
    } catch (error) {
      if (generation === this.generation && error instanceof ApiError && error.kind !== 'unavailable') this.reject(error)
      throw error
    } finally {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', cancel)
      this.requests.delete(controller)
    }
  }
  authorizeResumeUpload(file: File, callerSignal?: AbortSignal): Promise<UploadAuthorization> {
    return this.uploadOperation((token, signal, ownerSub) => requestUploadAuthorization(this.config.apiUrl, this.config.previewOrigin, ownerSub, token, file, signal, this.transport), callerSignal)
  }
  validateResumeUpload(uploadId: string, versionId: string, callerSignal?: AbortSignal): Promise<ValidationReceipt> {
    return this.uploadOperation((token, signal, ownerSub) => requestResumeValidation(this.config.apiUrl, ownerSub, token, uploadId, versionId, signal, this.transport), callerSignal)
  }
  getResumePreview(receipt: ValidationReceipt, callerSignal?: AbortSignal): Promise<PreviewGrant> {
    return this.uploadOperation((token, signal, ownerSub) => requestResumePreview(this.config.apiUrl, this.config.previewOrigin, ownerSub, token, receipt, signal, this.transport), callerSignal)
  }
  publishResume(validationId: string, expectedEtag: string, operationId: string, callerSignal?: AbortSignal): Promise<PublicationOutcome> {
    return this.uploadOperation((token, signal) => requestResumePublicationCommit(this.config.apiUrl, token, validationId, expectedEtag, operationId, signal, this.transport), callerSignal)
  }
  getResumePublication(operationId: string, callerSignal?: AbortSignal): Promise<PublicationOutcome> {
    return this.uploadOperation((token, signal) => requestResumePublication(this.config.apiUrl, token, operationId, signal, this.transport), callerSignal)
  }
  listWritingDrafts(cursor?: string, callerSignal?: AbortSignal): Promise<writingRequests.DraftPage> {
    return this.uploadOperation((token, signal) => writingRequests.listWritingDrafts(this.config.apiUrl, token, cursor, signal, this.transport), callerSignal)
  }
  getWritingDraft(draftId: string, callerSignal?: AbortSignal): Promise<writingRequests.WritingDraft> {
    return this.uploadOperation((token, signal, ownerSub) => writingRequests.getWritingDraft(this.config.apiUrl, token, ownerSub, draftId, signal, this.transport), callerSignal)
  }
  createWritingDraft(input: writingRequests.CreateDraftInput, operationId: string, callerSignal?: AbortSignal): Promise<writingRequests.DraftOperation> {
    return this.uploadOperation((token, signal) => writingRequests.createWritingDraft(this.config.apiUrl, token, input, operationId, signal, this.transport), callerSignal)
  }
  saveWritingDraft(draftId: string, input: writingRequests.DraftInput, revision: string, operationId: string, callerSignal?: AbortSignal): Promise<writingRequests.DraftOperation> {
    return this.uploadOperation((token, signal) => writingRequests.saveWritingDraft(this.config.apiUrl, token, draftId, input, revision, operationId, signal, this.transport), callerSignal)
  }
  getWritingOperation(operationId: string, callerSignal?: AbortSignal): Promise<writingRequests.DraftOperation> {
    return this.uploadOperation((token, signal) => writingRequests.getWritingOperation(this.config.apiUrl, token, operationId, signal, this.transport), callerSignal)
  }
  listPublishedWritings(cursor?: string, callerSignal?: AbortSignal): Promise<writingRequests.PublishedPage> {
    return this.uploadOperation((token, signal) => writingRequests.listPublishedWritings(this.config.apiUrl, token, cursor, signal, this.transport), callerSignal)
  }
  getPublishedWriting(slug: string, callerSignal?: AbortSignal): Promise<writingRequests.PublishedWriting> {
    return this.uploadOperation((token, signal) => writingRequests.getPublishedWriting(this.config.apiUrl, token, slug, signal, this.transport), callerSignal)
  }
  authorizeWritingAsset(draftId: string, file: File, callerSignal?: AbortSignal): Promise<writingRequests.AssetAuthorization> {
    return this.uploadOperation((token, signal, ownerSub) => writingRequests.authorizeWritingAsset(this.config.apiUrl, token, ownerSub, draftId, file, signal, this.transport), callerSignal)
  }
  validateWritingAsset(draftId: string, assetId: string, versionId: string, callerSignal?: AbortSignal): Promise<writingRequests.WritingAsset> {
    return this.uploadOperation((token, signal, ownerSub) => writingRequests.validateWritingAsset(this.config.apiUrl, token, ownerSub, draftId, assetId, versionId, signal, this.transport), callerSignal)
  }
  getWritingAssetPreview(draftId: string, asset: writingRequests.WritingAsset, callerSignal?: AbortSignal): Promise<writingRequests.AssetPreview> {
    return this.uploadOperation((token, signal, ownerSub) => writingRequests.getWritingAssetPreview(this.config.apiUrl, token, ownerSub, draftId, asset, signal, this.transport), callerSignal)
  }
  previewWritingDraft(draftId: string, revision: string, callerSignal?: AbortSignal): Promise<writingRequests.DraftPreview> {
    return this.uploadOperation((token, signal) => writingRequests.previewWritingDraft(this.config.apiUrl, token, draftId, revision, signal, this.transport), callerSignal)
  }
  async loadMetrics(range: MetricsRange, callerSignal?: AbortSignal): Promise<void> {
    const generation = this.generation
    const metricsGeneration = ++this.metricsGeneration
    this.metricsRequest?.abort()
    const request = new AbortController()
    this.metricsRequest = request
    const cancel = () => request.abort()
    callerSignal?.addEventListener('abort', cancel, { once: true })
    if (callerSignal?.aborted) request.abort()
    const previous = this.snapshot.metrics.data
    this.publish({ metrics: { status: 'loading', data: previous } })
    try {
      const data = await this.uploadOperation((token, signal) => getMetrics(this.config.apiUrl, token, range, signal, this.transport), request.signal)
      if (generation === this.generation && metricsGeneration === this.metricsGeneration && !request.signal.aborted) this.publish({ metrics: { status: 'ready', data } })
    } catch (error) {
      if (generation !== this.generation || metricsGeneration !== this.metricsGeneration || request.signal.aborted) return
      const failure = error instanceof MetricsFailure ? error : null
      this.publish({ metrics: failure?.code === 'DISCONNECTED' ? { status: 'disconnected', data: null } : {
        status: failure?.code === 'RATE_LIMITED' ? 'rate-limited' : 'error', data: previous,
        error: failure?.code === 'INVALID_RANGE' ? 'Choose a valid UTC window of at most 90 days.' : 'Metrics could not be refreshed.', retryAt: failure?.retryAt,
      } })
    } finally {
      callerSignal?.removeEventListener('abort', cancel)
      if (this.metricsRequest === request) this.metricsRequest = null
    }
  }
  publishWriting(draftId: string, revision: string, expectedPublishedKey: string | null, operationId: string, callerSignal?: AbortSignal): Promise<writingPublication.WritingPublicationOutcome> {
    return this.uploadOperation((token, signal) => writingPublication.publishWriting(this.config.apiUrl, token, draftId, revision, expectedPublishedKey, operationId, signal, this.transport), callerSignal)
  }
  getWritingPublication(operationId: string, callerSignal?: AbortSignal): Promise<writingPublication.WritingPublicationOutcome> {
    return this.uploadOperation((token, signal) => writingPublication.getWritingPublication(this.config.apiUrl, token, operationId, signal, this.transport), callerSignal)
  }
  refreshWritingPublication(operationId: string, callerSignal?: AbortSignal): Promise<writingPublication.WritingPublicationOutcome> {
    return this.uploadOperation((token, signal) => writingPublication.refreshWritingPublication(this.config.apiUrl, token, operationId, signal, this.transport), callerSignal)
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
    if (this.snapshot.status === 'unavailable') this.publish({ status: 'verifying', authBusy: true, requestId: undefined })
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
      this.publish({ status: 'authenticated', session, deviceTrusted, authBusy: false, requestId: undefined })
      this.schedule(session.expiresAt)
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error instanceof ApiError ? error : new ApiError('unavailable')
      if (failure.kind !== 'unavailable') this.reject(failure)
      else {
        this.publish({ status: 'unavailable', session: null, resume: null, resumeStatus: 'idle', authBusy: false, requestId: failure.requestId })
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
