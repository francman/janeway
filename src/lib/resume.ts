import { Readable } from 'node:stream'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
const POINTER_LIMIT = 4096
const POINTER_FIELDS = [
  'schemaVersion',
  'publicationId',
  'key',
  'sha256',
  'bytes',
  'publishedAt',
]

function getCdnOrigin(): string | null {
  const value = process.env.ARTICLES_IMAGE_CDN_URL
  if (!value || value.trim() !== value || !/^https:\/\/[^/?#\\\s@]+\/?$/i.test(value)) return null
  const url = new URL(value)
  if (url.username || url.password) return null
  return url.origin
}

function isUtcTimestamp(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  return date.toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value)
}

function getRevisionKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const pointer = value as Record<string, unknown>
  if (
    Object.keys(pointer).length !== POINTER_FIELDS.length ||
    !POINTER_FIELDS.every((field) => Object.hasOwn(pointer, field)) ||
    pointer.schemaVersion !== 1 ||
    typeof pointer.publicationId !== 'string' ||
    pointer.publicationId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pointer.publicationId) ||
    typeof pointer.sha256 !== 'string' ||
    pointer.sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(pointer.sha256) ||
    typeof pointer.bytes !== 'number' ||
    !Number.isSafeInteger(pointer.bytes) ||
    pointer.bytes <= 0 ||
    !isUtcTimestamp(pointer.publishedAt)
  ) {
    return null
  }
  const key = `documents/resume/revisions/${pointer.sha256}/inline/frank-manu-resume.pdf`
  return pointer.key === key ? key : null
}

export async function getResumeUrl(): Promise<string | null> {
  try {
    const bucket = process.env.ARTICLES_BUCKET
    const origin = getCdnOrigin()
    if (!bucket || !origin) return null

    // Read one extra byte so an oversized pointer cannot masquerade as valid JSON.
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: 'documents/resume/current.json',
      Range: `bytes=0-${POINTER_LIMIT}`,
    }))
    const body = response.Body
    if (!(body instanceof Readable)) return null

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let bytes = 0
    let text = ''
    // The stream bound also protects against a server ignoring the Range header.
    for await (const chunk of body) {
      bytes += chunk.length
      if (bytes > POINTER_LIMIT) return null
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    const key = getRevisionKey(JSON.parse(text))
    return key ? `${origin}/${key}` : null
  } catch {
    return null
  }
}
