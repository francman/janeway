import { revalidateTag } from 'next/cache'
import { NextResponse, type NextRequest } from 'next/server'

import { getRevalidateSecret } from '@/lib/revalidate-secret'

function extractBearer(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  return null
}

export async function POST(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get('slug')
  const provided =
    extractBearer(request) ??
    // Backwards-compat: legacy `?secret=` query param. Deprecated; remove
    // once no callers depend on it.
    request.nextUrl.searchParams.get('secret')

  const expected = await getRevalidateSecret()
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  revalidateTag('articles:list')
  if (slug) revalidateTag(`article:${slug}`)

  return NextResponse.json({ ok: true, slug: slug ?? null })
}
