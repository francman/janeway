import { ApiError } from './api'
import {
  canConfirmPublication, capturePublicationReview, clearPublicationCheckpoint, parsePublicationOutcome,
  readPublicationCheckpoint, savePublicationCheckpoint, PublicationFailure,
  type PublicationOutcome, type PublicationReview,
} from './resume-publication'
import { MAX_PDF_BYTES, UploadFailure, uploadPdfToStaging } from './resume-upload'
import type { OwnerSessionClient } from './session'

export type ResumePublisherStatus = 'idle' | 'publishing' | 'checking' | 'published' | 'conflict' | 'failed' | 'uncertain' | 'superseded'
export interface ResumePublisherSnapshot {
  readonly status: ResumePublisherStatus
  readonly progress: number | null
  readonly message?: string
  readonly requestId?: string
  readonly operationId: string | null
}
type PublicationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type PublisherClient = Pick<OwnerSessionClient,
  'getSnapshot' | 'subscribe' | 'publicationScope' | 'stagingOrigin' | 'authorizeResumeUpload' |
  'validateResumeUpload' | 'getResumePreview' | 'loadResume' | 'publishResume' | 'getResumePublication'>
export interface ResumePublisherOptions {
  storage?: () => PublicationStorage
  upload?: typeof uploadPdfToStaging
  now?: () => number
  uuid?: () => string
}
interface Identity {
  ownerSub: string
  authenticatedAt: number
  deviceKey: string
}
interface Operation {
  operationId: string
  ownerSub: string
  review: PublicationReview | null
  storage: PublicationStorage
  unresolved: boolean
}
interface Work {
  identity: Identity
  request: AbortController
  generation: number
}
const idle: ResumePublisherSnapshot = Object.freeze({ status: 'idle', progress: null, operationId: null })
function sameIdentity(left: Identity | null, right: Identity | null): boolean {
  return left === right || (!!left && !!right && left.ownerSub === right.ownerSub &&
    left.authenticatedAt === right.authenticatedAt && left.deviceKey === right.deviceKey)
}
function requestId(error: unknown): string | undefined {
  return error instanceof ApiError || error instanceof UploadFailure || error instanceof PublicationFailure ? error.requestId : undefined
}

export class ResumePublisher {
  private snapshot: ResumePublisherSnapshot = idle
  private readonly listeners = new Set<() => void>()
  private readonly connections = new Set<object>()
  private unsubscribe: (() => void) | null = null
  private identity: Identity | null = null
  private operation: Operation | null = null
  private work: Work | null = null
  private generation = 0
  private disposed = false
  private readonly storage: () => PublicationStorage
  private readonly upload: typeof uploadPdfToStaging
  private readonly now: () => number
  private readonly uuid: () => string

  constructor(private readonly client: PublisherClient, options: ResumePublisherOptions = {}) {
    this.storage = options.storage ?? (() => window.sessionStorage)
    this.upload = options.upload ?? uploadPdfToStaging
    this.now = options.now ?? Date.now
    this.uuid = options.uuid ?? (() => crypto.randomUUID())
  }

  getSnapshot = (): ResumePublisherSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  connect = (): (() => void) => {
    if (this.disposed) return () => {}
    const connection = {}
    this.connections.add(connection)
    if (this.connections.size === 1) {
      this.unsubscribe = this.client.subscribe(() => this.sessionChanged())
      this.sessionChanged(true)
    }
    return () => {
      if (!this.connections.delete(connection) || this.connections.size) return
      this.unsubscribe?.()
      this.unsubscribe = null
      this.cancelWork()
      this.update(this.operation?.unresolved
        ? { status: 'uncertain', progress: null, operationId: this.operation.operationId, message: 'Publication status is not confirmed.' }
        : this.snapshot.status === 'publishing' || this.snapshot.status === 'checking' ? idle : this.snapshot)
    }
  }

  dispose(): void {
    this.connections.clear()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.cancelWork()
    this.listeners.clear()
    this.disposed = true
  }

  reset(): void {
    if (this.disposed || this.operation?.unresolved || ['publishing', 'checking', 'uncertain'].includes(this.snapshot.status)) return
    this.cancelWork()
    this.operation = null
    this.update(idle)
  }

  publish = async (file: File): Promise<void> => {
    if (this.disposed || !this.connections.size || this.work || this.operation?.unresolved ||
        ['publishing', 'checking', 'uncertain', 'published', 'superseded'].includes(this.snapshot.status)) return
    this.sessionChanged()
    if (!this.identity || this.work || this.operation?.unresolved) return
    const work = this.startWork(this.identity)
    this.update({ status: 'publishing', progress: null, operationId: null })
    try {
      if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PDF_BYTES || file.type !== 'application/pdf' ||
          typeof file.name !== 'string' || !file.name || file.name.length > 128 || file.name.trim() !== file.name ||
          /[\\/\x00-\x1f\x7f]/.test(file.name) || !/[.]pdf$/i.test(file.name)) {
        throw new UploadFailure(file?.size > MAX_PDF_BYTES ? 'FILE_TOO_LARGE' : 'INVALID_REQUEST')
      }
      const storage = this.storage()
      const saved = readPublicationCheckpoint(storage, this.client.publicationScope, work.identity.ownerSub)
      if (!this.current(work)) return
      if (saved && (!this.operation || saved !== this.operation.operationId || this.operation.unresolved)) {
        this.operation = { operationId: saved, ownerSub: work.identity.ownerSub, review: null, storage, unresolved: true }
        this.update({ status: 'uncertain', progress: null, operationId: saved, message: 'Publication status is not confirmed.' })
        return
      }
      this.operation = null
      const authorization = await this.client.authorizeResumeUpload(file, work.request.signal)
      if (!this.current(work)) return
      let uploading = true
      this.update({ status: 'publishing', progress: 0, operationId: null })
      if (!this.current(work)) return
      const uploaded = await this.upload(this.client.stagingOrigin, work.identity.ownerSub, authorization, file, work.request.signal, (loaded, total) => {
        if (uploading && this.current(work) && Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
          this.update({ status: 'publishing', progress: Math.max(0, Math.min(100, Math.round(loaded / total * 100))), operationId: null })
        }
      })
      uploading = false
      if (!this.current(work)) return
      this.update({ status: 'publishing', progress: null, operationId: null })
      if (!this.current(work)) return
      const receipt = await this.client.validateResumeUpload(authorization.uploadId, uploaded.versionId, work.request.signal)
      if (!this.current(work)) return
      if (receipt.uploadId !== authorization.uploadId || receipt.versionId !== uploaded.versionId || receipt.bytes !== file.size) throw new UploadFailure('UNAVAILABLE')
      const preview = await this.client.getResumePreview(receipt, work.request.signal)
      if (!this.current(work)) return
      await this.client.loadResume()
      if (!this.current(work)) return
      const current = this.client.getSnapshot()
      if (current.resumeStatus !== 'ready' || !current.resume || Date.parse(preview.expiresAt) <= this.now() || !Number.isFinite(Date.parse(preview.expiresAt))) {
        throw new PublicationFailure('UNAVAILABLE')
      }
      const review = capturePublicationReview(receipt, file.name, true, current.resume, this.uuid(), work.identity.ownerSub, this.now())
      this.update({ status: 'publishing', progress: null, operationId: review.operationId })
      if (!this.current(work)) return
      // Another mounted publisher must not overwrite an unresolved operation.
      const pending = readPublicationCheckpoint(storage, this.client.publicationScope, work.identity.ownerSub)
      if (pending && pending !== saved) {
        this.operation = { operationId: pending, ownerSub: work.identity.ownerSub, review: null, storage, unresolved: true }
        this.update({ status: 'uncertain', progress: null, operationId: pending, message: 'Publication status is not confirmed.' })
        return
      }
      if (!this.current(work)) return
      if (Date.parse(preview.expiresAt) <= this.now() || !canConfirmPublication(review, receipt, file.name, true, work.identity.ownerSub, this.now())) {
        throw new PublicationFailure('INVALID_REQUEST')
      }
      savePublicationCheckpoint(storage, this.client.publicationScope, work.identity.ownerSub, review.operationId)
      this.operation = { operationId: review.operationId, ownerSub: work.identity.ownerSub, review, storage, unresolved: true }
      if (!this.current(work)) return
      const value = await this.client.publishResume(review.receipt.validationId, review.expectedEtag, review.operationId, work.request.signal)
      if (!this.current(work)) return
      await this.acceptOutcome(value, work)
    } catch (error) {
      if (!this.current(work)) return
      this.update(this.operation?.unresolved
        ? { status: 'uncertain', progress: null, operationId: this.operation.operationId, message: 'Publication status is not confirmed.', requestId: requestId(error) }
        : { status: 'failed', progress: null, operationId: null, message: error instanceof UploadFailure && error.code === 'FILE_TOO_LARGE'
          ? 'Choose a PDF of 10 MB or smaller.' : error instanceof UploadFailure && error.code === 'INVALID_REQUEST'
            ? 'Choose a valid PDF.' : error instanceof UploadFailure && error.code === 'INVALID_PDF'
              ? 'The PDF could not be validated.' : 'Résumé could not be published.', requestId: requestId(error) })
    } finally {
      if (this.work === work) this.work = null
    }
  }

  checkOutcome = async (): Promise<void> => {
    if (this.disposed || !this.connections.size || this.work || !this.identity || !this.operation?.unresolved) return
    const operation = this.operation
    const work = this.startWork(this.identity)
    this.update({ status: 'checking', progress: null, operationId: operation.operationId })
    try {
      if (!this.current(work)) return
      const value = await this.client.getResumePublication(operation.operationId, work.request.signal)
      if (!this.current(work)) return
      await this.acceptOutcome(value, work)
    } catch (error) {
      if (this.current(work)) this.update({ status: 'uncertain', progress: null, operationId: operation.operationId,
        message: 'Publication status is not confirmed.', requestId: requestId(error) })
    } finally {
      if (this.work === work) this.work = null
    }
  }

  private readIdentity(): Identity | null {
    const value = this.client.getSnapshot()
    return value.status === 'authenticated' && value.session
      ? { ownerSub: value.session.owner.sub, authenticatedAt: value.session.authenticatedAt, deviceKey: value.session.device.key }
      : null
  }
  private sessionChanged(reconnect = false): void {
    const identity = this.readIdentity()
    const changed = !sameIdentity(identity, this.identity)
    if (changed) {
      this.cancelWork()
      this.identity = identity
      this.operation = null
      this.update(idle)
    }
    if ((!changed && !reconnect) || !identity || this.work) return
    try {
      const storage = this.storage()
      const saved = readPublicationCheckpoint(storage, this.client.publicationScope, identity.ownerSub)
      if (saved && (!this.operation || saved !== this.operation.operationId || this.operation.unresolved)) {
        const review = this.operation?.operationId === saved ? this.operation.review : null
        this.operation = { operationId: saved, ownerSub: identity.ownerSub, review, storage, unresolved: true }
        void this.checkOutcome()
      }
    } catch {
      if (!this.operation?.unresolved) this.update({ status: 'failed', progress: null, operationId: null, message: 'Publication recovery is unavailable.' })
    }
  }
  private startWork(identity: Identity): Work {
    const work = { identity, request: new AbortController(), generation: ++this.generation }
    this.work = work
    return work
  }
  private cancelWork(): void {
    this.generation++
    const work = this.work
    this.work = null
    work?.request.abort()
  }
  private current(work: Work): boolean {
    return !this.disposed && !!this.connections.size && this.work === work && work.generation === this.generation &&
      !work.request.signal.aborted && sameIdentity(work.identity, this.readIdentity())
  }
  private update(snapshot: ResumePublisherSnapshot): void {
    this.snapshot = snapshot
    if (this.connections.size && !this.disposed) for (const listener of this.listeners) listener()
  }
  private async acceptOutcome(raw: PublicationOutcome, work: Work): Promise<void> {
    const operation = this.operation!
    const value = parsePublicationOutcome(raw, operation.operationId, this.now())
    if (operation.review && value.result && (value.result.sha256 !== operation.review.receipt.sha256 || value.result.bytes !== operation.review.receipt.bytes)) {
      this.update({ status: 'uncertain', progress: null, operationId: operation.operationId, message: 'Publication status is not confirmed.' })
      return
    }
    if (value.status === 'unknown' || value.status === 'in_progress') {
      this.update({ status: 'uncertain', progress: null, operationId: operation.operationId, message: 'Publication status is not confirmed.' })
      return
    }
    operation.unresolved = false
    try { clearPublicationCheckpoint(operation.storage, this.client.publicationScope, operation.ownerSub) } catch { /* The terminal outcome remains authoritative. */ }
    if (!this.current(work)) return
    const status = value.status === 'committed' ? 'published' : value.status
    const message = status === 'published' ? 'Résumé published.' : status === 'superseded' ? 'A newer résumé is current.' :
      status === 'conflict' ? 'The current résumé changed. Publish again to retry.' : 'Résumé was not published.'
    this.update({ status, progress: null, operationId: operation.operationId, message })
    if (!this.current(work) || !['committed', 'superseded', 'conflict'].includes(value.status)) return
    // Refresh failure cannot undo a confirmed commit or authorize another POST.
    try { await this.client.loadResume() } catch { /* Current metadata can be refreshed independently. */ }
  }
}
