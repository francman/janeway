import { ApiError } from './api'

export const MAX_PDF_BYTES = 10 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_ID = /^[A-Za-z0-9._~+/=-]{1,1024}$/
const SHA256 = /^[0-9a-f]{64}$/
const STAGING_ORIGIN = /^https:\/\/janeway-resume-staging-\d{12}-us-east-1\.s3\.us-east-1\.amazonaws\.com$/
const OWNER_SUB = /^[A-Za-z0-9_-]{1,128}$/
const GRANT_TTL_MS = 5 * 60 * 1000
const RECEIPT_TTL_MS = 60 * 60 * 1000
const TRANSFER_TIMEOUT_MS = 120_000

export type UploadFailureCode = 'INVALID_REQUEST' | 'FILE_TOO_LARGE' | 'UPLOAD_NOT_FOUND' | 'INVALID_PDF' | 'VALIDATION_NOT_FOUND' | 'VALIDATION_EXPIRED' | 'UNAVAILABLE' | 'TRANSFER_REJECTED' | 'TRANSFER_INTERRUPTED'
export class UploadFailure extends Error {
  constructor(readonly code: UploadFailureCode, readonly requestId?: string) { super(code) }
}
export interface UploadAuthorization {
  uploadId: string
  upload: { url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number }
}
export interface ValidationReceipt {
  schemaVersion: 1
  validationId: string
  uploadId: string
  key: string
  versionId: string
  sha256: string
  bytes: number
  pageCount: number
  validatedAt: string
  expiresAt: string
}
export interface PreviewGrant { url: string; expiresAt: string }
type PromiseResolvers<T> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }

function safeError(value: unknown): { code?: string; requestId?: string } {
  const body = value as { error?: { code?: unknown; requestId?: unknown } } | null
  return {
    code: typeof body?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(body.error.code) ? body.error.code : undefined,
    requestId: typeof body?.error?.requestId === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(body.error.requestId) ? body.error.requestId : undefined,
  }
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
async function privateJson(apiUrl: string, path: string, method: 'GET' | 'POST', token: string, signal: AbortSignal, body?: unknown, transport: typeof fetch = fetch): Promise<unknown> {
  let response: Response
  try {
    response = await transport(apiUrl + path, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    })
  } catch { throw new UploadFailure('UNAVAILABLE') }
  let value: unknown
  try { value = await response.json() } catch { value = null }
  if (!response.ok) {
    const error = safeError(value)
    if (response.status === 401) throw new ApiError('expired', error.requestId)
    if (response.status === 403) throw new ApiError('denied', error.requestId)
    const supported: UploadFailureCode[] = ['INVALID_REQUEST', 'FILE_TOO_LARGE', 'UPLOAD_NOT_FOUND', 'INVALID_PDF', 'VALIDATION_NOT_FOUND', 'VALIDATION_EXPIRED', 'UNAVAILABLE']
    throw new UploadFailure(supported.includes(error.code as UploadFailureCode) ? error.code as UploadFailureCode : 'UNAVAILABLE', error.requestId)
  }
  if (!response.headers.get('cache-control')?.split(',').some(part => part.trim().toLowerCase() === 'no-store')) throw new UploadFailure('UNAVAILABLE')
  return value
}

function uploadKey(ownerSub: string, uploadId: string): string {
  if (typeof ownerSub !== 'string' || !OWNER_SUB.test(ownerSub) || typeof uploadId !== 'string' || !UUID.test(uploadId)) throw new UploadFailure('INVALID_REQUEST')
  return `uploads/${ownerSub}/${uploadId}/file.pdf`
}
function validAuthorization(value: UploadAuthorization | null, stagingOrigin: string, ownerSub: string, now: number): value is UploadAuthorization {
  return !!value && typeof value.uploadId === 'string' && UUID.test(value.uploadId) && STAGING_ORIGIN.test(stagingOrigin) &&
    value.upload?.url === `${stagingOrigin}/` && value.upload.maxBytes === MAX_PDF_BYTES && iso(value.upload.expiresAt) &&
    Date.parse(value.upload.expiresAt) > now && Date.parse(value.upload.expiresAt) <= now + GRANT_TTL_MS + 5000 &&
    !!value.upload.fields && typeof value.upload.fields === 'object' && !Array.isArray(value.upload.fields) &&
    Object.values(value.upload.fields).every(field => typeof field === 'string') &&
    value.upload.fields.key === uploadKey(ownerSub, value.uploadId) &&
    value.upload.fields['Content-Type'] === 'application/pdf' && value.upload.fields.success_action_status === '201' &&
    value.upload.fields['x-amz-server-side-encryption'] === 'AES256'
}
function validReceipt(value: ValidationReceipt | null, ownerSub: string, now: number): value is ValidationReceipt {
  return !!value && value.schemaVersion === 1 && typeof value.validationId === 'string' && UUID.test(value.validationId) &&
    typeof value.uploadId === 'string' && UUID.test(value.uploadId) && typeof value.versionId === 'string' && value.versionId !== 'null' && VERSION_ID.test(value.versionId) &&
    typeof value.sha256 === 'string' && SHA256.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 1 && value.bytes <= MAX_PDF_BYTES &&
    Number.isSafeInteger(value.pageCount) && value.pageCount >= 1 && value.pageCount <= 200 && iso(value.validatedAt) && iso(value.expiresAt) &&
    Date.parse(value.validatedAt) <= now + 5000 && Date.parse(value.expiresAt) > now &&
    Date.parse(value.expiresAt) - Date.parse(value.validatedAt) === RECEIPT_TTL_MS && value.key === uploadKey(ownerSub, value.uploadId)
}
export async function authorizeResumeUpload(apiUrl: string, stagingOrigin: string, ownerSub: string, token: string, file: File, signal: AbortSignal, transport?: typeof fetch): Promise<UploadAuthorization> {
  if (typeof ownerSub !== 'string' || !OWNER_SUB.test(ownerSub) || file.size < 1 || file.size > MAX_PDF_BYTES || file.type !== 'application/pdf' ||
      file.name.length < 1 || file.name.length > 128 || file.name.trim() !== file.name || /[\\/\x00-\x1f\x7f]/.test(file.name) || !/[.]pdf$/i.test(file.name)) {
    throw new UploadFailure(file.size > MAX_PDF_BYTES ? 'FILE_TOO_LARGE' : 'INVALID_REQUEST')
  }
  const value = await privateJson(apiUrl, '/v1/resume/uploads', 'POST', token, signal, { filename: file.name, bytes: file.size, contentType: file.type }, transport) as UploadAuthorization | null
  if (!validAuthorization(value, stagingOrigin, ownerSub, Date.now())) throw new UploadFailure('UNAVAILABLE')
  return value
}
export async function validateResumeUpload(apiUrl: string, ownerSub: string, token: string, uploadId: string, versionId: string, signal: AbortSignal, transport?: typeof fetch): Promise<ValidationReceipt> {
  uploadKey(ownerSub, uploadId)
  if (typeof versionId !== 'string' || versionId === 'null' || !VERSION_ID.test(versionId)) throw new UploadFailure('INVALID_REQUEST')
  const value = await privateJson(apiUrl, `/v1/resume/uploads/${uploadId}/validate`, 'POST', token, signal, { versionId }, transport) as ValidationReceipt | null
  if (!validReceipt(value, ownerSub, Date.now()) || value.uploadId !== uploadId || value.versionId !== versionId) throw new UploadFailure('UNAVAILABLE')
  return value
}
export async function getResumePreview(apiUrl: string, stagingOrigin: string, ownerSub: string, token: string, receipt: ValidationReceipt, signal: AbortSignal, transport?: typeof fetch): Promise<PreviewGrant> {
  if (!validReceipt(receipt, ownerSub, Date.now())) throw new UploadFailure('VALIDATION_EXPIRED')
  const value = await privateJson(apiUrl, `/v1/resume/validations/${receipt.validationId}/preview`, 'GET', token, signal, undefined, transport) as PreviewGrant | null
  let url: URL
  try { url = new URL(value?.url ?? '') } catch { throw new UploadFailure('UNAVAILABLE') }
  const now = Date.now()
  if (Date.parse(receipt.expiresAt) <= now) throw new UploadFailure('VALIDATION_EXPIRED')
  if (!value || !STAGING_ORIGIN.test(stagingOrigin) || url.origin !== stagingOrigin || url.username || url.password || url.hash ||
      url.pathname !== `/${receipt.key}` || url.searchParams.getAll('versionId').length !== 1 || url.searchParams.get('versionId') !== receipt.versionId ||
      !iso(value.expiresAt) || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + GRANT_TTL_MS + 5000 ||
      Date.parse(value.expiresAt) > Date.parse(receipt.expiresAt)) throw new UploadFailure('UNAVAILABLE')
  return { url: url.href, expiresAt: value.expiresAt }
}

export function uploadPdfToStaging(stagingOrigin: string, ownerSub: string, authorization: UploadAuthorization, file: File, signal: AbortSignal, onProgress: (loaded: number, total: number) => void, createXhr: () => XMLHttpRequest = () => new XMLHttpRequest()): Promise<{ versionId: string; etag: string | null }> {
  const { promise, resolve, reject } = (Promise as PromiseConstructor & { withResolvers<T>(): PromiseResolvers<T> }).withResolvers<{ versionId: string; etag: string | null }>()
  if (signal.aborted) { reject(new UploadFailure('TRANSFER_INTERRUPTED')); return promise }
  if (typeof ownerSub !== 'string' || !OWNER_SUB.test(ownerSub) || !validAuthorization(authorization, stagingOrigin, ownerSub, Date.now())) {
    reject(new UploadFailure('UNAVAILABLE'))
    return promise
  }
  const xhr = createXhr()
  let settled = false
  const abort = () => {
    finish(() => reject(new UploadFailure('TRANSFER_INTERRUPTED')))
    xhr.abort()
  }
  const finish = (operation: () => void) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    xhr.upload.onprogress = null
    xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
    operation()
  }
  try {
    const form = new FormData()
    for (const [key, value] of Object.entries(authorization.upload.fields)) form.append(key, value)
    form.append('file', file)
    xhr.open('POST', authorization.upload.url)
    xhr.timeout = Math.min(TRANSFER_TIMEOUT_MS, Date.parse(authorization.upload.expiresAt) - Date.now())
    if (xhr.timeout <= 0) { finish(() => reject(new UploadFailure('UNAVAILABLE'))); return promise }
    xhr.withCredentials = false
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => finish(() => reject(new UploadFailure('TRANSFER_INTERRUPTED')))
    xhr.onload = () => finish(() => {
      if (xhr.status !== 201) return reject(new UploadFailure('TRANSFER_REJECTED'))
      const versionId = xhr.getResponseHeader('x-amz-version-id')
      if (!versionId || versionId === 'null' || !VERSION_ID.test(versionId)) return reject(new UploadFailure('UNAVAILABLE'))
      resolve({ versionId, etag: xhr.getResponseHeader('etag') })
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else xhr.send(form)
  } catch { finish(() => reject(new UploadFailure('TRANSFER_INTERRUPTED'))) }
  return promise
}
