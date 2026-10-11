import { ApiError } from './api'

export const MAX_DRAFT_BYTES = 256 * 1024
export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export const MAX_ASSETS = 19 // The canonical MDX is the twentieth bundle file.
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const OWNER = /^[A-Za-z0-9_-]{1,128}$/
const VERSION = /^[A-Za-z0-9._~+/=-]{1,1024}$/
const PRIVATE_ORIGIN = 'https://janeway-writing-drafts-486207805298-us-east-1.s3.us-east-1.amazonaws.com'
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const OP_STATUSES = ['in_progress', 'committed', 'failed', 'conflict', 'unknown', 'superseded'] as const
export type DraftStatus = typeof OP_STATUSES[number]
export type DraftFailureCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OPERATION_REUSED' | 'FORK_UNSUPPORTED' | 'FORK_BUDGET_EXCEEDED' | 'PUBLISHED_SOURCE_TOO_LARGE' | 'FILE_TOO_LARGE' | 'INVALID_IMAGE' | 'ASSET_NOT_FOUND' | 'UNAVAILABLE' | 'TRANSFER_INTERRUPTED' | 'TRANSFER_REJECTED'
export class DraftFailure extends Error {
  constructor(readonly code: DraftFailureCode, readonly requestId?: string) { super(code) }
}
export interface DraftMetadata {
  draftId: string
  label: string
  targetSlug: string
  revision: string
  createdAt: string
  updatedAt: string
  basePublished: { slug: string; s3Key: string } | null
}
export interface AssetReference { assetId: string; name: string }
export interface WritingAsset extends AssetReference {
  sha256: string; bytes: number; contentType: string; key: string; versionId: string; width: number; height: number
}
export interface DraftInput { label: string; targetSlug: string; sourceMdx: string; assets: AssetReference[] }
export type CreateDraftInput = { draftId: string; label: string; targetSlug: string; sourceMdx: string } | { draftId: string; fromPublishedSlug: string }
export interface WritingDraft extends DraftMetadata { schemaVersion: 1; sourceMdx: string; assets: WritingAsset[] }
export interface DraftPage { drafts: DraftMetadata[]; cursor: string | null }
export interface PublishedSummary { slug: string; title: string; s3Key: string }
export interface PublishedPage { writings: PublishedSummary[]; cursor: string | null }
export interface PublishedWriting extends PublishedSummary {
  sourceMdx: string
  assets: { name: string; bytes: number; contentType: string }[]
  unsupportedAssets: { name: string; reason: string }[]
}
export interface DraftOperation {
  operationId: string; status: DraftStatus; draftId: string | null; createdAt: string | null
  result?: DraftMetadata; current?: DraftMetadata; errorCode?: string
}
export interface AssetAuthorization { assetId: string; upload: { url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number } }
export interface AssetPreview { url: string; expiresAt: string }
export interface DraftPreview {
  draftId: string; revision: string; html: string | null
  fieldErrors: { field: string; code: string; message: string; line?: number; column?: number }[]
  expiresAt: string
}
export interface FrozenSave {
  readonly operationId: string; readonly draftId: string; readonly revision: string; readonly input: Readonly<DraftInput>
}
export interface WritingSession {
  listWritingDrafts(cursor?: string, signal?: AbortSignal): Promise<DraftPage>
  getWritingDraft(draftId: string, signal?: AbortSignal): Promise<WritingDraft>
  createWritingDraft(input: CreateDraftInput, operationId: string, signal?: AbortSignal): Promise<DraftOperation>
  saveWritingDraft(draftId: string, input: DraftInput, revision: string, operationId: string, signal?: AbortSignal): Promise<DraftOperation>
  getWritingOperation(operationId: string, signal?: AbortSignal): Promise<DraftOperation>
  listPublishedWritings(cursor?: string, signal?: AbortSignal): Promise<PublishedPage>
  getPublishedWriting(slug: string, signal?: AbortSignal): Promise<PublishedWriting>
  authorizeWritingAsset(draftId: string, file: File, signal?: AbortSignal): Promise<AssetAuthorization>
  validateWritingAsset(draftId: string, assetId: string, versionId: string, signal?: AbortSignal): Promise<WritingAsset>
  getWritingAssetPreview(draftId: string, asset: WritingAsset, signal?: AbortSignal): Promise<AssetPreview>
  previewWritingDraft(draftId: string, revision: string, signal?: AbortSignal): Promise<DraftPreview>
}
export function isDraftId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function text(value: unknown, max: number, blank = false): value is string { return typeof value === 'string' && value.length <= max && (blank || value.length > 0) }
function slug(value: unknown): value is string { return text(value, 128) && SLUG.test(value) }
export function writingSourceBytes(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes++
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}
function source(value: unknown): value is string { return typeof value === 'string' && writingSourceBytes(value) <= MAX_DRAFT_BYTES }
function name(value: unknown): value is string { return text(value, 128) && value.trim() === value && !/[\\/\x00-\x1f\x7f]/.test(value) }
function publishedKey(value: unknown, articleSlug: string): value is string {
  return typeof value === 'string' && new RegExp(`^articles/${articleSlug}/revisions/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/page\\.mdx$`).test(value)
}
function cursor(value: unknown): value is string | null { return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(value)) }
function fail(): never { throw new DraftFailure('UNAVAILABLE') }
export function parseDraftMetadata(value: unknown): DraftMetadata {
  const item = value as DraftMetadata | null
  if (!item || !isDraftId(item.draftId) || !text(item.label, 128, true) || !text(item.targetSlug, 128, true) || !isDraftId(item.revision) || !iso(item.createdAt) || !iso(item.updatedAt) || Date.parse(item.updatedAt) < Date.parse(item.createdAt) ||
      (item.basePublished !== null && (!item.basePublished || !slug(item.basePublished.slug) || !publishedKey(item.basePublished.s3Key, item.basePublished.slug) || item.targetSlug !== item.basePublished.slug))) fail()
  return { draftId: item.draftId, label: item.label, targetSlug: item.targetSlug, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt, basePublished: item.basePublished ? { slug: item.basePublished.slug, s3Key: item.basePublished.s3Key } : null }
}
export function parseWritingAsset(value: unknown, draftId: string, ownerSub?: string): WritingAsset {
  const item = value as WritingAsset | null
  if (!item || !isDraftId(item.assetId) || !name(item.name) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_ASSET_BYTES || !IMAGE_TYPES.includes(item.contentType as typeof IMAGE_TYPES[number]) || !text(item.versionId, 1024) || item.versionId === 'null' || !VERSION.test(item.versionId) || !Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1 || typeof item.key !== 'string' || !isDraftId(draftId)) fail()
  const keyPattern = new RegExp(`^drafts/${ownerSub ?? '[A-Za-z0-9_-]{1,128}'}/${draftId}/assets/${item.assetId}/image$`)
  if ((ownerSub && !OWNER.test(ownerSub)) || !keyPattern.test(item.key)) fail()
  return { assetId: item.assetId, name: item.name, sha256: item.sha256, bytes: item.bytes, contentType: item.contentType, key: item.key, versionId: item.versionId, width: item.width, height: item.height }
}
export function parseWritingDraft(value: unknown, draftId: string, etag: string | null, ownerSub?: string): WritingDraft {
  const item = value as WritingDraft | null, meta = parseDraftMetadata(value)
  if (!item || item.schemaVersion !== 1 || meta.draftId !== draftId || etag !== `"${meta.revision}"` || !source(item.sourceMdx) || !Array.isArray(item.assets) || item.assets.length > MAX_ASSETS) fail()
  const assets = item.assets.map(asset => parseWritingAsset(asset, draftId, ownerSub))
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length || new Set(assets.map(asset => asset.name)).size !== assets.length || writingSourceBytes(item.sourceMdx) + assets.reduce((sum, asset) => sum + asset.bytes, 0) > MAX_BUNDLE_BYTES) fail()
  return { ...meta, schemaVersion: 1, sourceMdx: item.sourceMdx, assets }
}
export function parseDraftOperation(value: unknown, operationId: string): DraftOperation {
  const item = value as DraftOperation | null
  if (!item || item.operationId !== operationId || !isDraftId(operationId) || !OP_STATUSES.includes(item.status) || (item.status === 'unknown' && item.draftId === null ? item.createdAt !== null : !isDraftId(item.draftId) || !iso(item.createdAt)) || (item.errorCode !== undefined && !/^[A-Z_]{1,64}$/.test(item.errorCode))) fail()
  const result = item.result === undefined ? undefined : parseDraftMetadata(item.result)
  const current = item.current === undefined ? undefined : parseDraftMetadata(item.current)
  if ((['committed', 'superseded'].includes(item.status)) !== !!result || (result && result.draftId !== item.draftId) || (current && current.draftId !== item.draftId) || (item.status === 'committed' && current && current.revision !== result?.revision) || (item.status === 'superseded' && (!current || current.revision === result?.revision))) fail()
  return { operationId, status: item.status, draftId: item.draftId, createdAt: item.createdAt, ...(result ? { result } : {}), ...(current ? { current } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) }
}
async function boundedJson(response: Response, max = 768 * 1024): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > max) { await response.body?.cancel(); fail() }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, body = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > max) { await reader.cancel(); fail() }
      body += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } catch { fail() } finally { reader.releaseLock() }
}
async function request(apiUrl: string, token: string, path: string, signal: AbortSignal, transport: typeof fetch, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ value: unknown; etag: string | null; status: number }> {
  let response: Response
  try {
    response = await transport(apiUrl + '/v1/writings' + path, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', redirect: 'error', signal })
  } catch { throw new DraftFailure('UNAVAILABLE') }
  let value: unknown
  try { value = await boundedJson(response) } catch {
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied')
    throw new DraftFailure('UNAVAILABLE')
  }
  if (!response.ok) {
    const envelope = value && typeof value === 'object' && 'error' in value ? value.error : null
    const code = envelope && typeof envelope === 'object' && 'code' in envelope && typeof envelope.code === 'string' ? envelope.code : undefined
    const rawRequestId = envelope && typeof envelope === 'object' && 'requestId' in envelope ? envelope.requestId : undefined
    const requestId = typeof rawRequestId === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(rawRequestId) ? rawRequestId : undefined
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status === 401 ? 'expired' : 'denied', requestId)
    const codes: DraftFailureCode[] = ['INVALID_REQUEST', 'NOT_FOUND', 'REVISION_CONFLICT', 'OPERATION_REUSED', 'FORK_UNSUPPORTED', 'FORK_BUDGET_EXCEEDED', 'PUBLISHED_SOURCE_TOO_LARGE', 'FILE_TOO_LARGE', 'INVALID_IMAGE', 'ASSET_NOT_FOUND']
    if (response.status === 412) throw new DraftFailure('REVISION_CONFLICT', requestId)
    throw new DraftFailure(codes.includes(code as DraftFailureCode) ? code as DraftFailureCode : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'OPERATION_REUSED' : response.status === 400 || response.status === 413 ? 'INVALID_REQUEST' : 'UNAVAILABLE', requestId)
  }
  if (!response.headers.get('cache-control')?.split(',').some(part => part.trim().toLowerCase() === 'no-store')) fail()
  return { value, etag: response.headers.get('etag'), status: response.status }
}
function id(value: string): string { if (!isDraftId(value)) throw new DraftFailure('INVALID_REQUEST'); return value }
function pageQuery(value?: string): string { if (value !== undefined && !cursor(value)) throw new DraftFailure('INVALID_REQUEST'); return '?limit=25' + (value ? `&cursor=${encodeURIComponent(value)}` : '') }
function validInput(input: DraftInput): void {
  if (!input || !text(input.label, 128, true) || !text(input.targetSlug, 128, true) || !source(input.sourceMdx) || !Array.isArray(input.assets) || input.assets.length > MAX_ASSETS || input.assets.some(asset => !isDraftId(asset.assetId) || !name(asset.name)) || new Set(input.assets.map(asset => asset.assetId)).size !== input.assets.length || new Set(input.assets.map(asset => asset.name)).size !== input.assets.length) throw new DraftFailure('INVALID_REQUEST')
}
export function captureDraftSave(draftId: string, input: DraftInput, revision: string, operationId: string): FrozenSave {
  id(draftId); id(revision); id(operationId); validInput(input)
  const assets = input.assets.map(asset => Object.freeze({ assetId: asset.assetId, name: asset.name }))
  Object.freeze(assets)
  return Object.freeze({ draftId, revision, operationId, input: Object.freeze({ label: input.label, targetSlug: input.targetSlug, sourceMdx: input.sourceMdx, assets }) })
}
export async function listWritingDrafts(apiUrl: string, token: string, nextCursor: string | undefined, signal: AbortSignal, transport: typeof fetch = fetch): Promise<DraftPage> {
  const { value } = await request(apiUrl, token, '/drafts' + pageQuery(nextCursor), signal, transport)
  const item = value as DraftPage | null
  if (!item || !Array.isArray(item.drafts) || item.drafts.length > 25 || !cursor(item.cursor)) fail()
  return { drafts: item.drafts.map(parseDraftMetadata), cursor: item.cursor }
}
export async function getWritingDraft(apiUrl: string, token: string, ownerSub: string, draftId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<WritingDraft> {
  if (!OWNER.test(ownerSub)) throw new DraftFailure('INVALID_REQUEST')
  const result = await request(apiUrl, token, `/drafts/${id(draftId)}`, signal, transport)
  return parseWritingDraft(result.value, draftId, result.etag, ownerSub)
}
export async function createWritingDraft(apiUrl: string, token: string, input: CreateDraftInput, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<DraftOperation> {
  id(input.draftId); id(operationId)
  if ('fromPublishedSlug' in input) { if (!slug(input.fromPublishedSlug)) throw new DraftFailure('INVALID_REQUEST') }
  else validInput({ ...input, assets: [] })
  const body = 'fromPublishedSlug' in input ? { draftId: input.draftId, fromPublishedSlug: input.fromPublishedSlug } : { draftId: input.draftId, label: input.label, targetSlug: input.targetSlug, sourceMdx: input.sourceMdx }
  const { value, status } = await request(apiUrl, token, '/drafts', signal, transport, 'POST', body, { 'Idempotency-Key': operationId })
  const operation = parseDraftOperation(value, operationId)
  if (status !== 201 || operation.status !== 'committed' || operation.draftId !== input.draftId || ('fromPublishedSlug' in input ? operation.result?.targetSlug !== input.fromPublishedSlug : operation.result?.label !== input.label || operation.result?.targetSlug !== input.targetSlug)) fail()
  return operation
}
export async function saveWritingDraft(apiUrl: string, token: string, draftId: string, input: DraftInput, revision: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<DraftOperation> {
  const frozen = captureDraftSave(draftId, input, revision, operationId)
  const { value, status } = await request(apiUrl, token, `/drafts/${draftId}`, signal, transport, 'PUT', frozen.input, { 'Idempotency-Key': operationId, 'If-Match': `"${revision}"` })
  const operation = parseDraftOperation(value, operationId)
  if (status !== 200 || operation.status !== 'committed' || operation.draftId !== draftId || operation.result?.revision === revision || operation.result?.label !== frozen.input.label || operation.result?.targetSlug !== frozen.input.targetSlug) fail()
  return operation
}
export async function getWritingOperation(apiUrl: string, token: string, operationId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<DraftOperation> {
  const { value, status } = await request(apiUrl, token, `/operations/${id(operationId)}`, signal, transport)
  if (status !== 200) fail()
  return parseDraftOperation(value, operationId)
}
function parsePublishedSummary(value: unknown): PublishedSummary {
  const item = value as PublishedSummary | null
  if (!item || !slug(item.slug) || !text(item.title, 1024) || !publishedKey(item.s3Key, item.slug)) fail()
  return { slug: item.slug, title: item.title, s3Key: item.s3Key }
}
export async function listPublishedWritings(apiUrl: string, token: string, nextCursor: string | undefined, signal: AbortSignal, transport: typeof fetch = fetch): Promise<PublishedPage> {
  const { value } = await request(apiUrl, token, '/published' + pageQuery(nextCursor), signal, transport)
  const item = value as PublishedPage | null
  if (!item || !Array.isArray(item.writings) || item.writings.length > 25 || !cursor(item.cursor)) fail()
  return { writings: item.writings.map(parsePublishedSummary), cursor: item.cursor }
}
export async function getPublishedWriting(apiUrl: string, token: string, articleSlug: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<PublishedWriting> {
  if (!slug(articleSlug)) throw new DraftFailure('INVALID_REQUEST')
  const { value } = await request(apiUrl, token, `/published/${articleSlug}`, signal, transport)
  const item = value as PublishedWriting, meta = parsePublishedSummary(value)
  if (meta.slug !== articleSlug || !source(item.sourceMdx) || !Array.isArray(item.assets) || item.assets.length > MAX_ASSETS || !Array.isArray(item.unsupportedAssets) || item.unsupportedAssets.length > 100 || item.assets.some(asset => !asset || !name(asset.name) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !text(asset.contentType, 128)) || item.unsupportedAssets.some(asset => !asset || !text(asset.name, 512) || !text(asset.reason, 512))) fail()
  return { ...meta, sourceMdx: item.sourceMdx, assets: item.assets.map(asset => ({ name: asset.name, bytes: asset.bytes, contentType: asset.contentType })), unsupportedAssets: item.unsupportedAssets.map(asset => ({ name: asset.name, reason: asset.reason })) }
}
function validFile(file: File): void {
  if (!file || !name(file.name) || !IMAGE_TYPES.includes(file.type as typeof IMAGE_TYPES[number]) || file.size < 1 || file.size > MAX_ASSET_BYTES || !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new DraftFailure(file?.size > MAX_ASSET_BYTES ? 'FILE_TOO_LARGE' : 'INVALID_REQUEST')
}
function privateKey(ownerSub: string, draftId: string, assetId: string, filename: string): string {
  if (!OWNER.test(ownerSub) || !name(filename)) throw new DraftFailure('INVALID_REQUEST')
  return `drafts/${ownerSub}/${id(draftId)}/assets/${id(assetId)}/image`
}
export function validateAssetAuthorization(value: unknown, ownerSub: string, draftId: string, file: File, now = Date.now()): AssetAuthorization {
  validFile(file)
  const item = value as AssetAuthorization | null
  if (!item || !isDraftId(item.assetId) || item.upload?.url !== PRIVATE_ORIGIN + '/' || item.upload.maxBytes !== MAX_ASSET_BYTES || !iso(item.upload.expiresAt) || Date.parse(item.upload.expiresAt) <= now || Date.parse(item.upload.expiresAt) > now + 305000 || !item.upload.fields || typeof item.upload.fields !== 'object' || Array.isArray(item.upload.fields) || Object.values(item.upload.fields).some(field => typeof field !== 'string') || item.upload.fields.key !== privateKey(ownerSub, draftId, item.assetId, file.name) || item.upload.fields['Content-Type'] !== file.type || item.upload.fields.success_action_status !== '201' || item.upload.fields['x-amz-server-side-encryption'] !== 'AES256') fail()
  if ((item.upload.fields.acl && item.upload.fields.acl !== 'private') || item.upload.fields['x-amz-website-redirect-location']) fail()
  return { assetId: item.assetId, upload: { ...item.upload, fields: { ...item.upload.fields } } }
}
export async function authorizeWritingAsset(apiUrl: string, token: string, ownerSub: string, draftId: string, file: File, signal: AbortSignal, transport: typeof fetch = fetch): Promise<AssetAuthorization> {
  validFile(file)
  const { value } = await request(apiUrl, token, `/drafts/${id(draftId)}/assets/uploads`, signal, transport, 'POST', { filename: file.name, bytes: file.size, contentType: file.type })
  return validateAssetAuthorization(value, ownerSub, draftId, file)
}
export async function validateWritingAsset(apiUrl: string, token: string, ownerSub: string, draftId: string, assetId: string, versionId: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<WritingAsset> {
  if (!VERSION.test(versionId) || versionId === 'null') throw new DraftFailure('INVALID_REQUEST')
  const { value } = await request(apiUrl, token, `/drafts/${id(draftId)}/assets/${id(assetId)}/validate`, signal, transport, 'POST', { versionId })
  if (!value || typeof value !== 'object' || !('asset' in value)) fail()
  const asset = parseWritingAsset(value.asset, draftId, ownerSub)
  if (asset.assetId !== assetId || asset.versionId !== versionId) fail()
  return asset
}
export async function getWritingAssetPreview(apiUrl: string, token: string, ownerSub: string, draftId: string, asset: WritingAsset, signal: AbortSignal, transport: typeof fetch = fetch): Promise<AssetPreview> {
  const expected = parseWritingAsset(asset, draftId, ownerSub)
  const { value } = await request(apiUrl, token, `/drafts/${id(draftId)}/assets/${id(asset.assetId)}/preview`, signal, transport)
  const item = value as AssetPreview | null
  let url: URL, pathname: string
  try { url = new URL(item?.url ?? ''); pathname = decodeURIComponent(url.pathname) } catch { return fail() }
  if (!item || url.origin !== PRIVATE_ORIGIN || url.username || url.password || url.hash || pathname !== '/' + expected.key || url.searchParams.getAll('versionId').length !== 1 || url.searchParams.get('versionId') !== expected.versionId || !iso(item.expiresAt) || Date.parse(item.expiresAt) <= Date.now() || Date.parse(item.expiresAt) > Date.now() + 305000) fail()
  return { url: url.href, expiresAt: item.expiresAt }
}
export function uploadWritingAsset(ownerSub: string, draftId: string, authorization: AssetAuthorization, file: File, signal: AbortSignal, onProgress: (loaded: number, total: number) => void, createXhr: () => XMLHttpRequest = () => new XMLHttpRequest()): Promise<string> {
  const { promise, resolve, reject } = (Promise as PromiseConstructor & { withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } }).withResolvers<string>()
  try { validateAssetAuthorization(authorization, ownerSub, draftId, file) } catch (error) { reject(error); return promise }
  if (signal.aborted) { reject(new DraftFailure('TRANSFER_INTERRUPTED')); return promise }
  const xhr = createXhr()
  let settled = false
  const finish = (callback: () => void) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
    xhr.upload.onprogress = null
    callback()
  }
  const abort = () => { finish(() => reject(new DraftFailure('TRANSFER_INTERRUPTED'))); xhr.abort() }
  try {
    const form = new FormData()
    for (const [key, value] of Object.entries(authorization.upload.fields)) form.append(key, value)
    form.append('file', file)
    xhr.open('POST', authorization.upload.url)
    xhr.withCredentials = false
    xhr.timeout = Math.min(120000, Date.parse(authorization.upload.expiresAt) - Date.now())
    if (xhr.timeout <= 0) { finish(() => reject(new DraftFailure('TRANSFER_INTERRUPTED'))); return promise }
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : file.size)
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => finish(() => reject(new DraftFailure('TRANSFER_INTERRUPTED')))
    xhr.onload = () => finish(() => {
      if (xhr.status !== 201) { reject(new DraftFailure('TRANSFER_REJECTED')); return }
      const versionId = xhr.getResponseHeader('x-amz-version-id')
      if (!versionId || versionId === 'null' || !VERSION.test(versionId)) { reject(new DraftFailure('UNAVAILABLE')); return }
      resolve(versionId)
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort(); else xhr.send(form)
  } catch { finish(() => reject(new DraftFailure('TRANSFER_INTERRUPTED'))) }
  return promise
}
export async function previewWritingDraft(apiUrl: string, token: string, draftId: string, revision: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<DraftPreview> {
  const { value } = await request(apiUrl, token, `/drafts/${id(draftId)}/preview`, signal, transport, 'POST', {}, { 'If-Match': `"${id(revision)}"` })
  const item = value as DraftPreview | null
  if (!item || item.draftId !== draftId || item.revision !== revision || !(item.html === null || text(item.html, 600 * 1024, true)) || !Array.isArray(item.fieldErrors) || item.fieldErrors.length > 100 || !iso(item.expiresAt) || Date.parse(item.expiresAt) <= Date.now() || Date.parse(item.expiresAt) > Date.now() + 305000 || item.fieldErrors.some(error => !error || !text(error.field, 128) || !text(error.code, 128) || !text(error.message, 1024) || (error.line !== undefined && (!Number.isSafeInteger(error.line) || error.line < 1)) || (error.column !== undefined && (!Number.isSafeInteger(error.column) || error.column < 1)))) fail()
  return { draftId, revision, html: item.html, fieldErrors: item.fieldErrors.map(error => ({ field: error.field, code: error.code, message: error.message, ...(error.line ? { line: error.line } : {}), ...(error.column ? { column: error.column } : {}) })), expiresAt: item.expiresAt }
}

export interface WritingCheckpoint { operationId: string; draftId: string }
export function writingCheckpointKey(scope: string, ownerSub: string): string {
  if (!scope || !OWNER.test(ownerSub)) throw new DraftFailure('INVALID_REQUEST')
  return `janeway.writing-operation.${encodeURIComponent(scope)}.${ownerSub}`
}
export function readWritingCheckpoint(storage: Pick<Storage, 'getItem'>, scope: string, ownerSub: string): WritingCheckpoint | null {
  try {
    const item = JSON.parse(storage.getItem(writingCheckpointKey(scope, ownerSub)) ?? 'null')
    if (!item || !isDraftId(item.operationId) || !isDraftId(item.draftId) || Object.keys(item).some(key => !['operationId', 'draftId'].includes(key))) return null
    return { operationId: item.operationId, draftId: item.draftId }
  } catch { return null }
}
export function saveWritingCheckpoint(storage: Pick<Storage, 'setItem' | 'getItem'>, scope: string, ownerSub: string, checkpoint: WritingCheckpoint): void {
  id(checkpoint.operationId); id(checkpoint.draftId)
  const key = writingCheckpointKey(scope, ownerSub), body = JSON.stringify({ operationId: checkpoint.operationId, draftId: checkpoint.draftId })
  try {
    storage.setItem(key, body)
    if (storage.getItem(key) !== body) throw new DraftFailure('UNAVAILABLE')
  } catch { throw new DraftFailure('UNAVAILABLE') }
}
export function clearWritingCheckpoint(storage: Pick<Storage, 'removeItem'>, scope: string, ownerSub: string): void { storage.removeItem(writingCheckpointKey(scope, ownerSub)) }
export function privatePreviewDocument(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src ${PRIVATE_ORIGIN}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer">${html}`
}

export function draftInput(draft: WritingDraft): DraftInput {
  return { label: draft.label, targetSlug: draft.targetSlug, sourceMdx: draft.sourceMdx, assets: draft.assets.map(asset => ({ assetId: asset.assetId, name: asset.name })) }
}
export function sameDraftInput(a: Readonly<DraftInput>, b: Readonly<DraftInput>): boolean {
  return a.label === b.label && a.targetSlug === b.targetSlug && a.sourceMdx === b.sourceMdx && a.assets.length === b.assets.length && a.assets.every((asset, index) => asset.assetId === b.assets[index].assetId && asset.name === b.assets[index].name)
}
export type EditorPhase = 'empty' | 'loading' | 'ready' | 'saving' | 'uncertain' | 'conflict' | 'failed' | 'recovery'
export interface EditorSnapshot {
  draftId: string | null; ownerSub: string | null; phase: EditorPhase; working: DraftInput | null; saved: WritingDraft | null
  revision: string | null; pending: FrozenSave | null; dirty: boolean; recovery: boolean; error: DraftFailureCode | null; outcome: DraftOperation | null
  availableAssets: WritingAsset[]
  targetSlugLocked: boolean
}
const EMPTY_EDITOR: EditorSnapshot = { draftId: null, ownerSub: null, phase: 'empty', working: null, saved: null, revision: null, pending: null, dirty: false, recovery: false, error: null, outcome: null, availableAssets: [], targetSlugLocked: false }
export class WritingEditorController {
  private state: EditorSnapshot = EMPTY_EDITOR
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private request: AbortController | null = null
  private activeSave: Promise<void> | null = null
  private activeOutcome: Promise<void> | null = null
  private activeReview: Promise<WritingDraft | null> | null = null
  private checkpoint: ((value: WritingCheckpoint | null) => void) | null = null
  configureCheckpoint(callback: (value: WritingCheckpoint | null) => void): void { this.checkpoint = callback }
  private baseline: Readonly<DraftInput> | null = null
  getSnapshot = (): EditorSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(update: Partial<EditorSnapshot>): void { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener() }
  hasProtectedWork = (): boolean => this.state.dirty || !!this.state.pending
  async open(client: WritingSession, draftId: string, ownerSub: string): Promise<void> {
    id(draftId)
    if (this.state.draftId === draftId && this.state.ownerSub === ownerSub && this.state.working && this.state.saved && !this.state.recovery) return
    if (this.hasProtectedWork() && (this.state.draftId !== draftId || this.state.ownerSub !== ownerSub)) throw new DraftFailure('INVALID_REQUEST')
    const generation = ++this.generation
    this.request?.abort()
    const controller = new AbortController(); this.request = controller
    this.publish({ draftId, ownerSub, phase: 'loading', error: null })
    try {
      const draft = await client.getWritingDraft(draftId, controller.signal)
      if (generation !== this.generation) return
      if (this.state.recovery && this.state.working) {
        this.publish({ saved: draft, availableAssets: draft.assets, targetSlugLocked: !!draft.basePublished, phase: this.state.pending ? 'uncertain' : 'conflict' })
      } else {
        this.baseline = draftInput(draft)
        this.publish({ working: draftInput(draft), saved: draft, availableAssets: draft.assets, targetSlugLocked: !!draft.basePublished, revision: draft.revision, dirty: false, phase: 'ready', recovery: false, outcome: null, pending: null })
      }
    } catch (error) {
      if (generation === this.generation) this.publish({ phase: this.state.recovery ? 'recovery' : 'failed', error: error instanceof DraftFailure ? error.code : 'UNAVAILABLE' })
    } finally { if (this.request === controller) this.request = null }
  }
  change(update: Partial<DraftInput>): void {
    if (!this.state.working) return
    if (update.targetSlug !== undefined && this.state.targetSlugLocked && update.targetSlug !== (this.state.saved?.basePublished?.slug ?? this.state.working.targetSlug)) throw new DraftFailure('INVALID_REQUEST')
    const working = { ...this.state.working, ...update, assets: (update.assets ?? this.state.working.assets).map(asset => ({ assetId: asset.assetId, name: asset.name })) }
    this.publish({ working, dirty: !this.baseline || !sameDraftInput(working, this.baseline) })
  }
  changeSourceFromTextarea(value: string): void {
    if (!this.state.working) return
    this.change({ sourceMdx: applySourceEditorChange(this.state.working.sourceMdx, value) })
  }
  save(client: WritingSession, operationId: string): Promise<void> {
    if (this.activeSave) return this.activeSave
    if (this.activeReview || this.activeOutcome || !this.state.working || !this.state.draftId || !this.state.revision || this.state.pending || this.state.recovery || this.state.phase === 'conflict' || !this.state.dirty) return Promise.resolve()
    const frozen = captureDraftSave(this.state.draftId, this.state.working, this.state.revision, operationId)
    try { this.checkpoint?.({ draftId: frozen.draftId, operationId: frozen.operationId }) }
    catch { this.publish({ phase: 'failed', error: 'UNAVAILABLE' }); return Promise.resolve() }
    const generation = this.generation, controller = new AbortController()
    this.request = controller
    this.publish({ phase: 'saving', pending: frozen, error: null, outcome: null })
    const run = async () => {
      try {
        const operation = await client.saveWritingDraft(frozen.draftId, frozen.input as DraftInput, frozen.revision, frozen.operationId, controller.signal)
        if (generation === this.generation) this.applyOutcome(operation, frozen)
      } catch (error) {
        if (generation !== this.generation) return
        const code = error instanceof DraftFailure ? error.code : 'UNAVAILABLE'
        const terminal = ['INVALID_REQUEST', 'OPERATION_REUSED', 'INVALID_IMAGE', 'ASSET_NOT_FOUND'].includes(code)
        if (terminal) { try { this.checkpoint?.(null) } catch { /* Request rejection is still known even if local cleanup fails. */ } }
        this.publish({ phase: code === 'REVISION_CONFLICT' ? 'conflict' : terminal ? 'failed' : 'uncertain', error: code, ...(terminal ? { pending: null } : {}) })
      } finally { if (this.request === controller) this.request = null }
    }
    this.activeSave = run().finally(() => { this.activeSave = null })
    return this.activeSave
  }
  private applyOutcome(operation: DraftOperation, frozen: FrozenSave): void {
    if (this.state.pending?.operationId !== frozen.operationId) return
    if (operation.operationId !== frozen.operationId || (operation.draftId !== frozen.draftId && !(operation.status === 'unknown' && operation.draftId === null))) { this.publish({ phase: 'uncertain', error: 'UNAVAILABLE' }); return }
    if (operation.result && (operation.result.label !== frozen.input.label || operation.result.targetSlug !== frozen.input.targetSlug || operation.result.revision === frozen.revision)) { this.publish({ phase: 'uncertain', error: 'UNAVAILABLE' }); return }
    if (['committed', 'superseded', 'failed', 'conflict'].includes(operation.status)) {
      try { this.checkpoint?.(null) } catch { /* The durable outcome remains authoritative even if cleanup fails. */ }
    }
    if (operation.status === 'committed' && operation.result) {
      this.baseline = frozen.input
      const resolvedAssets = frozen.input.assets.map(ref => this.state.availableAssets.find(asset => asset.assetId === ref.assetId)).filter((asset): asset is WritingAsset => !!asset)
      const saved: WritingDraft | null = resolvedAssets.length === frozen.input.assets.length ? { ...operation.result, schemaVersion: 1, sourceMdx: frozen.input.sourceMdx, assets: resolvedAssets } : null
      this.publish({ saved, revision: operation.result.revision, targetSlugLocked: !!operation.result.basePublished, pending: null, outcome: operation, phase: 'ready', recovery: false, dirty: !this.state.working || !sameDraftInput(this.state.working, frozen.input), error: null })
    } else if (operation.status === 'superseded' || operation.status === 'conflict') {
      this.publish({ phase: 'conflict', pending: null, outcome: operation, error: 'REVISION_CONFLICT' })
    } else if (operation.status === 'failed') this.publish({ phase: 'failed', pending: null, outcome: operation, error: 'INVALID_REQUEST' })
    else this.publish({ phase: 'uncertain', outcome: operation, error: null })
  }
  reconcile(client: WritingSession): Promise<void> {
    if (this.activeOutcome) return this.activeOutcome
    const frozen = this.state.pending
    if (!frozen || this.activeSave || this.activeReview) return Promise.resolve()
    const generation = this.generation, controller = new AbortController()
    this.request = controller
    const run = async () => {
      try {
        const operation = await client.getWritingOperation(frozen.operationId, controller.signal)
        if (generation === this.generation) this.applyOutcome(operation, frozen)
      } catch (error) {
        if (generation === this.generation && this.state.pending?.operationId === frozen.operationId) this.publish({ phase: 'uncertain', error: error instanceof DraftFailure ? error.code : 'UNAVAILABLE' })
      } finally { if (this.request === controller) this.request = null }
    }
    this.activeOutcome = run().finally(() => { this.activeOutcome = null })
    return this.activeOutcome
  }
  reviewCurrent(client: WritingSession): Promise<WritingDraft | null> {
    if (this.activeReview) return this.activeReview
    if (!this.state.draftId || this.activeSave || this.activeOutcome) return Promise.resolve(null)
    const generation = this.generation, controller = new AbortController(), draftId = this.state.draftId
    this.request?.abort(); this.request = controller
    const run = async () => {
      try {
        const saved = await client.getWritingDraft(draftId, controller.signal)
        if (generation !== this.generation) return null
        this.publish({ saved, targetSlugLocked: !!saved.basePublished, availableAssets: [...this.state.availableAssets.filter(asset => !saved.assets.some(ref => ref.assetId === asset.assetId)), ...saved.assets], error: null, ...(saved.revision !== this.state.revision ? { phase: 'conflict' as const } : {}) })
        return saved
      } catch (error) {
        if (generation === this.generation) this.publish({ error: error instanceof DraftFailure ? error.code : 'UNAVAILABLE' })
        return null
      } finally { if (this.request === controller) this.request = null }
    }
    this.activeReview = run().finally(() => { this.activeReview = null })
    return this.activeReview
  }
  adoptReviewedRevision(): void {
    if (!this.state.saved || !this.state.working || this.state.pending || this.activeSave || this.activeReview || this.activeOutcome) return
    if (this.state.saved.basePublished && this.state.working.targetSlug !== this.state.saved.basePublished.slug) throw new DraftFailure('INVALID_REQUEST')
    this.baseline = draftInput(this.state.saved)
    this.publish({ revision: this.state.saved.revision, recovery: false, phase: 'ready', error: null, dirty: !sameDraftInput(this.state.working, draftInput(this.state.saved)), outcome: null })
  }
  advancePublicationBaseline(freshDraft: WritingDraft, reviewedRevision: string | null, ownerSub: string): boolean {
    if (!reviewedRevision || ownerSub !== this.state.ownerSub || freshDraft.draftId !== this.state.draftId || this.state.revision !== reviewedRevision || !this.state.saved || !this.state.working || this.state.pending || this.state.recovery || this.state.phase !== 'ready' || this.activeSave || this.activeReview || this.activeOutcome) return false
    const original = draftInput(this.state.saved), fresh = draftInput(freshDraft)
    if (original.sourceMdx !== fresh.sourceMdx || original.label !== fresh.label || original.targetSlug !== fresh.targetSlug || original.assets.length !== fresh.assets.length || original.assets.some((ref, index) => ref.assetId !== fresh.assets[index].assetId || ref.name !== fresh.assets[index].name)) return false
    this.baseline = fresh
    this.publish({ saved: freshDraft, revision: freshDraft.revision, targetSlugLocked: !!freshDraft.basePublished, availableAssets: [...this.state.availableAssets.filter(asset => !freshDraft.assets.some(ref => ref.assetId === asset.assetId)), ...freshDraft.assets], dirty: !sameDraftInput(this.state.working, fresh), outcome: null, error: null })
    return true
  }
  discard(): void {
    this.generation++; this.request?.abort(); this.request = null
    this.baseline = null
    this.publish({ ...EMPTY_EDITOR })
  }
  discardToSaved(): void {
    if (!this.state.saved || this.state.pending) return
    this.baseline = draftInput(this.state.saved)
    this.publish({ working: draftInput(this.state.saved), revision: this.state.saved.revision, dirty: false, phase: 'ready', recovery: false, error: null, outcome: null })
  }
  rememberAsset(asset: WritingAsset): void {
    if (!this.state.availableAssets.some(item => item.assetId === asset.assetId)) this.publish({ availableAssets: [...this.state.availableAssets, asset] })
  }
  suspend(): void {
    this.generation++; this.request?.abort(); this.request = null
    this.baseline = null
    if (!this.hasProtectedWork()) { this.publish({ ...EMPTY_EDITOR }); return }
    this.publish({ saved: null, availableAssets: [], outcome: null, recovery: true, phase: this.state.pending ? 'uncertain' : 'recovery', error: null })
  }
}

// Textarea values normalize CRLF and lone CR to LF. Map only the edited span
// back to the original source so unrelated frontmatter/body bytes stay exact.
export function applySourceEditorChange(previous: string, textareaValue: string): string {
  const normalized = previous.replace(/\r\n?/g, '\n'), next = textareaValue.replace(/\r\n?/g, '\n')
  if (normalized === next) return previous
  let start = 0, beforeEnd = normalized.length, afterEnd = next.length
  while (start < beforeEnd && start < afterEnd && normalized[start] === next[start]) start++
  while (beforeEnd > start && afterEnd > start && normalized[beforeEnd - 1] === next[afterEnd - 1]) { beforeEnd--; afterEnd-- }
  let rawStart = previous.length, rawEnd = previous.length, position = 0
  for (let raw = 0; raw <= previous.length; raw++) {
    if (position === start) rawStart = raw
    if (position === beforeEnd) { rawEnd = raw; break }
    if (previous[raw] === '\r' && previous[raw + 1] === '\n') raw++
    position++
  }
  let nearest = Math.max(previous.lastIndexOf('\n', rawStart - 1), previous.lastIndexOf('\r', rawStart - 1))
  if (nearest < 0) {
    const lf = previous.indexOf('\n', rawStart), cr = previous.indexOf('\r', rawStart)
    nearest = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
  }
  const ending = nearest < 0 ? '\n' : previous[nearest] === '\r' ? previous[nearest + 1] === '\n' ? '\r\n' : '\r' : previous[nearest - 1] === '\r' ? '\r\n' : '\n'
  const replacement = next.slice(start, afterEnd).replace(/\n/g, ending)
  return previous.slice(0, rawStart) + replacement + previous.slice(rawEnd)
}

export const FRONTMATTER_FIELDS = ['title', 'description', 'author', 'date', 'status', 'coverImage'] as const
export type FrontmatterField = typeof FRONTMATTER_FIELDS[number]
interface ScalarSpan { start: number; end: number; value: string }
// Only unambiguous, top-level inline string scalars get convenience controls.
// Complex YAML stays canonical in the source editor; it is never reserialized.
function scalarSpan(sourceMdx: string, field: FrontmatterField): ScalarSpan | null {
  if (!FRONTMATTER_FIELDS.includes(field)) return null
  const opening = /^(?:\uFEFF)?---(?:\r\n|\n)/.exec(sourceMdx)
  if (!opening) return null
  const closing = /^---[ \t]*(?:\r?\n|$)/gm
  closing.lastIndex = opening[0].length
  const end = closing.exec(sourceMdx)
  if (!end) return null
  const matcher = new RegExp(`^${field}([ \\t]*:[ \\t]*)([^\\r\\n]*)`, 'gm')
  matcher.lastIndex = opening[0].length
  const match = matcher.exec(sourceMdx)
  if (!match || match.index >= end.index) return null
  const duplicate = matcher.exec(sourceMdx)
  if (duplicate && duplicate.index < end.index) return null
  const raw = match[2], offset = match.index + field.length + match[1].length
  let value = '', length = 0
  if (raw.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(raw)
    if (!quoted) return null
    try { value = JSON.parse(quoted[0]); length = quoted[0].length } catch { return null }
  } else if (raw.startsWith("'")) {
    const quoted = /^'(?:[^']|'')*'/.exec(raw)
    if (!quoted) return null
    value = quoted[0].slice(1, -1).replace(/''/g, "'"); length = quoted[0].length
  } else {
    const scalar = raw.split(/[ \t]+#/)[0].trimEnd()
    if (!scalar || /^[|>&*!\[{]/.test(scalar) || /^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(scalar) || /:\s/.test(scalar)) return null
    value = scalar; length = scalar.length
  }
  if (!/^[ \t]*(?:#.*)?$/.test(raw.slice(length))) return null
  const nextLine = sourceMdx.slice(offset + raw.length, end.index).split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#'))
  if (nextLine && /^[ \t]+\S/.test(nextLine)) return null
  return { start: offset, end: offset + length, value }
}
export function readFrontmatterScalar(sourceMdx: string, field: FrontmatterField): string | null { return scalarSpan(sourceMdx, field)?.value ?? null }
export function changeFrontmatterScalar(sourceMdx: string, field: FrontmatterField, value: string): string {
  const span = scalarSpan(sourceMdx, field)
  if (!span || typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new DraftFailure('INVALID_REQUEST')
  if (span.value === value) return sourceMdx
  return sourceMdx.slice(0, span.start) + JSON.stringify(value) + sourceMdx.slice(span.end)
}
export function recoveryExport(input: DraftInput): string { return input.sourceMdx }
export function editorNavigationAllowed(protectedWork: boolean, confirmDiscard: () => boolean): boolean { return !protectedWork || confirmDiscard() }
