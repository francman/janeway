import { ApiError, parseResume, type ResumeMetadata } from './api'
import { MAX_PDF_BYTES, type ValidationReceipt } from './resume-upload'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OWNER = /^[A-Za-z0-9_-]{1,128}$/
const MAX_RESPONSE_BYTES = 16 * 1024
const statuses = ['in_progress', 'committed', 'failed', 'conflict', 'unknown', 'superseded'] as const
export type PublicationStatus = typeof statuses[number]
export type PublicationErrorCode = 'VALIDATION_NOT_FOUND' | 'VALIDATION_EXPIRED' | 'INVALID_RECEIPT' | 'SOURCE_NOT_FOUND' | 'SOURCE_INTEGRITY' | 'REVISION_INTEGRITY' | 'PRECONDITION_FAILED' | 'DEADLINE_EXCEEDED' | 'OUTCOME_UNCERTAIN' | 'UNAVAILABLE'
const domainErrors: readonly string[] = ['VALIDATION_NOT_FOUND', 'VALIDATION_EXPIRED', 'INVALID_RECEIPT', 'SOURCE_NOT_FOUND', 'SOURCE_INTEGRITY', 'REVISION_INTEGRITY', 'PRECONDITION_FAILED', 'DEADLINE_EXCEEDED', 'OUTCOME_UNCERTAIN', 'UNAVAILABLE']
export interface PublicationOutcome {
  operationId: string
  status: PublicationStatus
  createdAt: string
  result?: ResumeMetadata
  current?: ResumeMetadata
  errorCode?: PublicationErrorCode
}
export class PublicationFailure extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'OPERATION_NOT_FOUND' | 'OPERATION_REUSED' | 'UNAVAILABLE', readonly requestId?: string) { super(code) }
}
export interface PublicationReview {
  readonly operationId: string
  readonly ownerSub: string
  readonly receipt: Readonly<ValidationReceipt>
  readonly filename: string
  readonly current: Readonly<ResumeMetadata>
  readonly expectedEtag: string
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function etag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value)
}
function metadata(value: unknown): ResumeMetadata {
  const item = value as ResumeMetadata | null
  if (!item || !etag(item.etag)) throw new PublicationFailure('UNAVAILABLE')
  try { return parseResume(value, item.etag) }
  catch { throw new PublicationFailure('UNAVAILABLE') }
}
export function parsePublicationOutcome(value: unknown, operationId: string, now = Date.now()): PublicationOutcome {
  const item = value as PublicationOutcome | null
  if (!item || typeof item !== 'object' || Array.isArray(item) || !UUID.test(operationId) || item.operationId !== operationId ||
      !statuses.includes(item.status) || !iso(item.createdAt) || Date.parse(item.createdAt) <= 0 || Date.parse(item.createdAt) > now + 5000 ||
      Object.keys(item).some(key => !['operationId', 'status', 'createdAt', 'result', 'current', 'errorCode'].includes(key)) ||
      (item.errorCode !== undefined && !domainErrors.includes(item.errorCode))) throw new PublicationFailure('UNAVAILABLE')
  const result = item.result === undefined ? undefined : metadata(item.result)
  const current = item.current === undefined ? undefined : metadata(item.current)
  if ((item.status === 'committed' || item.status === 'superseded') !== !!result ||
      (item.status === 'superseded' && current?.publicationId === result?.publicationId) ||
      (item.status === 'committed' && current && (['schemaVersion', 'publicationId', 'key', 'sha256', 'bytes', 'publishedAt', 'publicUrl', 'etag'] as const).some(key => current[key] !== result?.[key])) ||
      (['committed', 'superseded', 'in_progress'].includes(item.status) && item.errorCode !== undefined) ||
      (item.status === 'conflict' && item.errorCode !== undefined && item.errorCode !== 'PRECONDITION_FAILED') ||
      (item.status === 'unknown' && item.errorCode !== undefined && item.errorCode !== 'OUTCOME_UNCERTAIN')) throw new PublicationFailure('UNAVAILABLE')
  return { operationId, status: item.status, createdAt: item.createdAt, ...(result ? { result } : {}), ...(current ? { current } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) }
}
function validReceipt(receipt: ValidationReceipt | null, ownerSub: string, now: number): receipt is ValidationReceipt {
  return !!receipt && OWNER.test(ownerSub) && receipt.schemaVersion === 1 && typeof receipt.validationId === 'string' && UUID.test(receipt.validationId) &&
    typeof receipt.uploadId === 'string' && UUID.test(receipt.uploadId) && receipt.key === `uploads/${ownerSub}/${receipt.uploadId}/file.pdf` &&
    typeof receipt.versionId === 'string' && receipt.versionId !== 'null' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(receipt.versionId) &&
    /^[0-9a-f]{64}$/.test(receipt.sha256) && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= MAX_PDF_BYTES &&
    Number.isSafeInteger(receipt.pageCount) && receipt.pageCount > 0 && receipt.pageCount <= 200 && iso(receipt.validatedAt) && iso(receipt.expiresAt) &&
    Date.parse(receipt.validatedAt) <= now + 5000 && Date.parse(receipt.expiresAt) > now && Date.parse(receipt.expiresAt) - Date.parse(receipt.validatedAt) === 3600000
}
export function capturePublicationReview(receipt: ValidationReceipt | null, filename: string, previewAvailable: boolean, current: ResumeMetadata, operationId: string, ownerSub: string, now = Date.now()): PublicationReview {
  if (!validReceipt(receipt, ownerSub, now) || !previewAvailable || !UUID.test(operationId) || !filename || filename.length > 128 ||
      filename.trim() !== filename || /[\\/\x00-\x1f\x7f]/.test(filename) || !/[.]pdf$/i.test(filename)) throw new PublicationFailure('INVALID_REQUEST')
  const reviewed = metadata(current)
  return Object.freeze({ operationId, ownerSub, receipt: Object.freeze({ ...receipt }), filename, current: Object.freeze(reviewed), expectedEtag: reviewed.etag })
}
export function canConfirmPublication(review: PublicationReview, receipt: ValidationReceipt | null, filename: string, previewAvailable: boolean, ownerSub: string, now = Date.now()): boolean {
  return previewAvailable && ownerSub === review.ownerSub && validReceipt(receipt, ownerSub, now) && filename === review.filename &&
    (['validationId', 'uploadId', 'key', 'versionId', 'sha256', 'bytes', 'validatedAt', 'expiresAt'] as const).every(key => receipt[key] === review.receipt[key])
}
export function publicationCheckpointKey(scope: string, ownerSub: string): string {
  if (!scope || !OWNER.test(ownerSub)) throw new PublicationFailure('INVALID_REQUEST')
  return `janeway.resume-publication.${encodeURIComponent(scope)}.${ownerSub}`
}
export function readPublicationCheckpoint(storage: Pick<Storage, 'getItem'>, scope: string, ownerSub: string): string | null {
  const value = storage.getItem(publicationCheckpointKey(scope, ownerSub))
  return value && UUID.test(value) ? value : null
}
export function savePublicationCheckpoint(storage: Pick<Storage, 'setItem' | 'getItem'>, scope: string, ownerSub: string, operationId: string): void {
  if (!UUID.test(operationId)) throw new PublicationFailure('INVALID_REQUEST')
  const key = publicationCheckpointKey(scope, ownerSub)
  storage.setItem(key, operationId)
  if (storage.getItem(key) !== operationId) throw new PublicationFailure('UNAVAILABLE')
}
export function clearPublicationCheckpoint(storage: Pick<Storage, 'removeItem'>, scope: string, ownerSub: string): void {
  storage.removeItem(publicationCheckpointKey(scope, ownerSub))
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new PublicationFailure('UNAVAILABLE')
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body.cancel()
    throw new PublicationFailure('UNAVAILABLE')
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new PublicationFailure('UNAVAILABLE') }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch { throw new PublicationFailure('UNAVAILABLE') }
  finally { reader.releaseLock() }
}
async function publicationRequest(apiUrl: string, token: string, operationId: string, signal: AbortSignal, request: { validationId: string; expectedEtag: string } | null, transport: typeof fetch): Promise<PublicationOutcome> {
  if (!UUID.test(operationId) || (request && (!UUID.test(request.validationId) || !etag(request.expectedEtag)))) throw new PublicationFailure('INVALID_REQUEST')
  let response: Response
  try {
    response = await transport(`${apiUrl}/v1/resume/publications${request ? '' : `/${operationId}`}`, {
      method: request ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(request ? { 'Content-Type': 'application/json', 'Idempotency-Key': operationId, 'If-Match': request.expectedEtag } : {}) },
      ...(request ? { body: JSON.stringify({ validationId: request.validationId, confirm: true }) } : {}),
      signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
  } catch { throw new PublicationFailure('UNAVAILABLE') }
  let value: unknown
  try { value = await boundedJson(response) } catch {
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied')
    throw new PublicationFailure('UNAVAILABLE')
  }
  if (response.status === 401 || response.status === 403 || ![200, 201, 202, 412, 422].includes(response.status)) {
    const error = (value as { error?: { requestId?: unknown } } | null)?.error
    const requestId = typeof error?.requestId === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(error.requestId) ? error.requestId : undefined
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied', requestId)
    throw new PublicationFailure(!request && response.status === 404 ? 'OPERATION_NOT_FOUND' : response.status === 409 ? 'OPERATION_REUSED' : response.status === 400 ? 'INVALID_REQUEST' : 'UNAVAILABLE', requestId)
  }
  if (!response.headers.get('cache-control')?.split(',').some(part => part.trim().toLowerCase() === 'no-store')) throw new PublicationFailure('UNAVAILABLE')
  const outcome = parsePublicationOutcome(value, operationId)
  if ((!request && response.status !== 200) || (request && ((response.status === 200 && !['committed', 'superseded'].includes(outcome.status)) || (response.status === 201 && outcome.status !== 'committed') ||
      (response.status === 202 && !['unknown', 'in_progress'].includes(outcome.status)) || (response.status === 412 && outcome.status !== 'conflict') ||
      (response.status === 422 && outcome.status !== 'failed')))) throw new PublicationFailure('UNAVAILABLE')
  return outcome
}
export function publishResume(apiUrl: string, token: string, validationId: string, expectedEtag: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<PublicationOutcome> {
  return publicationRequest(apiUrl, token, operationId, signal, { validationId, expectedEtag }, transport)
}
export function getResumePublication(apiUrl: string, token: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<PublicationOutcome> {
  return publicationRequest(apiUrl, token, operationId, signal, null, transport)
}
