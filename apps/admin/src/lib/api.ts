export interface OwnerSession {
  owner: { sub: string }
  authenticatedAt: number
  expiresAt: number
  device: { key: string; createdAt: string }
}

export interface ResumeMetadata {
  schemaVersion: 1
  publicationId: string
  key: string
  sha256: string
  bytes: number
  publishedAt: string
  publicUrl: 'https://www.frankmanu.com/resume.pdf'
  etag: string
}

export type DeviceErrorCode = 'DEVICE_NOT_FOUND' | 'DEVICE_REVOKED'
export class ApiError extends Error {
  constructor(readonly kind: 'expired' | 'denied' | 'unavailable', readonly requestId?: string, readonly code?: DeviceErrorCode) {
    super(kind)
  }
}

// The method and path are fixed by resource; no caller-selected device or owner.
export async function ownerRequest(
  apiUrl: string,
  resource: 'session' | 'resume' | 'device',
  accessToken: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<{ value: unknown; etag: string | null }> {
  let response: Response
  try {
    response = await transport(`${apiUrl}/v1/${resource}`, {
      method: resource === 'device' ? 'DELETE' : 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
    })
  } catch { throw new ApiError('unavailable') }

  if (!response.ok) {
    let requestId: string | undefined
    let code: DeviceErrorCode | undefined
    try {
      const body = await response.json()
      if (typeof body?.error?.requestId === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(body.error.requestId)) requestId = body.error.requestId
      if (response.status === 403 && ['DEVICE_NOT_FOUND', 'DEVICE_REVOKED'].includes(body?.error?.code)) code = body.error.code
    } catch { /* Only a bounded request ID, never raw backend messages, reaches UI. */ }
    throw new ApiError(response.status === 401 ? 'expired' : response.status === 403 ? 'denied' : 'unavailable', requestId, code)
  }
  if (!response.headers.get('cache-control')?.split(',').some(value => value.trim().toLowerCase() === 'no-store')) {
    throw new ApiError('unavailable')
  }
  if (resource === 'device') {
    if (response.status !== 204) throw new ApiError('unavailable')
    return { value: null, etag: null }
  }
  try {
    return { value: await response.json(), etag: response.headers.get('etag') }
  } catch { throw new ApiError('unavailable') }
}

export function parseSession(value: unknown, sub: string, now: number, deviceKey: string): OwnerSession {
  const session = value as OwnerSession | null
  const deviceCreatedAt = typeof session?.device?.createdAt === 'string' ? Date.parse(session.device.createdAt) : NaN
  if (
    !session || session.owner?.sub !== sub ||
    !Number.isSafeInteger(session.authenticatedAt) || session.authenticatedAt <= 0 || session.authenticatedAt > now + 60 ||
    !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now ||
    session.device?.key !== deviceKey || !Number.isFinite(deviceCreatedAt) ||
    deviceCreatedAt <= 0 || deviceCreatedAt > (now + 60) * 1000 ||
    new Date(deviceCreatedAt).toISOString() !== session.device.createdAt
  ) throw new ApiError('unavailable')
  return { owner: { sub }, authenticatedAt: session.authenticatedAt, expiresAt: session.expiresAt, device: { key: deviceKey, createdAt: session.device.createdAt } }
}

export function parseResume(value: unknown, etag: string | null): ResumeMetadata {
  const item = value as ResumeMetadata | null
  if (
    !item || item.schemaVersion !== 1 ||
    typeof item.publicationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.publicationId) ||
    typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
    item.key !== `documents/resume/revisions/${item.sha256}/inline/frank-manu-resume.pdf` ||
    !Number.isSafeInteger(item.bytes) || item.bytes <= 0 ||
    typeof item.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item.publishedAt) ||
    !Number.isFinite(Date.parse(item.publishedAt)) ||
    item.publicUrl !== 'https://www.frankmanu.com/resume.pdf' ||
    !etag || !/^"[^"\r\n]+"$/.test(etag)
  ) throw new ApiError('unavailable')
  const expected = item.publishedAt.length === 20 ? item.publishedAt.replace('Z', '.000Z') : item.publishedAt
  if (new Date(item.publishedAt).toISOString() !== expected) throw new ApiError('unavailable')
  return {
    schemaVersion: 1, publicationId: item.publicationId, key: item.key,
    sha256: item.sha256, bytes: item.bytes, publishedAt: item.publishedAt,
    publicUrl: item.publicUrl, etag,
  }
}
