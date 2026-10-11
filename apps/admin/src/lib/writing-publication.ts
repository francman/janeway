import { ApiError } from './api'
import { DraftFailure, draftInput, isDraftId, parseWritingDraft, sameDraftInput, type DraftInput, type DraftPreview, type PublishedWriting, type WritingDraft, type WritingSession } from './writing-drafts'

const OWNER = /^[A-Za-z0-9_-]{1,128}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STATUSES = ['in_progress', 'committed', 'failed', 'conflict', 'unknown', 'superseded'] as const
export type WritingPublicationStatus = typeof STATUSES[number]
export interface WritingPublicationResult {
  slug: string; s3Key: string; previousPublishedKey: string | null; publicationId: string
  draftRevision: string; publishedAt: string; updatedAt: string; refreshPending: boolean
}
export interface WritingPublicationOutcome {
  operationId: string; draftId: string; createdAt: string; status: WritingPublicationStatus
  result?: WritingPublicationResult; current?: { slug: string; s3Key: string }; errorCode?: string
}
export type WritingPublicationFailureCode = 'INVALID_REQUEST' | 'OPERATION_NOT_FOUND' | 'OPERATION_REUSED' | 'REFRESH_NOT_PROVEN' | 'UNAVAILABLE' | 'REVIEW_CHANGED' | 'PUBLIC_BASE_CHANGED' | 'PREVIEW_INVALID' | 'BASELINE_UNAVAILABLE'
export class WritingPublicationFailure extends Error {
  constructor(readonly code: WritingPublicationFailureCode, readonly requestId?: string) { super(code) }
}
export interface WritingPublicationSession extends Pick<WritingSession, 'getWritingDraft' | 'getPublishedWriting' | 'previewWritingDraft'> {
  readonly publicationScope: string
  publishWriting(draftId: string, revision: string, expectedPublishedKey: string | null, operationId: string, signal?: AbortSignal): Promise<WritingPublicationOutcome>
  getWritingPublication(operationId: string, signal?: AbortSignal): Promise<WritingPublicationOutcome>
  refreshWritingPublication(operationId: string, signal?: AbortSignal): Promise<WritingPublicationOutcome>
}
function fail(code: WritingPublicationFailureCode = 'UNAVAILABLE'): never { throw new WritingPublicationFailure(code) }
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function slug(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && SLUG.test(value) }
function publicKey(value: unknown, articleSlug?: string): value is string {
  if (typeof value !== 'string') return false
  const match = /^articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/revisions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/page\.mdx$/.exec(value)
  return !!match && slug(match[1]) && (articleSlug === undefined || articleSlug === match[1])
}
function publicPointer(value: unknown): { slug: string; s3Key: string } {
  const item = value as { slug: string; s3Key: string } | null
  if (!item || !slug(item.slug) || !publicKey(item.s3Key, item.slug)) fail()
  return { slug: item.slug, s3Key: item.s3Key }
}
export function writingPublicUrl(articleSlug: string): string {
  if (!slug(articleSlug)) fail('INVALID_REQUEST')
  return `https://www.frankmanu.com/writings/${articleSlug}`
}
export function parseWritingPublicationOutcome(value: unknown, operationId: string): WritingPublicationOutcome {
  const item = value as WritingPublicationOutcome | null
  if (!item || !isDraftId(operationId) || item.operationId !== operationId || !isDraftId(item.draftId) || !iso(item.createdAt) || !STATUSES.includes(item.status) || (item.errorCode !== undefined && (typeof item.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.errorCode)))) fail()
  const current = item.current === undefined ? undefined : publicPointer(item.current)
  let result: WritingPublicationResult | undefined
  if (item.result !== undefined) {
    const pointer = publicPointer(item.result), raw = item.result
    if (!isDraftId(raw.publicationId) || pointer.s3Key !== `articles/${pointer.slug}/revisions/${raw.publicationId}/page.mdx` || !isDraftId(raw.draftRevision) || !(raw.previousPublishedKey === null || publicKey(raw.previousPublishedKey, pointer.slug)) || raw.previousPublishedKey === pointer.s3Key || typeof raw.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.publishedAt) || !Number.isFinite(Date.parse(raw.publishedAt + 'T00:00:00.000Z')) || new Date(raw.publishedAt + 'T00:00:00.000Z').toISOString().slice(0, 10) !== raw.publishedAt || !iso(raw.updatedAt) || typeof raw.refreshPending !== 'boolean') fail()
    result = { ...pointer, publicationId: raw.publicationId, draftRevision: raw.draftRevision, previousPublishedKey: raw.previousPublishedKey, publishedAt: raw.publishedAt, updatedAt: raw.updatedAt, refreshPending: raw.refreshPending }
  }
  if ((['committed', 'superseded'].includes(item.status)) !== !!result || (result && current && current.slug !== result.slug) || (item.status === 'committed' && current && current.s3Key !== result?.s3Key) || (item.status === 'superseded' && current?.s3Key === result?.s3Key)) fail()
  return { operationId, draftId: item.draftId, createdAt: item.createdAt, status: item.status, ...(result ? { result } : {}), ...(current ? { current } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > 16 * 1024) { await response.body?.cancel(); fail() }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 16 * 1024) { await reader.cancel(); fail() }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } catch { fail() } finally { reader.releaseLock() }
}
async function publicationRequest(apiUrl: string, token: string, operationId: string, signal: AbortSignal, mode: 'publish' | 'get' | 'refresh', input: { draftId: string; revision: string; expectedPublishedKey: string | null } | null, transport: typeof fetch): Promise<WritingPublicationOutcome> {
  if (!isDraftId(operationId) || (input && (!isDraftId(input.draftId) || !isDraftId(input.revision) || !(input.expectedPublishedKey === null || publicKey(input.expectedPublishedKey))))) fail('INVALID_REQUEST')
  const path = mode === 'publish' ? `/drafts/${input!.draftId}/publications` : `/publications/${operationId}${mode === 'refresh' ? '/refresh' : ''}`
  let response: Response
  try {
    response = await transport(`${apiUrl}/v1/writings${path}`, {
      method: mode === 'get' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(mode === 'publish' ? { 'Content-Type': 'application/json', 'If-Match': `"${input!.revision}"`, 'Idempotency-Key': operationId } : {}) },
      ...(mode === 'publish' ? { body: JSON.stringify({ expectedPublishedKey: input!.expectedPublishedKey, confirm: true }) } : {}),
      signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
  } catch { fail() }
  let value: unknown
  try { value = await boundedJson(response) } catch {
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied')
    fail()
  }
  if (![200, 201, 202, 412, 422].includes(response.status)) {
    const rawId = (value as { error?: { requestId?: unknown } } | null)?.error?.requestId
    const requestId = typeof rawId === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(rawId) ? rawId : undefined
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied', requestId)
    throw new WritingPublicationFailure(mode === 'get' && response.status === 404 ? 'OPERATION_NOT_FOUND' : response.status === 409 ? mode === 'refresh' ? 'REFRESH_NOT_PROVEN' : 'OPERATION_REUSED' : response.status === 400 ? 'INVALID_REQUEST' : 'UNAVAILABLE', requestId)
  }
  if (!response.headers.get('cache-control')?.split(',').some(part => part.trim().toLowerCase() === 'no-store')) fail()
  const outcome = parseWritingPublicationOutcome(value, operationId)
  if (mode === 'publish') {
    if (outcome.draftId !== input!.draftId || (outcome.result && (outcome.result.previousPublishedKey !== input!.expectedPublishedKey || outcome.result.draftRevision === input!.revision)) ||
        (response.status === 201 && outcome.status !== 'committed') || (response.status === 200 && !['committed', 'superseded'].includes(outcome.status)) || (response.status === 202 && !['unknown', 'in_progress'].includes(outcome.status)) || (response.status === 412 && outcome.status !== 'conflict') || (response.status === 422 && outcome.status !== 'failed')) fail()
  } else if (response.status !== 200) fail()
  return outcome
}
export function publishWriting(apiUrl: string, token: string, draftId: string, revision: string, expectedPublishedKey: string | null, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<WritingPublicationOutcome> {
  return publicationRequest(apiUrl, token, operationId, signal, 'publish', { draftId, revision, expectedPublishedKey }, transport)
}
export function getWritingPublication(apiUrl: string, token: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<WritingPublicationOutcome> {
  return publicationRequest(apiUrl, token, operationId, signal, 'get', null, transport)
}
export function refreshWritingPublication(apiUrl: string, token: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<WritingPublicationOutcome> {
  return publicationRequest(apiUrl, token, operationId, signal, 'refresh', null, transport)
}

export interface WritingPublicationSelection {
  ownerSub: string; saved: WritingDraft | null; working: DraftInput | null; eligible: boolean
}
export interface WritingPublicationReview {
  readonly operationId: string; readonly ownerSub: string; readonly saved: WritingDraft
  readonly expectedPublishedKey: string | null; readonly current: PublishedWriting | null; readonly preview: DraftPreview
}
export function canReviewWriting(selection: WritingPublicationSelection): boolean {
  return OWNER.test(selection.ownerSub) && selection.eligible && !!selection.saved && !!selection.working && slug(selection.saved.targetSlug) && sameDraftInput(selection.working, draftInput(selection.saved))
}
export function captureWritingPublicationReview(selection: WritingPublicationSelection, current: PublishedWriting | null, preview: DraftPreview, operationId: string, now = Date.now()): WritingPublicationReview {
  if (!canReviewWriting(selection) || !isDraftId(operationId)) fail('REVIEW_CHANGED')
  const saved = parseWritingDraft(selection.saved, selection.saved!.draftId, `"${selection.saved!.revision}"`, selection.ownerSub)
  if (preview.draftId !== saved.draftId || preview.revision !== saved.revision || typeof preview.html !== 'string' || preview.fieldErrors.length || !iso(preview.expiresAt) || Date.parse(preview.expiresAt) <= now) fail('PREVIEW_INVALID')
  const expectedPublishedKey = saved.basePublished?.s3Key ?? null
  if ((expectedPublishedKey === null ? current !== null : !current || current.s3Key !== expectedPublishedKey || current.slug !== saved.targetSlug)) fail('PUBLIC_BASE_CHANGED')
  saved.assets.forEach(Object.freeze); Object.freeze(saved.assets)
  if (saved.basePublished) Object.freeze(saved.basePublished)
  Object.freeze(saved)
  const frozenCurrent = current ? Object.freeze({ ...current, assets: Object.freeze(current.assets.map(asset => Object.freeze({ ...asset }))) as unknown as PublishedWriting['assets'], unsupportedAssets: Object.freeze(current.unsupportedAssets.map(asset => Object.freeze({ ...asset }))) as unknown as PublishedWriting['unsupportedAssets'] }) : null
  const frozenPreview = Object.freeze({ ...preview, fieldErrors: Object.freeze([]) as unknown as DraftPreview['fieldErrors'] })
  return Object.freeze({ operationId, ownerSub: selection.ownerSub, saved, expectedPublishedKey, current: frozenCurrent, preview: frozenPreview })
}
export function canApproveWriting(review: WritingPublicationReview, selection: WritingPublicationSelection, now = Date.now()): boolean {
  return canReviewWriting(selection) && selection.ownerSub === review.ownerSub && selection.saved!.draftId === review.saved.draftId && selection.saved!.revision === review.saved.revision && (selection.saved!.basePublished?.s3Key ?? null) === review.expectedPublishedKey && sameDraftInput(draftInput(selection.saved!), draftInput(review.saved)) && Date.parse(review.preview.expiresAt) > now
}
export function writingPublicationCheckpointKey(scope: string, ownerSub: string): string {
  if (!scope || !OWNER.test(ownerSub)) fail('INVALID_REQUEST')
  return `janeway.writing-publication.${encodeURIComponent(scope)}.${ownerSub}`
}
export function readWritingPublicationCheckpoint(storage: Pick<Storage, 'getItem'>, scope: string, ownerSub: string): string | null {
  const value = storage.getItem(writingPublicationCheckpointKey(scope, ownerSub))
  return value && isDraftId(value) ? value : null
}
export function saveWritingPublicationCheckpoint(storage: Pick<Storage, 'setItem' | 'getItem'>, scope: string, ownerSub: string, operationId: string): void {
  if (!isDraftId(operationId)) fail('INVALID_REQUEST')
  const key = writingPublicationCheckpointKey(scope, ownerSub)
  try { storage.setItem(key, operationId); if (storage.getItem(key) !== operationId) fail() } catch { fail() }
}
export function clearWritingPublicationCheckpoint(storage: Pick<Storage, 'removeItem'>, scope: string, ownerSub: string): void { storage.removeItem(writingPublicationCheckpointKey(scope, ownerSub)) }

export interface WritingPublicationState {
  phase: 'idle' | 'reviewing' | 'publishing' | 'checking' | 'refreshing'
  review: WritingPublicationReview | null; validation: DraftPreview['fieldErrors']; approved: boolean
  operationId: string | null; outcome: WritingPublicationOutcome | null; unresolved: boolean; uncertaintyAcknowledged: boolean
  error: WritingPublicationFailureCode | null; requestId?: string; baselinePending: boolean
}
const INITIAL: WritingPublicationState = { phase: 'idle', review: null, validation: [], approved: false, operationId: null, outcome: null, unresolved: false, uncertaintyAcknowledged: false, error: null, baselinePending: false }
type BaselineCallback = (draft: WritingDraft, reviewedRevision: string | null) => boolean | void
export class WritingPublicationController {
  private state: WritingPublicationState = INITIAL
  private selection: WritingPublicationSelection = { ownerSub: '', saved: null, working: null, eligible: false }
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private request: AbortController | null = null
  private checkpoint: ((operationId: string | null) => void) | null = null
  private advanceBaseline: BaselineCallback | null = null
  private intentReview: WritingPublicationReview | null = null
  private adoptedOperationId: string | null = null
  private readonly reviewIds = new Set<string>()
  getSnapshot = (): WritingPublicationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  configure(checkpoint: (operationId: string | null) => void, advanceBaseline: BaselineCallback): void { this.checkpoint = checkpoint; this.advanceBaseline = advanceBaseline }
  setSelection(selection: WritingPublicationSelection): void { this.selection = selection }
  private emit(update: Partial<WritingPublicationState>): void { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener() }
  invalidateApproval(): void { if (this.state.approved && (!this.state.review || !canApproveWriting(this.state.review, this.selection))) this.emit({ approved: false }) }
  approve(approved: boolean): void { this.emit({ approved: approved && !!this.state.review && canApproveWriting(this.state.review, this.selection) && this.state.phase === 'idle' && !this.state.operationId }) }
  acknowledgeUncertainty(acknowledged: boolean): void { this.emit({ uncertaintyAcknowledged: acknowledged && this.state.unresolved && this.state.outcome?.status !== 'in_progress' }) }
  expirePreview(): void { if (this.state.phase !== 'publishing' && this.state.review && Date.parse(this.state.review.preview.expiresAt) <= Date.now()) this.emit({ review: null, approved: false, error: 'PREVIEW_INVALID' }) }
  recoveryStorageUnavailable(): void { this.emit({ error: 'UNAVAILABLE', approved: false }) }
  private start(phase: WritingPublicationState['phase']): { epoch: number; request: AbortController } {
    const request = new AbortController(); this.request = request
    this.emit({ phase, error: null, requestId: undefined, uncertaintyAcknowledged: false })
    return { epoch: this.epoch, request }
  }
  private current(work: { epoch: number; request: AbortController }): boolean { return work.epoch === this.epoch && !work.request.signal.aborted }
  private finish(work: { epoch: number; request: AbortController }): void { if (this.current(work)) { this.request = null; this.emit({ phase: 'idle' }) } }
  private problem(error: unknown, fallback: WritingPublicationFailureCode = 'UNAVAILABLE'): void {
    const failure = error instanceof WritingPublicationFailure ? error : null
    this.emit({ error: failure?.code ?? (error instanceof DraftFailure && error.code === 'REVISION_CONFLICT' ? 'REVIEW_CHANGED' : fallback), requestId: failure?.requestId })
  }
  async review(client: WritingPublicationSession, operationId: string): Promise<void> {
    if (this.state.phase !== 'idle' || !canReviewWriting(this.selection) || !isDraftId(operationId) || (this.state.unresolved && !this.state.uncertaintyAcknowledged) || operationId === this.state.operationId || this.reviewIds.has(operationId)) return
    const selected = this.selection
    try { this.checkpoint?.(null) } catch { this.problem(new WritingPublicationFailure('UNAVAILABLE')); return }
    const work = this.start('reviewing')
    this.emit({ review: null, validation: [], approved: false, operationId: null, outcome: null, unresolved: false, baselinePending: false })
    this.intentReview = null
    this.reviewIds.add(operationId)
    try {
      const saved = parseWritingDraft(selected.saved, selected.saved!.draftId, `"${selected.saved!.revision}"`, selected.ownerSub)
      const selection = { ...selected, saved, working: selected.working ? { ...selected.working, assets: selected.working.assets.map(ref => ({ ...ref })) } : null }
      const currentPromise = client.getPublishedWriting(saved.targetSlug, work.request.signal).catch(error => {
        if (error instanceof DraftFailure && error.code === 'NOT_FOUND') return null
        throw error
      })
      const [current, preview] = await Promise.all([currentPromise, client.previewWritingDraft(saved.draftId, saved.revision, work.request.signal)])
      if (!this.current(work)) return
      this.emit({ validation: preview.fieldErrors })
      const review = captureWritingPublicationReview(selection, current, preview, operationId)
      if (!canApproveWriting(review, this.selection)) fail('REVIEW_CHANGED')
      this.emit({ review, approved: false })
    } catch (error) { if (this.current(work)) this.problem(error) }
    finally { this.finish(work) }
  }
  private async accept(client: WritingPublicationSession, raw: WritingPublicationOutcome, operationId: string, review: WritingPublicationReview | null, work: { epoch: number; request: AbortController }): Promise<void> {
    const outcome = parseWritingPublicationOutcome(raw, operationId)
    if (review && (outcome.draftId !== review.saved.draftId || (outcome.result && (outcome.result.slug !== review.saved.targetSlug || outcome.result.previousPublishedKey !== review.expectedPublishedKey || outcome.result.draftRevision === review.saved.revision)))) fail()
    const unresolved = ['unknown', 'in_progress'].includes(outcome.status)
    this.emit({ outcome, unresolved, approved: false, review: null, validation: [], baselinePending: !!outcome.result && outcome.status === 'committed' })
    if (!unresolved) { try { this.checkpoint?.(null) } catch { /* Durable proof remains valid even when local cleanup is unavailable. */ } }
    if (outcome.status !== 'committed' || !outcome.result) return
    try {
      const saved = await client.getWritingDraft(outcome.draftId, work.request.signal)
      if (!this.current(work)) return
      if (saved.draftId !== outcome.draftId || saved.revision !== outcome.result.draftRevision || saved.basePublished?.s3Key !== outcome.result.s3Key || saved.basePublished?.slug !== outcome.result.slug || (review && !sameDraftInput(draftInput(saved), draftInput(review.saved)))) fail('BASELINE_UNAVAILABLE')
      if (this.selection.saved?.draftId !== saved.draftId || (review && this.selection.ownerSub !== review.ownerSub)) { this.emit({ baselinePending: true }); return }
      const advanced = this.adoptedOperationId === operationId || this.advanceBaseline?.(saved, review?.saved.revision ?? null) === true
      if (advanced) this.adoptedOperationId = operationId
      this.emit({ baselinePending: !advanced })
    } catch { if (this.current(work)) this.emit({ baselinePending: true, error: 'BASELINE_UNAVAILABLE' }) }
  }
  async publish(client: WritingPublicationSession): Promise<void> {
    const review = this.state.review
    if (this.state.phase !== 'idle' || !this.state.approved || this.state.operationId || !review || !canApproveWriting(review, this.selection)) return
    try { if (!this.checkpoint) fail(); this.checkpoint(review.operationId) }
    catch (error) { this.problem(error); this.emit({ approved: false }); return }
    const work = this.start('publishing')
    this.emit({ operationId: review.operationId, unresolved: true, approved: false })
    this.intentReview = review
    try {
      const outcome = await client.publishWriting(review.saved.draftId, review.saved.revision, review.expectedPublishedKey, review.operationId, work.request.signal)
      if (this.current(work)) await this.accept(client, outcome, review.operationId, review, work)
    } catch (error) {
      if (!this.current(work)) return
      this.problem(error)
      const terminal = error instanceof WritingPublicationFailure && ['INVALID_REQUEST', 'OPERATION_REUSED'].includes(error.code)
      if (terminal) { try { this.checkpoint?.(null) } catch { /* A rejected request is not a successful publication. */ } }
      this.emit({ unresolved: !terminal, review: null })
    } finally { this.finish(work) }
  }
  async recover(client: WritingPublicationSession, operationId = this.state.operationId): Promise<void> {
    if (!operationId || !isDraftId(operationId) || this.state.phase !== 'idle') return
    this.reviewIds.add(operationId)
    const review = this.intentReview, work = this.start('checking')
    this.emit({ operationId, approved: false, review: null, validation: [], unresolved: true })
    try {
      const outcome = await client.getWritingPublication(operationId, work.request.signal)
      if (this.current(work)) await this.accept(client, outcome, operationId, review, work)
    } catch (error) { if (this.current(work)) { this.problem(error); this.emit({ unresolved: true }) } }
    finally { this.finish(work) }
  }
  async refresh(client: WritingPublicationSession): Promise<void> {
    const previous = this.state.outcome
    if (this.state.phase !== 'idle' || previous?.status !== 'committed' || !previous.result?.refreshPending) return
    const work = this.start('refreshing')
    try {
      const outcome = parseWritingPublicationOutcome(await client.refreshWritingPublication(previous.operationId, work.request.signal), previous.operationId)
      if (!this.current(work)) return
      if (!outcome.result || outcome.draftId !== previous.draftId || outcome.result.s3Key !== previous.result.s3Key || outcome.result.draftRevision !== previous.result.draftRevision) fail()
      this.emit({ outcome, unresolved: false })
    } catch (error) { if (this.current(work)) this.problem(error) }
    finally { this.finish(work) }
  }
  suspend(): void {
    this.epoch++; this.request?.abort(); this.request = null
    this.selection = { ownerSub: '', saved: null, working: null, eligible: false }
    this.intentReview = null
    this.adoptedOperationId = null
    this.emit({ ...INITIAL })
  }
}
